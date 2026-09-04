// Fills in the actual application form once you've navigated to it, on
// whichever organization's Teletalk portal you're applying to.
//
// You handle the site-specific pre-steps yourself (picking the circular,
// choosing the post, answering "Premium Member?") -- those vary by
// organization and aren't worth scripting. This tool just watches for the
// real Application Form to appear (it looks for the "Applicant's Name"
// field, #name, which is confirmed present on the real form) and fills it
// in the moment it shows up.
//
// If GEMINI_API_KEY is set, it also reads the CAPTCHA image with Gemini's
// vision API and fills that field in too -- always double-check it against
// the image before submitting. Submit is still always yours to click.
//
// Usage:
//   node scripts/autofill.mjs [--url <a-starting-url>]
//   GEMINI_API_KEY=... node scripts/autofill.mjs --url <a-starting-url>
//
// Requires config/profile.json (copy config/profile.example.json and fill
// in your real details -- profile.json is gitignored, never commit it).

import "dotenv/config";
import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { callAIWithCascade } from "./lib/aiService.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_PATH = path.join(__dirname, "..", "config", "profile.json");
const PATTERNS_PATH = path.join(__dirname, "..", "data", "field-patterns.json");

const args = process.argv.slice(2);
function getArg(name) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i].replace(/^["']|["']$/g, "");
    if (a === `--${name}`) {
      const next = args[i + 1];
      return next ? next.replace(/^["']|["']$/g, "") : null;
    }
    if (a.startsWith(`--${name}=`)) {
      return a.slice(`--${name}=`.length).replace(/^["']|["']$/g, "");
    }
  }
  return null;
}
const startUrl = getArg("url");
const postTitle = getArg("post");
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";

// ── Multi-provider AI cascade (Gemini → Groq → Cloudflare → OpenRouter) ──
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID || "";
const CF_API_TOKEN = process.env.CF_API_TOKEN || "";

const hasAnyAI = Boolean(
  (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim()) ||
  (process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_API_KEY.trim()) ||
  (process.env.GROQ_API_KEY && process.env.GROQ_API_KEY.trim()) ||
  (process.env.CF_ACCOUNT_ID && process.env.CF_API_TOKEN)
);

async function loadProfile() {
  try {
    const raw = await fs.readFile(PROFILE_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    console.error(
      "Couldn't find config/profile.json. Copy config/profile.example.json to " +
      "config/profile.json and fill in your real details first."
    );
    process.exit(1);
  }
}

async function main() {
  const profile = await loadProfile();

  // Use Playwright's own bundled Chromium — it ALWAYS opens a fresh,
  // independent window (never hidden behind your existing Chrome windows).
  console.log("🚀 Launching Playwright Chromium browser window...");
  const browser = await chromium.launch({
    headless: false,
    args: [
      "--start-maximized",
      "--no-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--new-window",
    ],
  });

  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();

  if (startUrl) {
    console.log(`🌐 Navigating to: ${startUrl}`);
    await page.goto(startUrl).catch((e) => {
      console.log(`Page load note: ${e.message}`);
    });
  }

  // Force the window to the foreground on Windows
  try { await page.bringToFront(); } catch (_) { }

  // --- AI-driven portal navigation ---
  let formPage = null;
  if (postTitle) {
    console.log(`\n🚀 Starting smart navigation for "${postTitle}"...`);
    formPage = await smartNavigate(page, context, postTitle);
  }

  context.on("page", (newPage) => {
    console.log(`(New tab opened -- listening on it too)`);
    newPage.bringToFront().catch(() => { });
  });

  console.log("\n=======================================================");
  console.log("👀 CHROMIUM BROWSER WINDOW IS ACTIVE");
  console.log("=======================================================\n");

  if (!formPage) {
    console.log("\n👉 Waiting for application form (#name) in browser...");
    formPage = await waitForApplicationForm(context);
  }

  console.log("\n🎯 Application Form detected! Filling in all details now...");
  await fillMainForm(formPage, profile);
  console.log("✅ Known fields filled!");

  // --- Ensure optional sections (Masters, Job Exp) stay unchecked unless in profile ---
  await handleOptionalSections(formPage, profile);

  // --- Auto-fill Computer Skills & other qualification questions ---
  await fillOtherQualifications(formPage, profile);

  // --- CAPTCHA ---
  if (hasAnyAI) {
    console.log("🤖 Reading and solving CAPTCHA with AI Vision cascade...");
    await solveCaptchaRobust(formPage);
  }

  // --- Tick ONLY the declaration checkbox at the bottom ---
  await tickDeclarationCheckbox(formPage);

  // --- Auto-submit the form ---
  const submitted = await findAndClickSubmit(formPage);
  if (!submitted) {
    console.log("\n-------------------------------------------------------");
    console.log("✨ Form filled! CAPTCHA read, Declaration ticked.");
    console.log("  \u2192 Review in the browser, then click Submit.");
    console.log("  \u2192 Type 'r' in terminal to re-read CAPTCHA if needed.");
    console.log("-------------------------------------------------------\n");
  }

  // --- Post-submit agent: handles every page AFTER submission ---
  postSubmitAgent(browser, context, formPage, profile);

  await keepAlive(browser, formPage);
}

// ── ROBUST SUBMIT BUTTON DETECTION ───────────────────────────────────────────
// Teletalk forms sometimes finish rendering/enabling the submit button a beat
// after the CAPTCHA field settles (e.g. a JS validator toggles `disabled` off,
// or the button only appears after the last onchange fires). A single,
// immediate `count()` check can miss it -- so this polls for up to ~8s,
// tries a wider set of selectors (including image/anchor-style submit
// buttons), strips any `disabled` attribute defensively, and retries the
// click a couple of times before giving up.
// STRICT selectors only -- things that are unambiguously "the submit
// control" (type=submit, explicit submit ids/values). No generic class
// selectors here (e.g. "button.btn-primary") because other buttons on the
// page -- notably Teletalk's blue "ADD MORE" button on repeatable sections
// like Job Experience -- share the exact same classes and WILL get clicked
// instead if we're not careful.
const STRICT_SUBMIT_SEL = [
  "input[type=submit]",
  "button[type=submit]",
  "#submit",
  "#btnSubmit",
  "#submit_btn",
  "input[value*='Submit' i]",
  "input[value*='Next' i]",
].join(", ");

// Looser fallback, only used if nothing strict is found. Still excludes
// obvious non-submit controls by text (see isAddOrRemoveControl below).
const FALLBACK_SUBMIT_SEL = [
  "button:has-text('Submit')",
  "a:has-text('Submit')",
  "a:has-text('Next')",
  "input[type=image]",
].join(", ");

async function isAddOrRemoveControl(locator) {
  const text = await locator.evaluate(el =>
    (el.innerText || el.value || el.getAttribute("aria-label") || el.title || "").trim()
  ).catch(() => "");
  return /add\s*more|delete|remove|trash|clone|duplicate/i.test(text);
}

// Safety net: right before clicking Submit, double-check the CAPTCHA field
// still holds the value we solved (a stray blur/reset/re-render between
// solving it and submitting could clear it). If it's missing, re-type it
// with real keyboard events and blur again before proceeding.
async function verifyCaptchaBeforeSubmit(formPage) {
  if (!lastSolvedCaptcha || !lastCaptchaInputSelector) return;
  try {
    const el = formPage.locator(lastCaptchaInputSelector).first();
    if (!(await el.count().catch(() => 0))) return;
    const current = await el.inputValue().catch(() => "");
    if (current && current.trim() === lastSolvedCaptcha) return; // still fine

    console.log(`[CAPTCHA] ⚠️ Field value ("${current}") doesn't match solved CAPTCHA ("${lastSolvedCaptcha}") -- re-typing before submit...`);
    await el.scrollIntoViewIfNeeded().catch(() => { });
    await el.click({ force: true }).catch(() => { });
    await el.evaluate(e => { e.value = ""; }).catch(() => { });
    await formPage.keyboard.type(lastSolvedCaptcha, { delay: 80 });
    await formPage.keyboard.press("Tab").catch(() => { });
    await formPage.waitForTimeout(200).catch(() => { });
  } catch (e) {
    console.log(`[CAPTCHA] Re-check failed: ${e.message}`);
  }
}

async function findAndClickSubmit(formPage, { timeoutMs = 8000, maxClicks = 3 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let submitBtn = null;

  // Poll until a visible, genuinely-submit-looking element shows up.
  while (Date.now() < deadline) {
    let candidate = formPage.locator(STRICT_SUBMIT_SEL).first();
    let count = await candidate.count().catch(() => 0);
    if (!count) {
      candidate = formPage.locator(FALLBACK_SUBMIT_SEL).first();
      count = await candidate.count().catch(() => 0);
    }
    if (count > 0 && (await candidate.isVisible().catch(() => false))) {
      if (await isAddOrRemoveControl(candidate)) {
        // Wrong element matched (e.g. "ADD MORE") -- keep polling instead
        // of clicking it.
        await formPage.waitForTimeout(400).catch(() => { });
        continue;
      }
      submitBtn = candidate;
      break;
    }
    await formPage.waitForTimeout(400).catch(() => { });
  }

  if (!submitBtn) return false;

  await submitBtn.scrollIntoViewIfNeeded().catch(() => { });
  // Defensively clear any `disabled` attribute a client-side validator may
  // still be holding, so the click actually registers.
  await submitBtn.evaluate(el => { el.disabled = false; el.removeAttribute?.("disabled"); }).catch(() => { });

  console.log("🟢 Submitting form...");
  // Wait a brief moment so Teletalk's CAPTCHA validator has settled
  await formPage.waitForTimeout(600);

  const startUrlBeforeClick = formPage.url();
  // Grab a stable handle to THIS exact element so retries re-check it
  // specifically, rather than re-querying a selector that might now match
  // a completely different button after the DOM shifts.
  const handle = await submitBtn.elementHandle().catch(() => null);

  for (let i = 0; i < maxClicks; i++) {
    // Re-verify the CAPTCHA is still correctly filled and blurred right
    // before every submit attempt -- this is what stops focus from
    // jumping back into the CAPTCHA box on click.
    await verifyCaptchaBeforeSubmit(formPage);

    // IMPORTANT: don't just auto-dismiss any dialog -- actually READ it.
    // These forms commonly pop a JS alert() saying the CAPTCHA/verification
    // code was wrong, and blindly accepting it without checking the text
    // was exactly why a failed submit used to get reported as a success.
    let dialogMessage = null;
    const dialogHandler = async (d) => {
      dialogMessage = d.message();
      await d.accept().catch(() => { });
    };
    formPage.once("dialog", dialogHandler);

    await submitBtn.click({ force: true }).catch(() => { });
    // Give Teletalk's AJAX validation/navigation (and any alert()) time to
    // actually happen before we decide what to do next.
    await formPage.waitForTimeout(1800).catch(() => { });
    formPage.off("dialog", dialogHandler);

    if (formPage.url() !== startUrlBeforeClick) {
      console.log("✅ Form submitted!");
      return true;
    }

    // Did the site tell us it rejected the submission (wrong CAPTCHA etc),
    // either via an alert() or inline error text? If so, don't report
    // success -- get a fresh CAPTCHA and try again.
    const rejection = await detectSubmitRejection(formPage, dialogMessage);
    if (rejection) {
      console.log(`⚠️ Submit was rejected by the site: "${rejection}"`);
      if (i < maxClicks - 1) {
        console.log("🔄 Getting a fresh CAPTCHA and retrying submit...");
        await solveCaptchaRobust(formPage);
        await tickDeclarationCheckbox(formPage);
        continue;
      }
      console.log("❌ Ran out of retries -- please solve the CAPTCHA and submit manually in the browser.");
      return false;
    }

    // If the exact element we clicked is gone from the DOM, that's also a
    // success signal (in-place AJAX submit that swaps content).
    const stillAttached = handle
      ? await handle.evaluate(el => el.isConnected).catch(() => false)
      : await submitBtn.count().catch(() => 0);
    if (!stillAttached) {
      console.log("✅ Form submitted!");
      return true;
    }

    // Still on the same page with the same element attached, and no
    // rejection message detected -- before clicking again, double-check it
    // hasn't somehow become an add/remove-style control (defensive; shouldn't
    // happen with a stable handle, but cheap to verify).
    if (await isAddOrRemoveControl(submitBtn)) break;
  }

  // We clicked a genuine submit control the requested number of times, saw
  // no navigation, no DOM removal, and no rejection message -- this is a
  // genuinely uncertain outcome, so say so honestly instead of claiming
  // success.
  console.log("❓ Clicked Submit but couldn't confirm it went through (no page change, no error message either) -- please check the browser and submit manually if needed.");
  return false;
}

// Looks for signs the site rejected the submission: either the alert()
// dialog message we captured, or common inline error text that appears
// near the CAPTCHA/verification fields after a failed attempt.
const REJECTION_TEXT_RE = /wrong\s*(verification|captcha|code)|invalid\s*(captcha|code|verification)|(captcha|code|verification).{0,20}(not\s*match|incorrect|invalid|wrong|mismatch)|does not match|ভুল|সঠিক\s*নয়|আবার\s*চেষ্টা/i;

async function detectSubmitRejection(page, dialogMessage) {
  if (dialogMessage && REJECTION_TEXT_RE.test(dialogMessage)) return dialogMessage.trim();
  try {
    const bodyText = await page.evaluate(() => document.body ? document.body.innerText : "").catch(() => "");
    const match = bodyText.match(REJECTION_TEXT_RE);
    if (match) {
      // Grab a short window of context around the match for a useful log line.
      const idx = bodyText.indexOf(match[0]);
      return bodyText.slice(Math.max(0, idx - 20), idx + 60).replace(/\s+/g, " ").trim();
    }
  } catch { /* ignore */ }
  return null;
}

async function waitForApplicationForm(context) {
  let tick = 0;
  while (true) {
    for (const p of context.pages()) {
      if (p.isClosed()) continue;
      const found = await p.locator("#name").count().catch(() => 0);
      if (found > 0) return p;
    }
    tick++;
    if (tick % 5 === 0) {
      console.log("[Listening...] Waiting for Application Form (#name) to load in any tab...");
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

function keepAlive(browser, page) {
  return new Promise((resolve) => {
    browser.on("disconnected", () => {
      resolve();
    });

    if (process.stdin && process.stdin.isTTY) {
      try {
        const rl = readline.createInterface({ input: process.stdin });
        rl.on("line", async (line) => {
          if (!hasAnyAI) return;
          if (line.trim().toLowerCase() === "r") {
            console.log("Re-reading CAPTCHA...");
            await solveCaptchaRobust(page);
          }
        });
      } catch (e) {
        // ignore
      }
    }
  });
}

// Remember the last CAPTCHA text we solved + which input we typed it into,
// so findAndClickSubmit can double-check/re-type it defensively right
// before submitting (see verifyCaptchaBeforeSubmit).
let lastSolvedCaptcha = null;
let lastCaptchaInputSelector = null;

// Screenshots the actual rendered CAPTCHA <img> and reads it with AI.
async function solveCaptcha(page) {
  // 1. Locate CAPTCHA image with broad, resilient selectors
  const imgSelectors = [
    "#captcha_image",
    "#captcha_img",
    "#captchaImg",
    "#cimage",
    "#img_captcha",
    "#valid_code_img",
    "#vcode_img",
    "img[src*='captcha']",
    "img[src*='code']",
    "img[src*='valid']",
    "img[src*='verification']",
    "img[alt*='captcha']",
    "img[alt*='verification']",
    "img[id*='captcha']",
    "img[name*='captcha']"
  ];

  let captchaImg = null;
  for (const sel of imgSelectors) {
    const el = page.locator(sel).first();
    if ((await el.count().catch(() => 0)) > 0 && (await el.isVisible().catch(() => false))) {
      captchaImg = el;
      break;
    }
  }

  // Fallback: look for <img> near Refresh link or inside Verification Code container
  if (!captchaImg) {
    const nearRefresh = page.locator("a:has-text('Refresh'), a:has-text('click here'), span:has-text('Refresh')").first();
    if (await nearRefresh.count().catch(() => 0)) {
      const containerImg = page.locator("xpath=//a[contains(., 'Refresh') or contains(., 'click here')]/ancestor::*[contains(., 'Verification') or contains(., 'Code') or self::fieldset or self::table or self::tr or self::div][1]//img").first();
      if ((await containerImg.count().catch(() => 0)) > 0) {
        captchaImg = containerImg;
      }
    }
  }

  if (!captchaImg) {
    console.log("⚠️ Couldn't find a CAPTCHA image on this page.");
    return null;
  }

  let buffer;
  try {
    await captchaImg.scrollIntoViewIfNeeded().catch(() => { });
    buffer = await captchaImg.screenshot();
  } catch (err) {
    console.log(`⚠️ Couldn't screenshot the CAPTCHA image: ${err.message}`);
    return null;
  }

  const text = await readCaptchaWithAI(buffer.toString("base64"));
  if (!text) {
    console.log("🤖 AI couldn't read the CAPTCHA -- please type it manually.");
    return null;
  }

  const cleanedText = text.replace(/[^a-zA-Z0-9]/g, "").trim();
  console.log(`🤖 CAPTCHA solved: "${cleanedText}" (raw: "${text.trim()}")`);

  // 2. Locate CAPTCHA input field
  const inputSelectors = [
    "#captcha",
    "#valid_code",
    "#validation_code",
    "#vcode",
    "#v_code",
    "#code",
    "#txt_captcha",
    "#security_code",
    "input[name='captcha']",
    "input[name='valid_code']",
    "input[name='validation_code']",
    "input[name='vcode']",
    "input[name='v_code']",
    "input[name='code']",
    "input[name='security_code']",
    "input[name*='captcha']",
    "input[name*='valid']",
    "input[name*='code']",
    "input[id*='captcha']",
    "input[id*='valid']",
    "input[id*='code']"
  ];

  let captchaInput = null;
  let matchedCaptchaSelector = null;
  for (const sel of inputSelectors) {
    const el = page.locator(sel).first();
    if ((await el.count().catch(() => 0)) > 0 && (await el.isVisible().catch(() => false))) {
      captchaInput = el;
      matchedCaptchaSelector = sel;
      break;
    }
  }

  if (!captchaInput) {
    const containerSel = "xpath=//img[contains(@src, 'captcha') or contains(@src, 'code') or contains(@id, 'captcha') or contains(@src, 'valid')]/ancestor::*[self::fieldset or self::table or self::tr or self::div][1]//input[@type='text' or not(@type)]";
    const containerInput = page.locator(containerSel).first();
    if ((await containerInput.count().catch(() => 0)) > 0) {
      captchaInput = containerInput;
      matchedCaptchaSelector = containerSel;
    }
  }

  if (captchaInput) {
    await captchaInput.scrollIntoViewIfNeeded().catch(() => { });
    await captchaInput.click({ force: true }).catch(() => { });
    // Clear existing value completely
    await captchaInput.evaluate(el => { el.value = ""; }).catch(() => { });
    // Type character-by-character with REAL keyboard events so Teletalk's
    // keypress/keyup validators fire exactly as they would for a human.
    await page.keyboard.type(cleanedText, { delay: 80 });
    // Belt-and-suspenders: make sure the value stuck, without stomping on
    // the real keystroke history that just happened.
    await captchaInput.evaluate((el, val) => {
      if (el.value !== val) {
        el.value = val;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }, cleanedText).catch(() => { });
    // IMPORTANT: many of these portals only run their client-side validity
    // check on blur, not on every keystroke. If we never blur the field,
    // clicking Submit later can cause the browser/site JS to yank focus
    // straight back into the still-"unvalidated" CAPTCHA box. Tab away to
    // force a real blur.
    await page.keyboard.press("Tab").catch(() => { });
    await page.waitForTimeout(200).catch(() => { });
    // Remember what we typed and where, so findAndClickSubmit can verify
    // (and re-type if needed) right before the actual submit click.
    lastSolvedCaptcha = cleanedText;
    lastCaptchaInputSelector = matchedCaptchaSelector;
    console.log(`✅ CAPTCHA "${cleanedText}" typed into input box.`);
    return cleanedText;
  } else {
    console.log("⚠️ Could not find CAPTCHA text box to enter code.");
    return null;
  }
}

// Clicks whatever "Refresh" / "click here" control regenerates the CAPTCHA
// image, then waits briefly for the new image to actually load.
async function refreshCaptchaImage(page) {
  const refreshSel = "a:has-text('Refresh'), a:has-text('click here'), span:has-text('Refresh'), button:has-text('Refresh'), #captcha_refresh, .captcha-refresh";
  const btn = page.locator(refreshSel).first();
  if (!(await btn.count().catch(() => 0))) return false;
  await btn.click({ force: true, timeout: 3000 }).catch(() => { });
  await page.waitForTimeout(1200).catch(() => { });
  return true;
}

// A CAPTCHA read that comes back drastically shorter/longer than what
// this portal normally uses is almost certainly a bad OCR read (e.g. a
// 3-character result when every prior successful read on this site was 6
// characters), not a genuinely short code. Refresh and re-read a couple of
// times before giving up and using whatever we've got.
async function solveCaptchaRobust(page, { minLen = 4, maxAttempts = 3 } = {}) {
  let result = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    result = await solveCaptcha(page);
    if (result && result.length >= minLen) return result;
    if (attempt < maxAttempts) {
      console.log(`🤖 CAPTCHA read ("${result || ""}") looks too short/unreliable -- refreshing and retrying (${attempt}/${maxAttempts})...`);
      const refreshed = await refreshCaptchaImage(page);
      if (!refreshed) break; // no refresh control found, no point looping
    }
  }
  return result;
}

// ── MULTI-PROVIDER AI CALLER ──────────────────────────────────────────────────
// Uses the unified cascade (Gemini → Groq → Cloudflare → OpenRouter) with automatic fallback.
async function callAIWithFallback(prompt, base64Image = null) {
  return await callAIWithCascade(prompt, base64Image);
}

// ─ CAPTCHA reader using AI cascade ───────────────────────────────────────────────
async function readCaptchaWithAI(base64Image) {
  const prompt = "Read the distorted alphanumeric text in this CAPTCHA image. Reply with ONLY the exact characters you see, nothing else -- no spaces, no punctuation, no explanation.";
  return await callAIWithCascade(prompt, base64Image, { isCaptcha: true, fresh: true });
}

async function readCaptchaWithGemini(base64Image) {
  return await readCaptchaWithAI(base64Image);
}


// ── SMART NAVIGATION (Saved Pattern → Deterministic → AI Fallback) ──────────
// Hierarchy:
//   1. Saved successful pattern  (instant replay, no AI)
//   2. Deterministic rule-based  (standard Teletalk flow)
//   3. AI Vision fallback        (cascades through providers, blacklisting failures)
async function smartNavigate(page, context, targetPost) {
  // 0. Form already open?
  for (const p of context.pages()) {
    if (p.isClosed()) continue;
    const found = await p.locator("#name").count().catch(() => 0);
    if (found > 0) return p;
  }

  // 1. Try saved memory pattern FIRST (fastest, no AI cost)
  const navKey = `nav_pattern::${new URL(page.url()).hostname}::${targetPost}`;
  const allPats = await loadPatterns();
  const savedNav = allPats["__nav"]?.[navKey];
  if (savedNav && savedNav.length) {
    console.log(`[⚡ Memory] Found ${savedNav.length}-step saved pattern for "${targetPost}" — replaying...`);
    let replayPage = page;
    let patternWorked = false;
    for (const step of savedNav) {
      try {
        if (step.action === "click_text") {
          await replayPage.getByText(step.value, { exact: false }).first().click({ timeout: 8000 }).catch(() => { });
        } else if (step.action === "click_selector") {
          await replayPage.locator(step.value).first().click({ timeout: 8000 }).catch(() => { });
        }
        await replayPage.waitForTimeout(2000).catch(() => { });
        const pages = context.pages().filter(p => !p.isClosed());
        if (pages.length > 1) replayPage = pages[pages.length - 1];
        await replayPage.bringToFront().catch(() => { });

        for (const p of context.pages()) {
          if (p.isClosed()) continue;
          if (await p.locator("#name, #name_en, #applicant_name").count().catch(() => 0) > 0) {
            console.log(`[⚡ Memory] ✅ Form found via saved pattern!`);
            patternWorked = true;
            return p;
          }
        }
      } catch { /* continue */ }
    }
    if (!patternWorked) {
      console.log(`[⚡ Memory] Saved pattern didn't reach form — trying standard navigation...`);
    }
  }

  // 2. Deterministic rule-based navigation
  const detResult = await deterministicNavigate(page, context, targetPost);
  if (detResult) return detResult;

  // 3. AI Vision fallback (multi-provider with session blacklist)
  const hasAnyAI = Boolean(
    process.env.GEMINI_API_KEY ||
    process.env.GROQ_API_KEY ||
    process.env.OPENROUTER_API_KEY ||
    (process.env.CF_ACCOUNT_ID && process.env.CF_API_TOKEN)
  );
  if (hasAnyAI) {
    console.log(`[🤖 AI Brain] Standard automation finished — engaging AI Vision Brain (multi-provider cascade)...`);
    return await aiNavigate(page, context, targetPost);
  }

  return null;
}

// ── DETERMINISTIC TELETALK RULE-BASED NAVIGATION ─────────────────────────────
// Follows standard Teletalk patterns (Apply Now -> Post Selection -> Alljobs No -> Next)
async function deterministicNavigate(page, context, targetPost) {
  console.log(`[⚡ Standard Navigation] Checking standard Teletalk portal steps for "${targetPost}"...`);

  let lastUrl = "";
  let applyClickCount = 0;

  for (let loop = 0; loop < 10; loop++) {
    await dismissModals(page);
    await page.waitForTimeout(600);

    const currentUrl = page.url();

    // Check if form is visible in any tab
    for (const p of context.pages()) {
      if (p.isClosed()) continue;
      if (await p.locator("#name, #name_en, #applicant_name").count().catch(() => 0) > 0) {
        console.log(`[⚡ Standard Navigation] ✅ Application Form detected!`);
        return p;
      }
    }

    // Step 0: Ongoing Circular links (e.g. <fieldset><legend>Ongoing Circular</legend><a ...>...</a>)
    const ongoingLink = page.locator("fieldset:has(legend:has-text('Ongoing Circular')) a, fieldset:has(legend:has-text('Ongoing')) a, a:has-text('Ongoing Circular'), div:has(legend:has-text('Ongoing')) a").first();
    if (await ongoingLink.isVisible().catch(() => false)) {
      console.log(`[⚡ Standard Navigation] 👉 Step: Clicking Ongoing Circular link...`);
      await ongoingLink.click({ force: true, timeout: 5000 }).catch(() => { });
      await page.waitForTimeout(2500);
      const pages = context.pages().filter(p => !p.isClosed());
      if (pages.length > 1) page = pages[pages.length - 1];
      await page.bringToFront().catch(() => { });
      continue;
    }

    // Step A: "Apply Online" / "Apply now" / "Online Application" / "আবেদন করুন" links
    const applyBtn = page.locator("a:has-text('Apply Online'), a:has-text('Apply now'), a:has-text('Apply Now'), a:has-text('Online Application'), a:has-text('আবেদন করুন'), button:has-text('Apply'), a.btn-apply, a.apply-btn").first();
    if (await applyBtn.isVisible().catch(() => false) && applyClickCount < 2) {
      // Check if this link has an external direct href (common on alljobs.teletalk.com.bd)
      const href = await applyBtn.getAttribute("href").catch(() => null);
      if (href && href.startsWith("http") && !href.includes("alljobs.teletalk.com.bd/jobs")) {
        console.log(`[⚡ Standard Navigation] 👉 Following direct application portal link: ${href}`);
        await page.goto(href, { timeout: 15000, waitUntil: "domcontentloaded" }).catch(() => { });
        await page.waitForTimeout(2000);
        applyClickCount = 0;
        continue;
      }

      console.log(`[⚡ Standard Navigation] 👉 Step: Clicking "Apply" link...`);
      applyClickCount++;
      await applyBtn.click({ force: true, timeout: 5000 }).catch(() => { });
      await page.waitForTimeout(2000);
      const pages = context.pages().filter(p => !p.isClosed());
      if (pages.length > 1) page = pages[pages.length - 1];
      await page.bringToFront().catch(() => { });
      continue;
    }


    // Step B: Post or Circular Selection (Radio buttons)
    const radios = await page.locator("input[type=radio]").all().catch(() => []);
    if (radios.length > 0) {
      let matchedRadio = null;

      // Check if this is the "Premium Member of Alljobs" question
      const pageText = await page.evaluate(() => document.body.innerText).catch(() => "");
      const isPremiumQuestion = /premium member/i.test(pageText) || /alljobs/i.test(pageText);

      if (isPremiumQuestion) {
        console.log(`[⚡ Standard Navigation] 👉 Step: Answering "No" to Alljobs Premium Member...`);
        const noRadio = page.locator("input[type=radio][value='0'], input[type=radio][value='no'], input[type=radio]#no, label:has-text('No') input[type=radio]").first();
        if (await noRadio.count().catch(() => 0)) {
          await noRadio.check({ force: true }).catch(() => { });
        } else {
          // Default to the last radio (usually No)
          await radios[radios.length - 1].check({ force: true }).catch(() => { });
        }
      } else {
        // Post selection list
        if (targetPost) {
          const targetNorm = targetPost.toLowerCase().replace(/[^a-z0-9]/g, "");
          for (const r of radios) {
            const labelText = await r.evaluate(el => {
              const row = el.closest("tr, label, div.radio, div.form-check, li, td") || el.parentElement;
              return row ? row.innerText : "";
            }).catch(() => "");
            const labelNorm = labelText.toLowerCase().replace(/[^a-z0-9]/g, "");
            if (labelNorm.includes(targetNorm) || targetNorm.includes(labelNorm)) {
              matchedRadio = r;
              console.log(`[⚡ Standard Navigation] 👉 Step: Selecting post "${labelText.trim().slice(0, 50)}"...`);
              break;
            }
          }
        }

        // If no direct post title match, select the first circular/post radio
        if (!matchedRadio && radios.length > 0) {
          matchedRadio = radios[0];
          console.log(`[⚡ Standard Navigation] 👉 Step: Selecting active circular/post option...`);
        }

        if (matchedRadio) {
          await matchedRadio.check({ force: true }).catch(() => { });
        }
      }

      // Click "Next" / "Submit" button
      const nextBtn = page.locator("input[value='Next'], button:has-text('Next'), input[type='submit'], button[type='submit'], a:has-text('Next'), input[value='পরবর্তী']").first();
      if (await nextBtn.isVisible().catch(() => false)) {
        console.log(`[⚡ Standard Navigation] 👉 Step: Clicking "Next"...`);
        await nextBtn.click({ force: true, timeout: 5000 }).catch(() => { });
        await page.waitForTimeout(2500);
        const pages = context.pages().filter(p => !p.isClosed());
        if (pages.length > 1) page = pages[pages.length - 1];
        await page.bringToFront().catch(() => { });
        continue;
      }
    }

    // If nothing recognized on this iteration, break to let AI/manual take over
    break;
  }

  return null;
}

// ── AI-DRIVEN VISION NAVIGATION (with Loop Detection & Handback to Basic Pattern) ───
async function aiNavigate(page, context, targetPost) {
  const maxSteps = 15;
  const navKey = `nav_pattern::${new URL(page.url()).hostname}::${targetPost}`;
  const recordedSteps = [];
  let lastActionStr = "";
  let stagnantCount = 0;
  let lastUrl = page.url();

  for (let step = 0; step < maxSteps; step++) {
    // 1. Check if form is visible in any tab
    for (const p of context.pages()) {
      if (p.isClosed()) continue;
      if (await p.locator("#name, #name_en, #applicant_name").count().catch(() => 0) > 0) {
        console.log(`[AI] ✅ Application Form reached after ${step} steps!`);
        if (recordedSteps.length > 0) {
          const pats = await loadPatterns();
          if (!pats["__nav"]) pats["__nav"] = {};
          pats["__nav"][navKey] = recordedSteps;
          await fs.mkdir(path.join(__dirname, "..", "data"), { recursive: true }).catch(() => { });
          await fs.writeFile(PATTERNS_PATH, JSON.stringify(pats, null, 2));
          console.log(`[💾 Memory] Saved ${recordedSteps.length}-step navigation pattern for "${targetPost}".`);
        }
        return p;
      }
    }

    // 2. Dismiss any modal/overlay first
    await dismissModals(page);

    // 3. Take screenshot for AI
    let screenshot;
    try {
      screenshot = await page.screenshot({ type: "png", fullPage: false });
    } catch (e) {
      console.log(`[AI] Screenshot failed: ${e.message}`);
      break;
    }

    const instruction = await askAINavigation(screenshot.toString("base64"), targetPost, step);
    if (!instruction) {
      console.log("[AI] Couldn't determine next step — waiting for manual navigation.");
      break;
    }

    const actionStr = `${instruction.action}::${instruction.value}`;
    console.log(`[AI Step ${step + 1}/${maxSteps}] Action: ${instruction.reason || instruction.action}`);

    // --- STUCK / LOOP DETECTION ---
    // If same action repeated on same URL twice, current AI is stuck in a loop
    const currentUrl = page.url();
    if (actionStr === lastActionStr && currentUrl === lastUrl) {
      stagnantCount++;
      if (stagnantCount >= 2) {
        console.log(`[🤖 AI Loop Detected] AI gave the same action twice without page change.`);
        console.log(`[🤖 AI Cascade] 🔄 Blacklisting current provider & trying next AI in cascade...`);
        stagnantCount = 0;
        // The underlying cascade will move to the next provider on next iteration
      }
    } else {
      stagnantCount = 0;
    }
    lastActionStr = actionStr;
    lastUrl = currentUrl;

    let actionSucceeded = false;
    try {
      if (instruction.action === "click_text") {
        const el = page.getByText(instruction.value, { exact: false }).first();
        if (await el.count().catch(() => 0) > 0) {
          await el.scrollIntoViewIfNeeded().catch(() => { });
          await el.click({ timeout: 8000 });
          recordedSteps.push({ action: "click_text", value: instruction.value });
          actionSucceeded = true;
        }
      } else if (instruction.action === "click_selector") {
        const el = page.locator(instruction.value).first();
        if (await el.count().catch(() => 0) > 0) {
          await el.scrollIntoViewIfNeeded().catch(() => { });
          await el.click({ timeout: 8000 });
          recordedSteps.push({ action: "click_selector", value: instruction.value });
          actionSucceeded = true;
        }
      } else if (instruction.action === "done") {
        console.log("[AI] Navigation finished.");
        break;
      }
    } catch (e) {
      console.log(`[AI] Click failed: ${e.message}`);
    }

    await page.waitForTimeout(2500).catch(() => { });
    const pages = context.pages().filter(p => !p.isClosed());
    if (pages.length > 1) {
      page = pages[pages.length - 1];
      await page.bringToFront().catch(() => { });
      await page.waitForTimeout(1000).catch(() => { });
    }

    // --- HYBRID HANDBACK TO BASIC PATTERN ---
    // If AI successfully navigated past a hurdle, immediately test if basic deterministic pattern can take over!
    if (actionSucceeded) {
      console.log(`[⚡ Hybrid Handback] Testing if basic deterministic pattern can continue from here...`);
      const detResult = await deterministicNavigate(page, context, targetPost);
      if (detResult) {
        console.log(`[⚡ Hybrid Handback] ✅ Basic automation took over and reached the form!`);
        if (recordedSteps.length > 0) {
          const pats = await loadPatterns();
          if (!pats["__nav"]) pats["__nav"] = {};
          pats["__nav"][navKey] = recordedSteps;
          await fs.mkdir(path.join(__dirname, "..", "data"), { recursive: true }).catch(() => { });
          await fs.writeFile(PATTERNS_PATH, JSON.stringify(pats, null, 2));
          console.log(`[💾 Memory] Saved complete navigation pattern for "${targetPost}".`);
        }
        return detResult;
      }
      console.log(`[⚡ Hybrid Handback] Basic automation needs AI guidance for next step...`);
    }
  }

  return null;
}

// Uses the multi-provider cascade (same session blacklist) so failures carry over.
async function askAINavigation(base64Screenshot, targetPost, step) {
  const prompt = `You are controlling a browser to fill out a Bangladeshi government job application on Teletalk.
Goal: Navigate to the APPLICATION FORM for the post: "${targetPost}".
Current step: ${step + 1}

IMPORTANT: Assume any modal popups, overlays, or urgent notices have already been dismissed.
Focus ONLY on navigating to the application form.

Look at this screenshot and decide the SINGLE NEXT ACTION to get closer to the application form.

Rules:
- If you see the application form (fields like Applicant Name, Father Name, Date of Birth) → return action: "done"
- If you see a button/link to Apply/Apply Online/Apply Now/আবেদন করুন → click it
- If you see a list of posts/jobs → find and click "${targetPost}" or the closest match
- If you see a question like "Are you a Premium Member?" / "Premium Member?" → click "No" or "না"
- If you see a circular list → click the most recent/relevant circular
- If you see a Next / পরবর্তী button after answering → click it
- Do NOT try to close modals or popups — they are already handled

Respond ONLY with valid JSON (no markdown, no explanation):
{"action": "click_text", "value": "exact visible text to click", "reason": "brief reason"}
or
{"action": "click_selector", "value": "css selector", "reason": "brief reason"}
or
{"action": "done", "value": "", "reason": "form is visible"}`;

  try {
    const raw = await callAIWithFallback(prompt, base64Screenshot);
    if (!raw) return null;
    const cleaned = raw.replace(/^```[\w]*\n?/gm, "").replace(/```$/gm, "").trim();
    return JSON.parse(cleaned);
  } catch (e) {
    console.log(`[AI] Parse error: ${e.message}`);
    return null;
  }
}

// ── MODAL DISMISSAL ─────────────────────────────────────────────────────────
// Aggressively dismisses any overlay, modal, or popup that may block navigation.
// Tries common close button selectors + Escape key. Runs silently.
async function dismissModals(page) {
  const closeSelectors = [
    // Bootstrap / generic modal close buttons
    "button.close", "button.btn-close", ".modal-header .close",
    "[data-dismiss='modal']", "[data-bs-dismiss='modal']",
    // Common overlay X buttons
    ".modal .close", ".popup-close", ".overlay-close",
    "#closeModal", ".modal-footer .btn-secondary",
    // Text-based close buttons (case-insensitive via :has-text)
    "button:has-text('Close')", "button:has-text('OK')",
    "button:has-text('×')", "button:has-text('✕')",
    "a:has-text('Close')", "a:has-text('×')",
  ];

  for (const sel of closeSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 400 }).catch(() => false)) {
        await el.click({ force: true, timeout: 2000 }).catch(() => { });
        await page.waitForTimeout(500).catch(() => { });
      }
    } catch { /* ignore */ }
  }

  // Also try pressing Escape to close any JS-handled modals
  await page.keyboard.press("Escape").catch(() => { });
  await page.waitForTimeout(300).catch(() => { });
}

// ── TICK ALL VISIBLE CHECKBOXES ─────────────────────────────────────────────
// Used in post-submit flows (e.g. preview.php) where the page asks you to tick all agreements.
async function tickAllCheckboxes(page) {
  try {
    const previewSelectors = ["#info_yes", "input[name='info_yes']", "#agree", "input[name='agree']", "#declaration", "input[name='declaration']", "input[type='checkbox']"];
    for (const sel of previewSelectors) {
      const els = await page.locator(sel).all().catch(() => []);
      for (const el of els) {
        const isVisible = await el.isVisible().catch(() => false);
        if (!isVisible) continue;
        await el.evaluate(e => {
          e.checked = true;
          if (typeof e.onchange === "function") { try { e.onchange(); } catch (err) { } }
          e.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          e.dispatchEvent(new Event("input", { bubbles: true }));
          e.dispatchEvent(new Event("change", { bubbles: true }));
        }).catch(() => { });
        await el.check({ force: true, timeout: 1000 }).catch(() => { });
      }
    }
    console.log("✅ Ticked preview declaration checkbox.");
  } catch (e) {
    console.log(`[TickAll] ${e.message}`);
  }
}

// ── PRECISE DECLARATION CHECKBOX ───────────────────────────────────────────
// Ticks the declaration/agreement checkbox at the bottom of the form.
async function tickDeclarationCheckbox(page) {
  try {
    // 1. Direct standard Teletalk declaration selectors (#agree / name='agree')
    const agree = page.locator("#agree, input[name='agree'], input#declaration").first();
    if (await agree.count().catch(() => 0)) {
      await agree.evaluate(el => {
        el.checked = true;
        if (typeof el.onchange === 'function') { try { el.onchange(); } catch (e) { } }
        el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }).catch(() => { });
      await page.locator("label[for='agree'], label.form-check-label").first().click({ force: true, timeout: 1000 }).catch(() => { });
      await agree.check({ force: true, timeout: 1000 }).catch(() => { });
      console.log("✅ Declaration checkbox (#agree) ticked.");
      return;
    }

    // 2. Search for checkbox with declaration text keywords in surrounding DOM
    const checkboxes = await page.locator("input[type=checkbox]").all().catch(() => []);
    for (const cb of checkboxes) {
      const isVisible = await cb.isVisible().catch(() => false);
      if (!isVisible) continue;

      const text = await cb.evaluate(el => {
        const tr = el.closest("tr");
        const fieldset = el.closest("fieldset");
        const div = el.closest("div.form-group, div.row, div, p, form");
        const parent = el.parentElement;
        const label = el.id ? document.querySelector(`label[for="${el.id}"]`) : null;
        return [
          tr ? tr.innerText : "",
          fieldset ? fieldset.innerText : "",
          div ? div.innerText : "",
          parent ? parent.innerText : "",
          label ? label.innerText : ""
        ].join(" ");
      }).catch(() => "");

      if (/declare|declaration|knowledge and belief|correct, true|next step|terms|condition/i.test(text)) {
        await cb.evaluate(el => {
          el.checked = true;
          if (typeof el.onchange === 'function') { try { el.onchange(); } catch (e) { } }
          el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }).catch(() => { });
        await cb.check({ force: true, timeout: 1000 }).catch(() => { });
        console.log("✅ Declaration checkbox ticked.");
        return;
      }
    }
  } catch (e) {
    console.log(`[Checkbox] ${e.message}`);
  }
}

// ── HANDLE OPTIONAL SECTIONS (Masters, Job Experience) ───────────────────────
// Ensures optional section checkboxes are UNCHECKED unless the profile explicitly
// provides data for them, preventing red-bordered validation errors!
async function handleOptionalSections(page, profile) {
  try {
    const hasGraduation = Boolean(profile.graduation && (profile.graduation.examination || profile.graduation.institute || profile.graduation.subject));
    const hasMasters = Boolean(profile.masters && (profile.masters.examination || profile.masters.exam));
    const hasExperience = Boolean(profile.experience && (profile.experience.organization || profile.experience.designation));

    const allCbs = await page.locator("input[type=checkbox]").all().catch(() => []);
    for (const cb of allCbs) {
      const parentText = await cb.evaluate(el => {
        const row = el.closest("tr, div, td, p, fieldset, table") || el.parentElement;
        return row ? row.innerText : "";
      }).catch(() => "");

      // 1. Graduation / Equivalent level checkbox
      if (/graduation/i.test(parentText) && !/masters|ssc|hsc|declare|declaration/i.test(parentText)) {
        if (hasGraduation) {
          await cb.check({ force: true }).catch(() => { });
          await cb.evaluate(el => {
            el.checked = true;
            if (typeof el.onclick === "function") { try { el.onclick(); } catch (e) { } }
            if (typeof el.onchange === "function") { try { el.onchange(); } catch (e) { } }
            el.dispatchEvent(new Event("click", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          }).catch(() => { });
          console.log("📋 Enabled Graduation qualification section checkbox.");
        } else {
          await cb.uncheck({ force: true }).catch(() => { });
          await cb.evaluate(el => {
            el.checked = false;
            if (typeof el.onclick === "function") { try { el.onclick(); } catch (e) { } }
            if (typeof el.onchange === "function") { try { el.onchange(); } catch (e) { } }
            el.dispatchEvent(new Event("click", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          }).catch(() => { });
          console.log("🔒 Kept Graduation section unchecked (not in profile).");
        }
      }

      // 2. Masters / Equivalent level checkbox
      if (/masters/i.test(parentText) && !/graduation|declare|declaration/i.test(parentText)) {
        if (hasMasters) {
          await cb.check({ force: true }).catch(() => { });
          await cb.evaluate(el => {
            el.checked = true;
            if (typeof el.onclick === "function") { try { el.onclick(); } catch (e) { } }
            if (typeof el.onchange === "function") { try { el.onchange(); } catch (e) { } }
            el.dispatchEvent(new Event("click", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          }).catch(() => { });
          console.log("📋 Enabled Masters qualification section.");
        } else {
          await cb.uncheck({ force: true }).catch(() => { });
          await cb.evaluate(el => {
            el.checked = false;
            if (typeof el.onclick === "function") { try { el.onclick(); } catch (e) { } }
            if (typeof el.onchange === "function") { try { el.onchange(); } catch (e) { } }
            el.dispatchEvent(new Event("click", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          }).catch(() => { });
          console.log("🔒 Kept Masters section unchecked (not in profile).");
        }
      }

      // 3. Job Experience checkbox
      if (/job experience|employment|experiences/i.test(parentText) && !/declare|declaration/i.test(parentText)) {
        if (hasExperience) {
          await cb.check({ force: true }).catch(() => { });
          await cb.evaluate(el => {
            el.checked = true;
            if (typeof el.onclick === "function") { try { el.onclick(); } catch (e) { } }
            if (typeof el.onchange === "function") { try { el.onchange(); } catch (e) { } }
            el.dispatchEvent(new Event("click", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          }).catch(() => { });
          console.log("📋 Enabled Job Experience section.");
        } else {
          await cb.uncheck({ force: true }).catch(() => { });
          await cb.evaluate(el => {
            el.checked = false;
            if (typeof el.onclick === "function") { try { el.onclick(); } catch (e) { } }
            if (typeof el.onchange === "function") { try { el.onchange(); } catch (e) { } }
            el.dispatchEvent(new Event("click", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          }).catch(() => { });
          console.log("🔒 Kept Job Experience section unchecked (not in profile).");
        }
      }
    }
  } catch (e) {
    console.log(`[Optional Sections] ${e.message}`);
  }
}

// ── AUTO-FILL QUALIFICATION QUESTIONS (e.g. Computer Skills) ───────────────
async function fillOtherQualifications(page, profile) {
  try {
    const processed = new Set();
    const selects = await page.locator("select").all().catch(() => []);

    for (const sel of selects) {
      const isVisible = await sel.isVisible().catch(() => false);
      if (!isVisible) continue;

      const id = (await sel.getAttribute("id").catch(() => "")) || "";
      const name = (await sel.getAttribute("name").catch(() => "")) || "";

      // STRICT EXCLUSION: Never touch standard profile or education fields!
      if (/^(name|father|mother|dob|nationality|religion|gender|marital|nid|breg|passport|mobile|email|quota|dep_status|present|permanent|ssc|hsc|gra|mas)/i.test(id)) continue;
      if (/^(name|father|mother|dob|nationality|religion|gender|marital|nid|breg|passport|mobile|email|quota|dep_status|present|permanent|ssc|hsc|gra|mas)/i.test(name)) continue;
      if (/board|roll|exam|year|result|gpa|cgpa|subject|group|district|upazila|post|careof|village/i.test(id + " " + name)) continue;

      const rowText = await sel.evaluate(el => {
        const row = el.closest("tr, div.form-group, div.field, fieldset, p") || el.parentElement;
        return (row ? row.innerText : "").toLowerCase();
      }).catch(() => "");

      const isExpField = /other_exp|exp_val|other_qualification/i.test(id + " " + name) ||
        /computer|skill|proficiency|ict|ms office|typing|typewriting|training|do you have/i.test(rowText);

      if (!isExpField) continue;

      const key = id || name || (rowText.slice(0, 30));
      if (key && processed.has(key)) continue;
      if (key) processed.add(key);

      const hasYesOption = await sel.evaluate(el => {
        for (let i = 0; i < el.options.length; i++) {
          const opt = el.options[i];
          const txt = (opt.text || "").trim().toLowerCase();
          const val = (opt.value || "").trim().toLowerCase();
          if (txt === "yes" || val === "yes" || val === "1" || txt.includes("yes") || txt.includes("হ্যাঁ") || val === "y") {
            el.selectedIndex = i;
            el.value = opt.value;
            if (typeof el.onchange === "function") { try { el.onchange(); } catch (e) { } }
            if (typeof window.onChangeIdExp === "function") { try { window.onChangeIdExp(el, el.value); } catch (e) { } }
            if (typeof window.changeExp === "function") { try { window.changeExp(el); } catch (e) { } }
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            return opt.text.trim();
          }
        }
        return null;
      }).catch(() => null);

      if (hasYesOption) {
        console.log(`[Auto-Fill] 💻 Selected "${hasYesOption}" for qualification: ${rowText.slice(0, 60).replace(/\s+/g, ' ')}`);
      }
    }

    // 2. Scan any driving selects if applicable
    if (profile.driving_license !== undefined) {
      const drivingSelects = await page.locator("select[name*='driving'], select[id*='driving']").all().catch(() => []);
      for (const sel of drivingSelects) {
        const val = profile.driving_license ? "Yes" : "No";
        await selectRobust(page, sel, val);
      }
    }
  } catch (e) {
    console.log(`[Qualifications] ${e.message}`);
  }
}

async function setSelectOptionToYes(selLocator) {
  try {
    const result = await selLocator.evaluate((el) => {
      let chosenIndex = -1;
      // 1. Try finding explicit "yes" or positive indicator
      for (let i = 0; i < el.options.length; i++) {
        const opt = el.options[i];
        const text = (opt.text || "").trim().toLowerCase();
        const val = (opt.value || "").trim().toLowerCase();
        if (text === "yes" || text.startsWith("yes") || text.includes("yes") || val === "yes" || val === "1" || text.includes("হ্যাঁ") || val === "y") {
          chosenIndex = i;
          break;
        }
      }
      // 2. If no explicit "yes" match, but option 1 is not "select" and not "no"
      if (chosenIndex === -1 && el.options.length >= 2) {
        for (let i = 1; i < el.options.length; i++) {
          const opt = el.options[i];
          const text = (opt.text || "").trim().toLowerCase();
          const val = (opt.value || "").trim().toLowerCase();
          if (!text.includes("select") && !text.includes("no") && !text.includes("না") && val !== "0" && val !== "no" && val !== "2") {
            chosenIndex = i;
            break;
          }
        }
      }
      // 3. Fallback: if there are multiple options, select index 1
      if (chosenIndex === -1 && el.options.length > 1) {
        chosenIndex = 1;
      }

      if (chosenIndex !== -1) {
        el.selectedIndex = chosenIndex;
        el.value = el.options[chosenIndex].value;
        if (typeof el.onchange === 'function') { try { el.onchange(); } catch (e) { } }
        if (typeof window.onChangeIdExp === 'function') { try { window.onChangeIdExp(el, el.value); } catch (e) { } }
        if (typeof window.changeExp === 'function') { try { window.changeExp(el); } catch (e) { } }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { index: chosenIndex, text: el.options[chosenIndex].text, value: el.options[chosenIndex].value };
      }
      return null;
    }).catch(() => null);

    if (result) {
      console.log(`[Auto-Fill] ✅ Selected "${result.text}" (value: "${result.value}")`);
      await selLocator.selectOption({ index: result.index }, { timeout: 1000 }).catch(() => { });
    }
  } catch (e) {
    // ignore
  }
}

// ── ROBUST SELECT WITH NATIVE EVENT DISPATCH ────────────────────────────────
async function selectRobust(page, locatorOrSelector, wanted) {
  const el = typeof locatorOrSelector === "string" ? page.locator(locatorOrSelector) : locatorOrSelector;
  if (!(await el.count().catch(() => 0))) return false;

  const options = await el.locator("option").all().catch(() => []);
  let matchedValue = null;
  const target = String(wanted).trim().toLowerCase().replace(/[^a-z0-9]/g, "");

  for (const opt of options) {
    const text = (await opt.innerText().catch(() => "")).trim();
    const val = (await opt.getAttribute("value").catch(() => "")).trim();
    const normText = text.toLowerCase().replace(/[^a-z0-9]/g, "");
    const normVal = val.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (normText === target || normVal === target || (target.length > 2 && (normText.includes(target) || target.includes(normText)))) {
      matchedValue = val;
      break;
    }
  }

  if (matchedValue !== null) {
    await el.selectOption({ value: matchedValue }, { timeout: 1000 }).catch(() => { });
  } else {
    await el.selectOption({ label: String(wanted).trim() }, { timeout: 1000 }).catch(() => { });
  }

  // Fire native change + input events so form JavaScript recognizes the selection
  await el.evaluate(selectEl => {
    selectEl.dispatchEvent(new Event("change", { bubbles: true }));
    selectEl.dispatchEvent(new Event("input", { bubbles: true }));
  }).catch(() => { });
  return true;
}

// Scans ALL visible unfilled inputs/selects after the normal fill pass.
// For each empty field, AI infers the best value from the profile +
// common sense, fills it, and saves it to memory for future runs.
async function scanAndFillUnknownFields(page, profile) {
  const host = await getPageHost(page);
  const patterns = await loadPatterns();

  // 1. Apply previously learned values first (instant, no AI)
  const learned = patterns[host]?.learned_values || {};
  let appliedFromMemory = 0;
  for (const [selector, info] of Object.entries(learned)) {
    const el = page.locator(selector);
    if (!(await el.count().catch(() => 0))) continue;
    const cur = await el.inputValue().catch(() => "");
    if (cur && cur.trim()) continue; // already filled
    if (info.action === "fill") {
      await el.fill(info.value).catch(() => { });
      appliedFromMemory++;
    } else if (info.action === "select") {
      await el.selectOption({ label: info.option }).catch(() => { });
      appliedFromMemory++;
    }
  }
  if (appliedFromMemory) console.log(`[Memory] ⚡ Applied ${appliedFromMemory} learned field(s) instantly.`);

  if (!hasAnyAI) return; // No AI key — can't infer new fields

  // 2. Find remaining unfilled fields (ONLY visible, enabled fields)
  const unfilled = await page.evaluate(() => {
    const skip = new Set(["hidden", "submit", "button", "image", "file", "checkbox", "radio"]);
    const results = [];
    for (const el of document.querySelectorAll("input, select, textarea")) {
      if (skip.has(el.type)) continue;
      // Skip invisible or disabled fields (e.g. unchecked optional sections)
      if (el.disabled || el.offsetParent === null) continue;
      // Skip CAPTCHA and verification fields (handled by solveCaptcha)
      if (el.name && /captcha|valid_code|verification|vcode|security_code/i.test(el.name)) continue;
      if (el.id && /captcha|valid_code|verification|vcode|security_code/i.test(el.id)) continue;
      // Skip other_exp fields (handled by fillOtherQualifications)
      if (el.name && /other_exp/i.test(el.name)) continue;
      if (el.id && /other_exp/i.test(el.id)) continue;
      const val = el.tagName === "SELECT" ? el.value : el.value.trim();
      if (val) continue; // already has a value

      // Extract label text
      let label = "";
      if (el.id) {
        const lbl = document.querySelector(`label[for="${el.id}"]`);
        if (lbl) label = lbl.innerText.trim();
      }
      if (!label) {
        const cell = el.closest("td, th, div.form-group, div.field");
        if (cell) label = cell.innerText.replace(el.value, "").trim().slice(0, 120);
      }
      if (!label && el.placeholder) label = el.placeholder;
      if (!label && el.name) label = el.name.replace(/_/g, " ");

      const selector = el.id ? `#${el.id}` : (el.name ? `[name="${el.name}"]` : null);
      if (!selector) continue;

      const isSelect = el.tagName === "SELECT";
      results.push({
        selector,
        label: label.slice(0, 120),
        type: isSelect ? "select" : (el.type || "text"),
        options: isSelect
          ? Array.from(el.options).map(o => o.text.trim()).filter(t => t && t !== "-Select-" && t !== "-- Select --").slice(0, 25)
          : []
      });
    }
    return results;
  }).catch(() => []);

  // Exclude fields we already know how to handle (from learned_values keys)
  const truly_new = unfilled.filter(f => !learned[f.selector]);
  if (!truly_new.length) { console.log("[AI Scan] No new unknown fields found."); return; }

  console.log(`[AI Scan] 🔎 Found ${truly_new.length} unfilled unknown field(s) — asking Gemini to infer values...`);

  // Build a concise profile summary for the prompt
  const profileSummary = JSON.stringify({
    name: profile.name_en, name_bn: profile.name_bn,
    father: profile.father_en, mother: profile.mother_en,
    dob: profile.dob, gender: profile.gender,
    religion: profile.religion, nationality: profile.nationality,
    blood_group: profile.blood_group || "(unknown)",
    marital_status: profile.marital_status,
    mobile: profile.mobile, email: profile.email,
    national_id: profile.national_id,
    present_address: profile.present_address,
    permanent_address: profile.permanent_address,
  }, null, 2);

  const fieldList = truly_new.map(f =>
    `selector: "${f.selector}" | label: "${f.label}" | type: ${f.type}${f.options.length ? ` | options: [${f.options.slice(0, 10).join(", ")}]` : ""}`
  ).join("\n");

  const prompt = `You are filling a Bangladeshi government job application form for this applicant:
${profileSummary}

These form fields are empty and NOT in the script's standard field list.
For each field, infer the BEST value using the profile data or common defaults for Bangladesh.
If you genuinely cannot infer a value, use action "skip".

Fields to fill:
${fieldList}

Respond ONLY with a valid JSON array (no markdown, no explanation):
[{"selector":"#id","action":"fill","value":"the value","label":"field label"},
 {"selector":"#sel","action":"select","option":"exact option text","label":"field label"},
 {"selector":"#x","action":"skip","label":"field label"}]`;

  try {
    const screenshot = await page.screenshot({ type: "png", fullPage: true }).catch(() => null);
    const base64 = screenshot ? screenshot.toString("base64") : null;
    const raw = await callAIWithFallback(prompt, base64);
    if (!raw) { console.log("[AI Scan] No AI response"); return; }
    const cleaned = raw.replace(/^```[\w]*\n?/gm, "").replace(/```$/gm, "").trim();
    const actionsRaw = JSON.parse(cleaned);

    // --- EMAIL NOTIFICATION: show inferred values, non-blocking ---
    const nonSkip = actionsRaw.filter(a => a.action !== "skip");
    if (nonSkip.length > 0) {
      console.log(`\n[AI Scan] Applying ${nonSkip.length} inferred field(s) automatically:`);
      nonSkip.forEach((a, i) => {
        const val = a.action === "select" ? a.option : a.value;
        console.log(`  [${i + 1}] "${a.label || a.selector}" \u2192 "${val}"`);
      });
      // Send email notification so user can verify and correct in field-patterns.json
      sendVerificationEmail(nonSkip, host).catch(() => { });
    }

    const actions = actionsRaw;

    const newLearned = { ...learned };
    let filled = 0;
    for (const action of actions) {
      if (action.action === "skip") continue;
      const el = page.locator(action.selector);
      if (!(await el.count().catch(() => 0))) continue;

      if (action.action === "fill") {
        await el.fill(String(action.value)).catch(() => { });
        newLearned[action.selector] = { action: "fill", value: String(action.value), label: action.label };
        console.log(`[AI Scan] ✏️  "${action.label}" → "${action.value}"`);
        filled++;
      } else if (action.action === "select") {
        await el.selectOption({ label: action.option }).catch(() => { });
        newLearned[action.selector] = { action: "select", option: action.option, label: action.label };
        console.log(`[AI Scan] 📋 "${action.label}" → selected "${action.option}"`);
        filled++;
      }
    }

    if (filled > 0) {
      // Save all newly learned values
      const allPatterns = await loadPatterns();
      if (!allPatterns[host]) allPatterns[host] = {};
      allPatterns[host].learned_values = newLearned;
      await fs.mkdir(path.join(__dirname, "..", "data"), { recursive: true }).catch(() => { });
      await fs.writeFile(PATTERNS_PATH, JSON.stringify(allPatterns, null, 2));
      console.log(`[Memory] 💾 Saved ${filled} new inferred field(s) for future runs.`);
    }
  } catch (e) {
    console.log(`[AI Scan] Error: ${e.message}`);
  }
}

// ── POST-SUBMIT AUTONOMOUS AGENT ─────────────────────────────────────────────────
// Watches for page changes after form submission. Uses AI to identify
// each new page (image upload, confirmation, new form, success) and acts.
// Fingerprints "what kind of step is currently on screen" so the agent can
// tell steps apart even when the site swaps content in-place via AJAX
// without changing the URL (common on these multi-step Teletalk wizards).
//
// NOTE: file-input visibility is intentionally NOT used as a gate here.
// Teletalk (and many similar portals) frequently hide the native
// <input type=file> behind a custom-styled "Choose File" button — that
// input still has offsetParent === null (i.e. Playwright/browser would
// call it "not visible"), even though it's a perfectly real, fillable
// input. Gating on visibility here previously caused the image-upload
// step to be silently misclassified as "declaration_only" (since #agree
// was also present), so handleImageUpload() never ran at all. Counting
// file inputs regardless of visibility fixes that.
async function detectStepType(page, { debug = false } = {}) {
  try {
    const info = await page.evaluate(() => {
      const nameEl = document.querySelector("#name, #applicant_name, #father");
      const fileEls = Array.from(document.querySelectorAll("input[type=file]"));
      const agreeEl = document.querySelector("#agree, input[name='agree'], input#declaration");
      const captchaEl = document.querySelector(
        "#captcha, #valid_code, input[name*='captcha' i], input[name*='valid' i], img[src*='captcha' i]"
      );
      return {
        hasMainForm: !!nameEl,
        mainFormMatchTag: nameEl ? `${nameEl.tagName}#${nameEl.id}${nameEl.type ? "[type=" + nameEl.type + "]" : ""}${nameEl.hidden || nameEl.style.display === "none" ? "(hidden)" : ""}` : null,
        fileInputCount: fileEls.length,
        fileInputIds: fileEls.map(el => `#${el.id || "(no id)"}[name=${el.name || "(no name)"}]`),
        hasAgree: !!agreeEl,
        hasCaptcha: !!captchaEl,
      };
    });

    let stepType;
    if (info.hasMainForm) stepType = "main_form";
    else if (info.fileInputCount > 0) stepType = "upload";
    else if (info.hasCaptcha) stepType = "captcha_declaration";
    else if (info.hasAgree) stepType = "declaration_only";
    else stepType = "other";

    if (debug) {
      console.log(`[detectStepType] → "${stepType}" | mainForm=${info.hasMainForm}${info.mainFormMatchTag ? ` (matched ${info.mainFormMatchTag})` : ""} | fileInputs=${info.fileInputCount}${info.fileInputCount ? ` [${info.fileInputIds.join(", ")}]` : ""} | agree=${info.hasAgree} | captcha=${info.hasCaptcha}`);
    }

    return stepType;
  } catch (e) {
    if (debug) console.log(`[detectStepType] error: ${e.message}`);
    return "unknown";
  }
}

// Called once the application PDF has been successfully downloaded and
// emailed -- the job is genuinely done at that point, so close the browser
// and exit the whole process instead of continuing to poll a dead page
// forever (which used to just spam "other" detections until MAX_IDLE).
async function shutdownAfterSuccess(browser) {
  console.log("\n🏁 Application submitted and confirmation PDF emailed. Closing browser and exiting...\n");
  await browser.close().catch(() => { });
  process.exit(0);
}

async function postSubmitAgent(browser, context, startPage, profile) {
  if (!hasAnyAI) return;
  console.log("🤖 [Post-Submit Agent] Watching for next steps after submission...");

  let lastUrl = startPage.url();
  let lastStepType = await detectStepType(startPage, { debug: true });
  let idleCount = 0;
  const MAX_IDLE = 300; // Keep watching for up to 15 minutes or until browser closes
  const POST_PATTERNS_KEY = "post_submit_flow";

  // Tracks a step we've DETECTED but not yet successfully HANDLED (either
  // replayed from memory, or classified + acted on). This is deliberately
  // separate from lastUrl/lastStepType: those are only for noticing that
  // the page changed, not for recording that we dealt with it.
  //
  // IMPORTANT FIX: postSubmitAgent is invoked immediately after
  // findAndClickSubmit(), which itself already waits ~1.8s post-click for
  // the AJAX swap to happen. That means by the time this function's very
  // first line runs, the page may ALREADY be sitting on the upload /
  // declaration / captcha step -- there was never a "change" for the loop
  // below to detect, because the change happened before we started
  // watching. If pendingStepKey is left null here, the loop's "nothing
  // changed and nothing pending" branch swallows every tick forever and
  // the step is never handled (this was the actual bug: repeated
  // "upload" detections in the log with zero [Image] activity). Seed
  // pendingStepKey from the INITIAL state so the very first loop
  // iteration treats "whatever's already on screen" as pending work,
  // not as an already-handled step.
  const initialPathname = (() => { try { return new URL(lastUrl).pathname; } catch { return lastUrl; } })();
  let pendingStepKey = `${initialPathname}::${lastStepType}`;
  let pendingAttempts = 0;
  const MAX_PENDING_ATTEMPTS = 6; // ~18s of retries before giving up on a step

  while (idleCount < MAX_IDLE) {
    await new Promise(r => setTimeout(r, 3000));
    if (browser.isConnected() === false) break;

    const pages = context.pages().filter(p => !p.isClosed());
    if (!pages.length) break;
    const page = pages[pages.length - 1];

    const curUrl = page.url();
    const curStepType = await detectStepType(page, { debug: true });
    const pathname = new URL(curUrl).pathname;
    const stepKey = `${pathname}::${curStepType}`;

    // A "new step" is either a real URL navigation OR the in-place content
    // changing to a different recognizable step (e.g. main_form -> upload)
    // even though the URL stayed identical.
    const isNewStep = curUrl !== lastUrl || curStepType !== lastStepType;
    if (isNewStep) {
      lastUrl = curUrl;
      lastStepType = curStepType;
      pendingStepKey = stepKey;
      pendingAttempts = 0;
    }

    // Nothing changed AND there's no unfinished step waiting to be handled
    // -- genuinely idle, keep waiting.
    if (!isNewStep && pendingStepKey === null) { idleCount++; continue; }

    // Guard: Do NOT touch or re-evaluate while the main form is still open in the browser!
    if (curStepType === "main_form") {
      idleCount++;
      continue;
    }

    if (pendingStepKey !== stepKey) {
      // We have a pending step for a DIFFERENT key than what's on screen
      // now (shouldn't normally happen since isNewStep would have reset
      // it), but guard against acting on stale state.
      pendingStepKey = stepKey;
      pendingAttempts = 0;
    }

    if (pendingAttempts >= MAX_PENDING_ATTEMPTS) {
      // Gave this step several tries already -- stop hammering it
      // automatically, but keep watching in case the user intervenes
      // manually and the page moves on to something new.
      idleCount++;
      continue;
    }

    idleCount = 0;
    pendingAttempts++;
    console.log(`📍 [Post-Submit] Handling step (attempt ${pendingAttempts}/${MAX_PENDING_ATTEMPTS}, ${curStepType}): ${curUrl}`);

    // ── DETERMINISTIC FAST PATH: known Teletalk photo/signature + declaration page ──
    // If this step has file inputs, handle it directly and deterministically
    // (known #photo / #signature IDs, confirmed present on the real form)
    // instead of waiting on the AI classifier. This is both faster and more
    // reliable than the "image_upload" branch below, which depends on the
    // AI correctly guessing selectors from a screenshot.
    if (curStepType === "upload") {
      console.log("📸 [Post-Submit] Upload step detected — filling photo/signature directly...");
      await handleImageUpload(page, [], profile);
      await tickAllCheckboxes(page);
      await tickDeclarationCheckbox(page);
      const clicked = await findAndClickSubmit(page).catch(() => false);
      if (!clicked) {
        // Fall back to a plain click on whatever submit control is there,
        // in case findAndClickSubmit's stricter polling didn't find it.
        await page.locator("input[type=submit], button[type=submit], #submit").first().click({ force: true }).catch(() => { });
      }
      pendingStepKey = null; // handled
      if (isFinalConfirmationUrl(page.url())) {
        await downloadAndEmailPdf(page, profile).catch(() => { });
        return await shutdownAfterSuccess(browser);
      }
      continue;
    }

    // Check learned patterns for this URL + step type combo (the step type
    // is part of the key because the same URL can host multiple distinct
    // AJAX-swapped steps). Fall back to the older bare-pathname key too, so
    // patterns saved before this step-type change still replay correctly.
    const allPats = await loadPatterns();
    const host = await getPageHost(page);
    const postFlow = allPats[host]?.[POST_PATTERNS_KEY] || {};
    const urlKey = `${pathname}::${curStepType}`;
    const savedSteps = postFlow[urlKey] || postFlow[pathname];
    if (savedSteps) {
      console.log(`[⚡ Memory] Replaying saved steps for ${postFlow[urlKey] ? urlKey : pathname}`);
      const reachedFinal = await replayPostSteps(page, savedSteps, profile);
      pendingStepKey = null; // handled
      if (reachedFinal) return await shutdownAfterSuccess(browser);
      continue;
    }

    // Ask AI what this page requires
    const screenshot = await page.screenshot({ type: "png" }).catch(() => null);
    if (!screenshot) continue; // pendingStepKey stays set -- retry next tick

    const decision = await geminiDecidePage(screenshot.toString("base64"), profile);
    if (!decision) {
      console.log(`[Post-Submit AI] ⚠️ Couldn't classify this page (attempt ${pendingAttempts}/${MAX_PENDING_ATTEMPTS}) -- every AI provider may be failing right now. Will retry.`);
      continue; // pendingStepKey stays set -- retry next tick, don't give up silently
    }

    console.log(`[Post-Submit AI] 🤔 Detected: ${decision.type} — ${decision.reason || ""}`);
    pendingStepKey = null; // we got a real decision -- consider this step handled from here on

    const stepsToSave = [];

    if (decision.type === "success") {
      console.log(`🎉 [SUCCESS] ${decision.message || "Application submitted successfully!"}`);
      // Check for download button on success/confirmation pages
      await downloadAndEmailPdf(page, profile).catch(() => { });
      return await shutdownAfterSuccess(browser);
    } else if (decision.type === "image_upload") {
      await handleImageUpload(page, decision.fields || [], profile);
      stepsToSave.push({ action: "image_upload", fields: decision.fields });
      // tick any checkboxes and submit
      await tickAllCheckboxes(page);
      stepsToSave.push({ action: "tick_checkboxes" });
      await page.locator(decision.submit_selector || "input[type=submit], button[type=submit]").first().click({ force: true }).catch(() => { });
      stepsToSave.push({ action: "click", selector: decision.submit_selector || "input[type=submit]" });
    } else if (decision.type === "checkboxes_and_submit") {
      await tickAllCheckboxes(page);
      stepsToSave.push({ action: "tick_checkboxes" });
      await page.locator(decision.submit_selector || "input[type=submit], button[type=submit]").first().click({ force: true }).catch(() => { });
      stepsToSave.push({ action: "click", selector: decision.submit_selector || "input[type=submit]" });
    } else if (decision.type === "new_form") {
      console.log(`📝 [Post-Submit] New form detected — filling with profile data...`);
      await fillMainForm(page, profile);
      await scanAndFillUnknownFields(page, profile);
      await tickAllCheckboxes(page);
      stepsToSave.push({ action: "fill_form" });
    } else if (decision.type === "click") {
      await page.locator(decision.selector).first().click({ force: true }).catch(() => { });
      stepsToSave.push({ action: "click", selector: decision.selector });
    } else if (decision.type === "confirm_dialog") {
      // Handle browser confirm() dialogs
      page.on("dialog", async (dialog) => { await dialog.accept(); });
      stepsToSave.push({ action: "accept_dialog" });
    }

    // Save steps for this URL path
    if (stepsToSave.length > 0) {
      const updPats = await loadPatterns();
      if (!updPats[host]) updPats[host] = {};
      if (!updPats[host][POST_PATTERNS_KEY]) updPats[host][POST_PATTERNS_KEY] = {};
      updPats[host][POST_PATTERNS_KEY][urlKey] = stepsToSave;
      await fs.mkdir(path.join(__dirname, "..", "data"), { recursive: true }).catch(() => { });
      await fs.writeFile(PATTERNS_PATH, JSON.stringify(updPats, null, 2));
      console.log(`[💾 Memory] Saved post-submit steps for ${urlKey}`);
    }

    // Only download/email once we're actually on the final confirmation
    // page -- NOT on every intermediate post-submit page (e.g. Teletalk's
    // "preview.php" review step is not proof of a completed application,
    // and emailing a PDF snapshot of it just creates a confusing duplicate
    // email). This is a heuristic on the URL; if a portal doesn't match
    // any of these patterns, we fall back to only emailing when the AI
    // post-submit classifier explicitly says "success".
    if (isFinalConfirmationUrl(curUrl)) {
      await downloadAndEmailPdf(page, profile).catch(() => { });
      return await shutdownAfterSuccess(browser);
    } else {
      console.log(`[Post-Submit] ⏭️  Not a final confirmation page (${curUrl}) — skipping PDF email for now.`);
    }
  }

  console.log("[🤖 Post-Submit Agent] Monitoring complete.");
}

async function replayPostSteps(page, steps, profile) {
  for (const step of steps) {
    if (step.action === "image_upload") {
      await handleImageUpload(page, step.fields || [], profile);
      await page.waitForTimeout(600);
      await tickAllCheckboxes(page);
    } else if (step.action === "tick_checkboxes") {
      await tickAllCheckboxes(page);
    } else if (step.action === "click") {
      await tickAllCheckboxes(page);
      await page.locator(step.selector).first().click({ force: true }).catch(() => { });
    } else if (step.action === "fill_form") {
      await fillMainForm(page, profile);
      await tickAllCheckboxes(page);
    } else if (step.action === "accept_dialog") {
      page.on("dialog", async d => { await d.accept(); });
    }
    await page.waitForTimeout(1500).catch(() => { });
  }
  // Only email once replay has landed on the real final confirmation page
  // (see isFinalConfirmationUrl) -- same reasoning as in postSubmitAgent.
  // Returns true when it did, so the caller knows the run is genuinely
  // finished and can shut everything down instead of continuing to watch.
  if (isFinalConfirmationUrl(page.url())) {
    await downloadAndEmailPdf(page, profile).catch(() => { });
    return true;
  } else {
    console.log(`[Post-Submit] ⏭️  Not a final confirmation page (${page.url()}) — skipping PDF email for now.`);
    return false;
  }
}

async function geminiDecidePage(base64Screenshot, profile) {
  const prompt = `You are an autonomous job application agent. The user just submitted a form and landed on a new page.

Look at this screenshot and classify what action is needed.
Respond ONLY with valid JSON:
{"type":"success","message":"..."}
or {"type":"image_upload","fields":[{"selector":"#photo","label":"Photo"},{"selector":"#signature","label":"Signature"}],"submit_selector":"#submit"}
or {"type":"checkboxes_and_submit","submit_selector":"#submit","reason":"..."}
or {"type":"new_form","reason":"..."}
or {"type":"click","selector":"css_selector","reason":"..."}
or {"type":"confirm_dialog","reason":"..."}
or {"type":"wait","reason":"page loading"}`;

  try {
    const raw = await callAIWithFallback(prompt, base64Screenshot);
    if (!raw) return null;
    const cleaned = raw.replace(/^```[\w]*\n?/gm, "").replace(/```$/gm, "").trim();
    return JSON.parse(cleaned);
  } catch { return null; }
}

// Handles the photo/signature upload step. Now checks the known, confirmed
// Teletalk IDs (#photo / #signature) FIRST and deterministically, without
// gating on visibility -- Playwright's setInputFiles() works fine on a
// native file input even when it's visually hidden behind a custom
// "Choose File" button (a very common pattern on these portals). Only
// falls back to generic detection / AI-provided selectors if neither
// #photo nor #signature is present, e.g. on a differently-built portal.
async function handleImageUpload(page, fields, profile) {
  // Check application/ folder first, then fall back to config/
  const photoPath = profile.photo_path
    ? path.resolve(__dirname, "..", profile.photo_path)
    : (await fs.access(path.join(__dirname, "..", "application", "Applicant.jpg")).then(() => path.join(__dirname, "..", "application", "Applicant.jpg")).catch(() => path.join(__dirname, "..", "config", "photo.jpg")));
  const sigPath = profile.signature_path
    ? path.resolve(__dirname, "..", profile.signature_path)
    : (await fs.access(path.join(__dirname, "..", "application", "applicant_signature.jpg")).then(() => path.join(__dirname, "..", "application", "applicant_signature.jpg")).catch(() => path.join(__dirname, "..", "config", "signature.jpg")));

  console.log(`[Image] Looking for uploads. photoPath="${photoPath}" sigPath="${sigPath}"`);

  // 1. Known, stable Teletalk IDs -- try these directly first. No
  // isVisible() gate: setInputFiles works on hidden inputs, and these
  // portals commonly hide the real <input type=file> behind a styled
  // button, which would otherwise cause a false "not found" here.
  const photoInput = page.locator("#photo");
  const sigInput = page.locator("#signature");
  const hasPhotoId = await photoInput.count().catch(() => 0);
  const hasSigId = await sigInput.count().catch(() => 0);
  console.log(`[Image] #photo found: ${hasPhotoId > 0} | #signature found: ${hasSigId > 0}`);
  if (hasPhotoId || hasSigId) {
    if (hasPhotoId) await uploadFile(photoInput, photoPath, "photo");
    if (hasSigId) await uploadFile(sigInput, sigPath, "signature");
    return;
  }

  // 2. Generic fallback: any <input type=file> on the page, regardless of
  // visibility (same reasoning as above -- offsetParent/isVisible checks
  // are unreliable for these hidden-native-input upload widgets).
  const detected = await page.locator("input[type=file]").all().catch(() => []);
  console.log(`[Image] Generic input[type=file] scan found ${detected.length} element(s).`);
  if (detected.length) {
    for (let i = 0; i < detected.length; i++) {
      // If the AI told us the label for the field in this position, trust
      // that for photo-vs-signature; otherwise assume the conventional
      // order (photo first, signature second) seen on every Teletalk form
      // so far.
      const aiHintIsSig = fields && fields[i] && /sign/i.test(fields[i].label || "");
      const isSig = aiHintIsSig || (!(fields && fields.length) && i > 0);
      const filePath = isSig ? sigPath : photoPath;
      await uploadFile(detected[i], filePath, isSig ? "signature" : "photo");
    }
    return;
  }

  if (!fields || !fields.length) {
    console.log("[Image] No file inputs found on this page.");
    return;
  }

  // 3. Last resort: AI's suggested selectors (e.g. a custom upload widget
  // that hides the real <input> under a non-standard structure).
  for (const f of fields) {
    const isSig = /sign/i.test(f.label || "");
    const filePath = isSig ? sigPath : photoPath;
    const input = page.locator(f.selector);
    if (await input.count()) await uploadFile(input, filePath, isSig ? "signature" : "photo");
  }
}

// Teletalk's flow typically has an intermediate REVIEW page (e.g.
// "preview.php") before the actual final confirmation/receipt page (e.g.
// "appcopy.php"). Only the latter is proof the application went through --
// emailing a PDF snapshot of the preview page is premature and just
// generates a confusing duplicate email. This is a heuristic on the URL;
// if a portal doesn't match any of these patterns, we fall back to only
// emailing when the AI post-submit classifier explicitly says "success".
function isFinalConfirmationUrl(url) {
  return /appcopy|application[_-]?copy|admit[_-]?card|success|thank|complete|congrat|confirmation|receipt/i.test(url)
    && !/preview/i.test(url);
}

async function uploadFile(inputLocator, filePath, label) {
  try {
    await fs.access(filePath);
    await inputLocator.setInputFiles(filePath);
    console.log(`📸 [Image] Uploaded ${label}: ${path.basename(filePath)}`);
  } catch {
    console.log(`⚠️  [Image] ${label} file not found at: ${filePath}`);
    console.log(`   ➔ Place your files at:`);
    console.log(`     application/Applicant.jpg         (photo)`);
    console.log(`     application/applicant_signature.jpg (signature)`);
  }
}

// ── EMAIL NOTIFICATION HELPER ───────────────────────────────────────────────────
async function sendVerificationEmail(inferredFields, host) {
  const smtpHost = process.env.SMTP_HOST;
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  const notifyEmail = process.env.NOTIFY_EMAIL;
  if (!smtpHost || !smtpUser || !smtpPass || !notifyEmail) return;

  try {
    const { default: nodemailer } = await import("nodemailer");
    const transporter = nodemailer.createTransport({
      host: smtpHost, port: parseInt(process.env.SMTP_PORT || "587"),
      secure: false,
      auth: { user: smtpUser, pass: smtpPass },
    });

    const rows = inferredFields.map(f => {
      const val = f.action === "select" ? f.option : f.value;
      return `<tr><td style="padding:8px 12px;border-bottom:1px solid #eee;color:#555">${f.label || f.selector}</td><td style="padding:8px 12px;border-bottom:1px solid #eee;font-weight:bold;color:#1a1a2e">${val}</td></tr>`;
    }).join("");

    await transporter.sendMail({
      from: process.env.SMTP_FROM || smtpUser,
      to: notifyEmail,
      subject: `🤖 AI Inferred Form Fields — ${host}`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:auto">
          <div style="background:#1a1a2e;color:#fff;padding:20px 24px;border-radius:8px 8px 0 0">
            <h2 style="margin:0">🤖 AI Auto-Filled Unknown Fields</h2>
            <p style="margin:6px 0 0;opacity:.7">Portal: ${host}</p>
          </div>
          <div style="background:#fff;border:1px solid #e5e7eb;border-top:none;padding:20px 24px;border-radius:0 0 8px 8px">
            <p style="color:#555">These fields were <strong>not in your profile.json</strong> so AI inferred the values. They have been applied automatically. If any are wrong, update <code>data/field-patterns.json</code> to correct them for future runs.</p>
            <table style="width:100%;border-collapse:collapse;margin-top:12px">
              <thead><tr style="background:#f3f4f6"><th style="padding:8px 12px;text-align:left">Field</th><th style="padding:8px 12px;text-align:left">Value Applied</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
            <p style="margin-top:20px;font-size:13px;color:#888">To correct a value permanently, open <code>data/field-patterns.json</code> and update the <code>learned_values</code> for <em>${host}</em>.</p>
          </div>
        </div>`
    });
    console.log(`📧 [Email] Verification email sent to ${notifyEmail} with ${inferredFields.length} inferred field(s).`);
  } catch (e) {
    console.log(`[Email] Could not send verification email: ${e.message}`);
  }
}

// ── PDF DOWNLOAD + EMAIL ───────────────────────────────────────────────────
// On Teletalk confirmation pages (appcopy.php), the "Download" button fires
// window.print() rather than a file download event. So we:
//  1. Try the real download event (works if Teletalk actually serves a file).
//  2. Fall back to page.pdf() (Playwright's headless print) which gives the
//     same rendered output as clicking the browser's Print > Save as PDF.
async function downloadAndEmailPdf(page, profile) {
  try {
    const dlDir = path.join(__dirname, "..", "data", "downloads");
    await fs.mkdir(dlDir, { recursive: true }).catch(() => { });

    const btn = page.locator("#download, button#download, button:has-text('Download'), a[href*='download'], input[value*='Download'], button.btn-primary:has-text('Download')").first();
    const hasDl = await btn.count().catch(() => 0);

    let savePath = null;
    let suggestedName = null;

    if (hasDl) {
      console.log("\ud83d\udce5 [PDF] Download button found — trying file download...");
      try {
        // Try real download event with short timeout (5s)
        const dlEvent = page.waitForEvent("download", { timeout: 5000 });
        await btn.click({ force: true }).catch(() => { });
        const download = await dlEvent;
        suggestedName = download.suggestedFilename() || `application_${Date.now()}.pdf`;
        savePath = path.join(dlDir, suggestedName);
        await download.saveAs(savePath);
        console.log(`\ud83d\udcce [PDF] Downloaded: ${suggestedName}`);
      } catch (_) {
        // Download event didn't fire (likely window.print()) — fall through to page.pdf()
      }
    }

    // Fallback: render the current page as PDF (captures confirmation/applicant copy page)
    if (!savePath) {
      console.log("\ud83d\udda8\ufe0f [PDF] Saving page as PDF (print-to-PDF)...");
      try {
        suggestedName = `application_${Date.now()}.pdf`;
        savePath = path.join(dlDir, suggestedName);
        await page.pdf({ path: savePath, format: "A4", printBackground: true });
        console.log(`\ud83d\udcce [PDF] Saved: ${suggestedName}`);
      } catch (e) {
        console.log(`[PDF] page.pdf() failed: ${e.message}`);
        return;
      }
    }

    // Email the PDF
    await emailPdfAttachment(savePath, suggestedName, profile).catch(e =>
      console.log(`[Email] PDF email failed: ${e.message}`)
    );

  } catch (e) {
    console.log(`[PDF] Download failed: ${e.message}`);
  }
}

// ── RECIPIENT-CORRECT PDF EMAIL ─────────────────────────────────────────────
// The mailbox that SENDS this (SMTP_HOST/SMTP_USER/SMTP_PASS, i.e. your
// notification account) is deliberately different from the mailbox that
// should RECEIVE the finished application PDF (the applicant's own email
// from profile.json). This function makes sure "To" is always the real
// recipient and never silently falls back to the sending/notify account:
//   - profile.email present  -> To: profile.email   (Cc: NOTIFY_EMAIL if set & different)
//   - profile.email missing  -> To: NOTIFY_EMAIL (only as a last-resort fallback, logged loudly)
async function emailPdfAttachment(pdfPath, filename, profile) {
  const smtpHost = process.env.SMTP_HOST;
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  if (!smtpHost || !smtpUser || !smtpPass) return;

  const applicantEmail = (profile?.email || "").trim();
  const notifyEmail = (process.env.NOTIFY_EMAIL || "").trim();

  let toList = [];
  let ccList = [];

  if (applicantEmail) {
    // Normal case: send the PDF to the applicant. CC the notify address too,
    // as long as it isn't the same address (avoids duplicate recipients).
    toList = [applicantEmail];
    if (notifyEmail && notifyEmail.toLowerCase() !== applicantEmail.toLowerCase()) {
      ccList = [notifyEmail];
    }
  } else if (notifyEmail) {
    // No applicant email in profile.json — fall back to NOTIFY_EMAIL as the
    // "To" (not silently dropped into Cc, which some SMTP servers mishandle
    // when To is empty). Logged clearly so it's obvious this is a fallback.
    console.log(`[Email] ⚠️  profile.email is empty — falling back to NOTIFY_EMAIL ("${notifyEmail}") as recipient. Add "email" to config/profile.json to send the PDF to the applicant directly.`);
    toList = [notifyEmail];
  } else {
    console.log("[Email] No recipient email configured (profile.email and NOTIFY_EMAIL are both empty). Skipping PDF email.");
    return;
  }

  const { default: nodemailer } = await import("nodemailer");
  const transporter = nodemailer.createTransport({
    host: smtpHost, port: parseInt(process.env.SMTP_PORT || "587"),
    secure: false, auth: { user: smtpUser, pass: smtpPass }
  });

  const applicantName = profile?.name_en || "Applicant";
  const toStr = toList.join(", ");
  const ccStr = ccList.join(", ");

  await transporter.sendMail({
    from: process.env.SMTP_FROM || smtpUser,
    to: toStr,
    cc: ccStr || undefined,
    subject: `🎉 Application Submitted — ${applicantName} (PDF Attached)`,
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:auto">
        <div style="background:#16a34a;color:#fff;padding:20px 24px;border-radius:8px 8px 0 0">
          <h2 style="margin:0">🎉 Application Successfully Submitted!</h2>
        </div>
        <div style="background:#fff;border:1px solid #e5e7eb;border-top:none;padding:20px 24px;border-radius:0 0 8px 8px">
          <p style="color:#555">The job application for <strong>${applicantName}</strong> has been submitted successfully.</p>
          <p style="color:#555">The application PDF is attached to this email for your records.</p>
        </div>
      </div>`,
    attachments: [{ filename, path: pdfPath, contentType: "application/pdf" }]
  });
  console.log(`📧 [Email] Application PDF sent — To: ${toStr}${ccStr ? " | Cc: " + ccStr : ""} (From: ${process.env.SMTP_FROM || smtpUser})`);
}

async function fillMainForm(page, profile) {
  // --- Basic Information ---
  await fillText(page, "#name", profile.name_en);
  await fillText(page, "#name_bn", profile.name_bn);

  await fillText(page, "#father", profile.father_en);
  await fillText(page, "#father_bn", profile.father_bn);
  await fillText(page, "#mother", profile.mother_en);
  await fillText(page, "#mother_bn", profile.mother_bn);
  await fillText(page, "#dob", profile.dob);

  await selectFuzzy(page, "#nationality", profile.nationality);
  await selectFuzzy(page, "#religion", profile.religion);
  await selectFuzzy(page, "#gender", profile.gender);

  await fillRevealedIdField(page, "#nid", "#nid_no", profile.national_id);
  await fillRevealedIdField(page, "#breg", "#breg_no", profile.birth_registration);
  await fillRevealedIdField(page, "#passport", "#passport_no", profile.passport_id);

  await selectFuzzy(page, "#marital_status", profile.marital_status);

  await fillText(page, "#mobile", profile.mobile);
  await fillText(page, "#confirm_mobile", profile.mobile);
  await fillText(page, "#email", profile.email);

  await selectFuzzy(page, "#quota", profile.quota);
  await selectFuzzy(page, "#dep_status", profile.departmental_status);

  // --- Addresses ---
  await fillAddressBlock(page, "present", profile.present_address);
  await fillAddressBlock(page, "permanent", profile.permanent_address);

  // --- Education ---
  await fillLevelWithGroup(page, "ssc", profile.ssc);
  await fillLevelWithGroup(page, "hsc", profile.hsc);
  await fillGraduation(page, profile.graduation);

  // Masters and Job Experience are left alone (checkboxes default off) --
  // add profile.masters / profile.experience later if you need them filled.
}

// --- Basic Information helpers ---

// Fields like National ID / Birth Registration / Passport are a Yes/No
// select that reveals a hidden number input once "Yes" is chosen.
async function fillRevealedIdField(page, selectSel, inputSel, value) {
  const select = page.locator(selectSel);
  if (!(await select.count())) return;

  const strVal = value !== undefined && value !== null ? String(value).trim() : "";
  const hasValue = strVal !== "" && !/^(no|na|none|0|false)$/i.test(strVal);

  await select.evaluate((el, isYes) => {
    let chosen = -1;
    for (let i = 0; i < el.options.length; i++) {
      const opt = el.options[i];
      const txt = (opt.text || "").trim().toLowerCase();
      const val = (opt.value || "").trim().toLowerCase();
      if (isYes) {
        if (txt === "yes" || val === "yes" || val === "1" || txt.includes("yes") || txt.includes("হ্যাঁ") || val === "y") {
          chosen = i;
          break;
        }
      } else {
        if (txt === "no" || val === "no" || val === "0" || val === "2" || val === "na" || txt.includes("no") || txt.includes("না") || val === "n") {
          chosen = i;
          break;
        }
      }
    }
    if (chosen !== -1) {
      el.selectedIndex = chosen;
      el.value = el.options[chosen].value;
      if (typeof el.onchange === "function") { try { el.onchange(); } catch (e) { } }
      if (typeof window.onChangePassport === "function") { try { window.onChangePassport(el); } catch (e) { } }
      if (typeof window.onChangeNid === "function") { try { window.onChangeNid(el); } catch (e) { } }
      if (typeof window.onChangeBreg === "function") { try { window.onChangeBreg(el); } catch (e) { } }
      if (typeof window.onChangeIdExp === "function") { try { window.onChangeIdExp(el, el.value); } catch (e) { } }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }, hasValue).catch(() => { });

  if (!hasValue) {
    const input = page.locator(inputSel);
    if (await input.count().catch(() => 0)) {
      await input.fill("").catch(() => { });
    }
    return;
  }

  const input = page.locator(inputSel);
  await input.waitFor({ state: "visible", timeout: 5000 }).catch(() => { });
  await input.fill(strVal).catch(() => { });
  await input.evaluate((el, val) => {
    el.value = val;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, strVal).catch(() => { });
}

// --- Address helpers ---

async function fillAddressBlock(page, prefix, address) {
  if (!address) return;
  await fillText(page, `#${prefix}_careof`, address.care_of);
  await fillText(page, `#${prefix}_village`, address.village_road_house);
  await fillText(page, `#${prefix}_post`, address.post_office);
  await fillText(page, `#${prefix}_postcode`, address.post_code);

  const districtSel = `#${prefix}_district`;
  const upazilaSel = `#${prefix}_upazila`;
  const districtOk = await selectFuzzy(page, districtSel, address.district);
  if (districtOk) {
    await waitForOptions(page, upazilaSel, 2, 8000);
    await selectFuzzy(page, upazilaSel, address.upazila);
  }
}

// --- Education helpers ---

// SSC/HSC share the same shape: Examination, Roll, Group (populated after
// Examination is chosen), Board, Result type + numeric result, Passing Year.
async function fillLevelWithGroup(page, prefix, level) {
  if (!level) return;
  const examSel = `#${prefix}_exam`;
  const groupSel = `#${prefix}_group`;
  const boardSel = `#${prefix}_board`;

  const examOk = await selectFuzzy(page, examSel, level.examination);
  // Board can be set immediately without waiting for exam AJAX (it's static)
  await selectFuzzy(page, boardSel, level.board);
  // Group depends on exam – wait for options, but only up to 4s
  if (examOk) await waitForOptions(page, groupSel, 2, 4000);
  await selectFuzzy(page, groupSel, level.group);

  await fillText(page, `#${prefix}_roll`, level.roll);
  await fillResultType(page, prefix, level, /^gpa$/i, "GPA");
  await selectFuzzy(page, `#${prefix}_year`, level.year);
}

async function fillGraduation(page, grad) {
  if (!grad) return;

  // 1. Enable the Graduation "If Applicable" checkbox if it exists
  //    The checkbox ID varies by employer; try common Teletalk patterns.
  const gradCbSel = [
    "input[type=checkbox]#gra_applicable",
    "input[type=checkbox][name*='gra_app']",
    "input[type=checkbox][name*='chk_gra']",
    "input[type=checkbox][id*='gra']"
  ].join(", ");
  const gradCbs = await page.locator(gradCbSel).all().catch(() => []);
  for (const cb of gradCbs) {
    if (!(await cb.isVisible().catch(() => false))) continue;
    await cb.evaluate(el => {
      el.checked = true;
      if (typeof el.onclick === "function") { try { el.onclick(); } catch (e) { } }
      if (typeof el.onchange === "function") { try { el.onchange(); } catch (e) { } }
      el.dispatchEvent(new Event("click", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }).catch(() => { });
    await cb.check({ force: true }).catch(() => { });
    await page.waitForTimeout(300);
    break;
  }

  // 2. Examination type (B.Sc Engineering etc) - triggers AJAX for institute list
  const examOk = await selectFuzzy(page, "#gra_exam", grad.examination);

  // 3. Institute - triggers AJAX for subject list; wait max 4 seconds
  const instituteOk = await selectFuzzy(page, "#gra_institute", grad.institute);
  if (instituteOk) await waitForOptions(page, "#gra_subject", 2, 4000);

  // 4. Subject/Degree
  await selectFuzzy(page, "#gra_subject", grad.subject);

  // 5. Year & Duration (static dropdowns, no AJAX dep)
  await selectFuzzy(page, "#gra_year", grad.year);
  // Duration: try "04 Years", "4 Years", "4" etc.
  const durStr = String(grad.duration).replace(/^0+/, "");
  const durOk = await selectFuzzy(page, "#gra_duration", `${grad.duration} Years`) ||
    await selectFuzzy(page, "#gra_duration", `${durStr} Years`) ||
    await selectFuzzy(page, "#gra_duration", durStr);

  // 6. Result type & CGPA
  await fillResultType(page, "gra", grad, /^cgpa$/i, "CGPA");
}

// Result-type selects (ssc_result_type / hsc_result_type / gra_result_type)
// reveal a hidden numeric input once a GPA/CGPA option is chosen. `kind`
// distinguishes "GPA" vs "CGPA" wording; `scale` (default 5 for SSC/HSC, 4
// for graduation) picks "(out of N)".
async function fillResultType(page, prefix, level, resultKeywordRe, kind) {
  if (!level || !resultKeywordRe.test(level.result || "")) return;
  const scale = level.scale || (kind === "CGPA" ? "4" : "5");
  const wanted = `${kind}(out of ${scale})`;

  const typeSel = `#${prefix}_result_type`;
  const ok = await selectFuzzy(page, typeSel, wanted);
  if (!ok) return;

  const numberSel = `#${prefix}_result`;
  const input = page.locator(numberSel);
  await input.waitFor({ state: "visible", timeout: 5000 }).catch(() => { });
  await input.fill(String(level.gpa)).catch(() => { });
}

// ── PATTERN MEMORY SYSTEM ───────────────────────────────────────────────────
// Persists how AI solved each field to data/field-patterns.json.
// On subsequent runs the saved solution is applied instantly — no AI call needed.

async function loadPatterns() {
  try {
    const raw = await fs.readFile(PATTERNS_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function savePattern(host, fieldKey, pattern) {
  const all = await loadPatterns();
  if (!all[host]) all[host] = {};
  all[host][fieldKey] = pattern;
  await fs.mkdir(path.join(__dirname, "..", "data"), { recursive: true }).catch(() => { });
  await fs.writeFile(PATTERNS_PATH, JSON.stringify(all, null, 2));
  console.log(`[Memory] 💾 Saved pattern for "${fieldKey}" on ${host}`);
}

async function getPageHost(page) {
  try { return new URL(page.url()).hostname; } catch { return "unknown"; }
}

// Asks Gemini Vision to figure out how to fill a specific field when
// the normal selector/value approach fails or finds no match.
async function aiFixField(page, fieldKey, value, hint) {
  if (!GEMINI_API_KEY && !OPENROUTER_API_KEY && !GROQ_API_KEY && !(CF_ACCOUNT_ID && CF_API_TOKEN)) return null;
  console.log(`[AI] 🤔 Field "${fieldKey}" failed normally — trying AI fallback...`);

  let screenshot;
  try { screenshot = await page.screenshot({ type: "png", fullPage: false }); }
  catch { return null; }

  const prompt = `You are helping fill a Bangladeshi government job application form.
Field to fill: "${fieldKey}"
Value to use: "${value}"
${hint ? `Problem: ${hint}` : ""}

Look at the screenshot and return the EXACT action needed to fill this field.
Respond ONLY with valid JSON (no markdown):
{"action":"fill","selector":"css_selector","reason":"..."}
or {"action":"select","selector":"css_selector","option":"exact option text","reason":"..."}
or {"action":"type","selector":"css_selector","reason":"..."}
or {"action":"skip","reason":"field not on this page"}`;

  try {
    const raw = await callAIWithFallback(prompt, screenshot.toString("base64"));
    if (!raw) return null;
    const cleaned = raw.replace(/^```[\w]*\n?/gm, "").replace(/```$/gm, "").trim();
    return JSON.parse(cleaned);
  } catch { return null; }
}

// ── SMART FILL (text input) ──────────────────────────────────────────────────
// Fills a text input. Uses direct Playwright fill for known selectors.
// Only falls back to AI if the selector literally doesn't exist on the page.
async function fillText(page, selector, value, fieldKey) {
  if (value === undefined || value === null || value === "") return;

  // 1. Direct fast-path: standard Teletalk IDs always exist — fill immediately
  const el = page.locator(selector);
  if (await el.count().catch(() => 0)) {
    await el.click({ force: true }).catch(() => { });
    await el.fill(String(value)).catch(() => { });
    await el.evaluate((e, v) => {
      e.value = v;
      e.dispatchEvent(new Event("input", { bubbles: true }));
      e.dispatchEvent(new Event("change", { bubbles: true }));
    }, String(value)).catch(() => { });
    return;
  }

  // 2. Memory check for non-standard selectors
  const host = await getPageHost(page);
  const key = fieldKey || selector;
  const patterns = await loadPatterns();
  const mem = patterns[host]?.[key];
  if (mem && mem.action === "fill") {
    await page.locator(mem.selector).fill(String(value)).catch(() => { });
    return;
  }
  if (mem && mem.action === "type") {
    const mel = page.locator(mem.selector);
    await mel.click().catch(() => { });
    await mel.selectText().catch(() => { });
    await page.keyboard.type(String(value), { delay: 40 }).catch(() => { });
    return;
  }

  // 3. AI fallback (only if selector not found at all)
  const fix = await aiFixField(page, key, String(value), `Selector "${selector}" not found`);
  if (!fix || fix.action === "skip") return;
  if (fix.action === "fill") {
    await page.locator(fix.selector).fill(String(value)).catch(() => { });
    await savePattern(host, key, { action: "fill", selector: fix.selector });
  } else if (fix.action === "type") {
    const el2 = page.locator(fix.selector);
    await el2.click().catch(() => { });
    await el2.selectText().catch(() => { });
    await page.keyboard.type(String(value), { delay: 40 }).catch(() => { });
    await savePattern(host, key, { action: "type", selector: fix.selector });
  }
}

// ── SMART SELECT (dropdown) ──────────────────────────────────────────────────
// Checks memory → fuzzy match → AI fallback → saves pattern.
// Selects an option by fuzzy text match: strips everything but letters and
// digits before comparing, so "S.S.C" matches "SSC", "Dhaka" matches "Dhaka ", etc.
async function selectFuzzy(page, selector, wanted, fieldKey) {
  if (wanted === undefined || wanted === null || String(wanted).trim() === "") return false;
  const host = await getPageHost(page);
  const key = fieldKey || selector;

  // 1. Check memory for a previously AI-solved option
  const patterns = await loadPatterns();
  const mem = patterns[host]?.[key];
  if (mem && mem.action === "select") {
    const ok = await page.locator(mem.selector).selectOption({ label: mem.option }).then(() => true).catch(() => false);
    if (ok) return true;
  }

  // 2. Normal fuzzy match
  const select = page.locator(selector);
  if (!(await select.count())) {
    // selector not found — try AI
    const fix = await aiFixField(page, key, String(wanted), `Select "${selector}" not present`);
    if (!fix || fix.action === "skip") return false;
    if (fix.action === "select") {
      const ok = await page.locator(fix.selector).selectOption({ label: fix.option }).then(() => true).catch(() => false);
      if (ok) await savePattern(host, key, { action: "select", selector: fix.selector, option: fix.option });
      return ok;
    }
    return false;
  }

  const options = await select.locator("option").allTextContents();
  const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const target = normalize(String(wanted));

  // Synonym dictionary for Bangladeshi Teletalk forms
  const synonyms = {
    "notapplicable": ["nonquota", "none", "no", "general", "na", "nil"],
    "nonquota": ["general", "none", "notapplicable", "no", "na", "nil"],
    "none": ["no", "notapplicable", "na", "nil", "nonquota", "general"],
    "single": ["unmarried"],
    "unmarried": ["single"],
    "married": ["married"],
    "male": ["m"],
    "female": ["f"],
    "islam": ["muslim", "islamic"],
    "bangladeshi": ["bangladesh", "bd"]
  };

  const targetsToTry = [target, ...(synonyms[target] || [])];

  let match = null;
  for (const t of targetsToTry) {
    match = options.find((o) => normalize(o) === t);
    if (!match) match = options.find((o) => normalize(o).includes(t) && t.length > 2);
    if (!match) match = options.find((o) => t.includes(normalize(o)) && normalize(o).length > 2);
    if (match) break;
  }

  if (match) {
    await select.selectOption({ label: match }).catch(() => { });
    await select.evaluate(el => {
      if (typeof el.onchange === "function") { try { el.onchange(); } catch (e) { } }
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }).catch(() => { });
    return true;
  }

  // 3. No fuzzy match — AI fallback
  const allOpts = options.join(" | ");
  const fix = await aiFixField(page, key, String(wanted),
    `Dropdown "${selector}" has no match for "${wanted}". Available options: ${allOpts.slice(0, 300)}`);
  if (!fix || fix.action === "skip") return false;
  if (fix.action === "select") {
    const ok = await page.locator(fix.selector || selector).selectOption({ label: fix.option }).then(() => true).catch(() => false);
    if (ok) await savePattern(host, key, { action: "select", selector: fix.selector || selector, option: fix.option });
    return ok;
  }
  return false;
}

// Waits for a <select> to have at least `minCount` options -- used for
// dropdowns populated by AJAX after a parent field changes (District ->
// Upazila, Institute -> Subject, Examination -> Group).
async function waitForOptions(page, selector, minCount, timeout) {
  const select = page.locator(selector);
  // Fast path: check immediately
  try {
    const count = await select.locator("option").count();
    if (count >= minCount) return;
  } catch (_) { }
  // Polling with reduced timeout
  const cappedTimeout = Math.min(timeout, 4000);
  const deadline = Date.now() + cappedTimeout;
  while (Date.now() < deadline) {
    try {
      const n = await select.locator("option").count();
      if (n >= minCount) return;
    } catch (_) { break; }
    await new Promise(r => setTimeout(r, 250));
  }
}


main().catch((err) => {
  console.error(err);
  process.exit(1);
});
