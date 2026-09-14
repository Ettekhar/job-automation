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

// ── HOISTED TO MODULE SCOPE ──────────────────────────────────────────────
// ── SERVER DEPLOYMENT: always headless ───────────────────────────────────
// Forced to `true` unconditionally -- no local desktop/display is
// attached on the server, so a visible browser window can never be
// shown there anyway. The old `--headed` flag is intentionally ignored
// now (see main(), where isHeadless is reassigned) so nothing can
// accidentally try to pop a window on a machine with no display.
let isHeadless = true;
let selectedPostLabel = "";

// ── Multi-provider AI cascade (Gemini → Groq → Cloudflare → OpenRouter) ──
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID || "";
const CF_API_TOKEN = process.env.CF_API_TOKEN || "";

const hasAnyAI = Boolean(
  (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim()) ||
  (process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_API_KEY.trim()) ||
  (process.env.GROQ_API_KEY && process.env.GROQ_API_KEY.trim()) ||
  (process.env.CF_ACCOUNT_ID && process.env.CF_API_TOKEN),
);

async function loadProfile() {
  try {
    const raw = await fs.readFile(PROFILE_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    console.error(
      "Couldn't find config/profile.json. Copy config/profile.example.json to " +
        "config/profile.json and fill in your real details first.",
    );
    process.exit(1);
  }
}

async function resolveUploadFilePath(profile, kind) {
  const overrideKey = kind === "photo" ? "photo_path" : "signature_path";
  if (profile[overrideKey]) {
    return path.resolve(__dirname, "..", profile[overrideKey]);
  }
  const primaryName =
    kind === "photo" ? "Applicant.jpg" : "applicant_signature.jpg";
  const primaryPath = path.join(__dirname, "..", "application", primaryName);
  const exists = await fs
    .access(primaryPath)
    .then(() => true)
    .catch(() => false);
  if (exists) return primaryPath;
  const fallbackName = kind === "photo" ? "photo.jpg" : "signature.jpg";
  return path.join(__dirname, "..", "config", fallbackName);
}

async function preflightCheckUploadFiles(profile) {
  const photoPath = await resolveUploadFilePath(profile, "photo");
  const sigPath = await resolveUploadFilePath(profile, "signature");
  const photoExists = await fs
    .access(photoPath)
    .then(() => true)
    .catch(() => false);
  const sigExists = await fs
    .access(sigPath)
    .then(() => true)
    .catch(() => false);

  console.log(
    "\n📋 [Preflight] Checking photo/signature files in this environment...",
  );
  console.log(
    `   Photo:     ${photoPath}  ${photoExists ? "✅ found" : "❌ MISSING"}`,
  );
  console.log(
    `   Signature: ${sigPath}  ${sigExists ? "✅ found" : "❌ MISSING"}`,
  );

  if (!photoExists || !sigExists) {
    console.log("");
    console.log(
      "⚠️  [Preflight] One or both files are missing HERE, in the environment actually",
    );
    console.log(
      "    running this script. If you already have these files on your own machine,",
    );
    console.log(
      "    that alone isn't enough -- they need to be copied into wherever this script",
    );
    console.log(
      "    is actually executing (baked into the Docker image, uploaded to the server,",
    );
    console.log(
      "    committed if not .gitignore'd, etc). Continuing anyway -- the form will get",
    );
    console.log(
      "    stuck on the upload step later if these aren't fixed before then.",
    );
  }
  console.log("");
}

async function main() {
  const profile = await loadProfile();
  await preflightCheckUploadFiles(profile);

  // Always headless on the server -- ignore --headed entirely (see the
  // module-scope declaration above for why).
  isHeadless = true;
  console.log(`🚀 Launching Playwright Chromium (headless: ${isHeadless})...`);
  const browser = await chromium.launch({
    headless: isHeadless,
    args: [
      // Forces Chrome's newer headless mode explicitly. The OLD headless
      // mode (Chromium's original --headless flag) can still briefly
      // flash a console/terminal-looking window on Windows even with
      // headless:true. The new mode ("--headless=new") runs as a true
      // headless process with no window of any kind, so this stops that
      // flash entirely. Safe to pass even on Linux/Mac servers -- it's a
      // no-op improvement there since they never had this issue.
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-blink-features=AutomationControlled",
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();

  if (startUrl) {
    console.log(`🌐 Navigating to: ${startUrl}`);
    await page.goto(startUrl).catch((e) => {
      console.log(`Page load note: ${e.message}`);
    });
  }

  try {
    await page.bringToFront();
  } catch (_) {}

  let formPage = null;
  if (postTitle) {
    console.log(`\n🚀 Starting smart navigation for "${postTitle}"...`);
    formPage = await smartNavigate(page, context, postTitle);
  }

  context.on("page", (newPage) => {
    console.log(`(New tab opened -- listening on it too)`);
    newPage.bringToFront().catch(() => {});
  });

  console.log("\n=======================================================");
  console.log("👀 HEADLESS CHROMIUM RUNNING (no window will open)");
  console.log("=======================================================\n");

  if (!formPage) {
    console.log("\n👉 Waiting for application form (#name) in browser...");
    formPage = await waitForApplicationForm(context);
  }

  console.log("\n🎯 Application Form detected! Filling in all details now...");
  await fillMainForm(formPage, profile);
  console.log("✅ Known fields filled!");

  await handleOptionalSections(formPage, profile);
  await fillOtherQualifications(formPage, profile);

  if (hasAnyAI) {
    console.log("🤖 Reading and solving CAPTCHA with AI Vision cascade...");
    await solveCaptchaRobust(formPage);
  }

  await tickDeclarationCheckbox(formPage);

  const submitted = await findAndClickSubmit(formPage);
  if (!submitted) {
    console.log("\n-------------------------------------------------------");
    console.log("✨ Form filled! CAPTCHA read, Declaration ticked.");
    console.log("  \u2192 Review in the browser, then click Submit.");
    console.log("  \u2192 Type 'r' in terminal to re-read CAPTCHA if needed.");
    console.log("-------------------------------------------------------\n");
  }

  try {
    const fs = await import("fs");
    const path = await import("path");
    const dir = path.join(process.cwd(), "public", "screenshots");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const shotPath = path.join(dir, "autofill-preview.png");
    await formPage
      .screenshot({ path: shotPath, fullPage: true })
      .catch(() => {});
    console.log(`📸 Form verification screenshot saved to: ${shotPath}`);
  } catch (err) {
    // ignore screenshot failure
  }

  postSubmitAgent(browser, context, formPage, profile);

  await keepAlive(browser, formPage);
}

// ── ROBUST SUBMIT BUTTON DETECTION ───────────────────────────────────────────
const STRICT_SUBMIT_SEL = [
  "input[type=submit]",
  "button[type=submit]",
  "#submit",
  "#btnSubmit",
  "#submit_btn",
  "input[value*='Submit' i]",
  "input[value*='Next' i]",
].join(", ");

const FALLBACK_SUBMIT_SEL = [
  "button:has-text('Submit')",
  "a:has-text('Submit')",
  "a:has-text('Next')",
  "input[type=image]",
].join(", ");

async function isAddOrRemoveControl(locator) {
  const text = await locator
    .evaluate((el) =>
      (
        el.innerText ||
        el.value ||
        el.getAttribute("aria-label") ||
        el.title ||
        ""
      ).trim(),
    )
    .catch(() => "");
  return /add\s*more|delete|remove|trash|clone|duplicate/i.test(text);
}

async function verifyCaptchaBeforeSubmit(formPage) {
  if (!lastSolvedCaptcha || !lastCaptchaInputSelector) return;
  try {
    const el = formPage.locator(lastCaptchaInputSelector).first();
    if (!(await el.count().catch(() => 0))) return;
    const current = await el.inputValue().catch(() => "");
    if (current && current.trim() === lastSolvedCaptcha) return;

    console.log(
      `[CAPTCHA] ⚠️ Field value ("${current}") doesn't match solved CAPTCHA ("${lastSolvedCaptcha}") -- re-typing before submit...`,
    );
    await el.scrollIntoViewIfNeeded().catch(() => {});
    await el.click({ force: true }).catch(() => {});
    await el
      .evaluate((e) => {
        e.value = "";
      })
      .catch(() => {});
    await formPage.keyboard.type(lastSolvedCaptcha, { delay: 80 });
    await formPage.keyboard.press("Tab").catch(() => {});
    await formPage.waitForTimeout(200).catch(() => {});
  } catch (e) {
    console.log(`[CAPTCHA] Re-check failed: ${e.message}`);
  }
}

async function findAndClickSubmit(
  formPage,
  { timeoutMs = 8000, maxClicks = 5 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let submitBtn = null;

  while (Date.now() < deadline) {
    let candidate = formPage.locator(STRICT_SUBMIT_SEL).first();
    let count = await candidate.count().catch(() => 0);
    if (!count) {
      candidate = formPage.locator(FALLBACK_SUBMIT_SEL).first();
      count = await candidate.count().catch(() => 0);
    }
    if (count > 0 && (await candidate.isVisible().catch(() => false))) {
      if (await isAddOrRemoveControl(candidate)) {
        await formPage.waitForTimeout(400).catch(() => {});
        continue;
      }
      submitBtn = candidate;
      break;
    }
    await formPage.waitForTimeout(400).catch(() => {});
  }

  if (!submitBtn) return false;

  await submitBtn.scrollIntoViewIfNeeded().catch(() => {});
  await submitBtn
    .evaluate((el) => {
      el.disabled = false;
      el.removeAttribute?.("disabled");
    })
    .catch(() => {});

  console.log("🟢 Submitting form...");
  await formPage.waitForTimeout(600);

  const startUrlBeforeClick = formPage.url();
  const handle = await submitBtn.elementHandle().catch(() => null);

  for (let i = 0; i < maxClicks; i++) {
    await verifyCaptchaBeforeSubmit(formPage);

    let dialogMessage = null;
    const dialogHandler = async (d) => {
      dialogMessage = d.message();
      await d.accept().catch(() => {});
    };
    formPage.once("dialog", dialogHandler);

    await submitBtn.click({ force: true }).catch(() => {});
    await formPage.waitForTimeout(1800).catch(() => {});
    formPage.off("dialog", dialogHandler);

    if (formPage.url() !== startUrlBeforeClick) {
      console.log("✅ Form submitted!");
      return true;
    }

    const rejection = await detectSubmitRejection(formPage, dialogMessage);
    if (rejection) {
      console.log(`⚠️ Submit was rejected by the site: "${rejection}"`);
      if (i < maxClicks - 1) {
        console.log("🔄 Getting a fresh CAPTCHA and retrying submit...");
        const refreshed = await refreshCaptchaImage(formPage).catch(
          () => false,
        );
        if (!refreshed) {
          console.log(
            "⚠️ Couldn't find a CAPTCHA refresh control -- re-reading the same image (may repeat the same rejected value).",
          );
        }
        await solveCaptchaRobust(formPage);
        await tickDeclarationCheckbox(formPage);
        continue;
      }
      console.log(
        "❌ Ran out of retries -- please solve the CAPTCHA and submit manually in the browser.",
      );
      return false;
    }

    const stillAttached = handle
      ? await handle.evaluate((el) => el.isConnected).catch(() => false)
      : await submitBtn.count().catch(() => 0);
    if (!stillAttached) {
      console.log("✅ Form submitted!");
      return true;
    }

    if (await isAddOrRemoveControl(submitBtn)) break;
  }

  console.log(
    "❓ Clicked Submit but couldn't confirm it went through (no page change, no error message either) -- please check the browser and submit manually if needed.",
  );
  return false;
}

const REJECTION_TEXT_RE =
  /wrong\s*(verification|captcha|code)|invalid\s*(captcha|code|verification)|(captcha|code|verification).{0,20}(not\s*match|incorrect|invalid|wrong|mismatch)|does not match|ভুল|সঠিক\s*নয়|আবার\s*চেষ্টা/i;

async function detectSubmitRejection(page, dialogMessage) {
  if (dialogMessage && REJECTION_TEXT_RE.test(dialogMessage))
    return dialogMessage.trim();
  try {
    const bodyText = await page
      .evaluate(() => (document.body ? document.body.innerText : ""))
      .catch(() => "");
    const match = bodyText.match(REJECTION_TEXT_RE);
    if (match) {
      const idx = bodyText.indexOf(match[0]);
      return bodyText
        .slice(Math.max(0, idx - 20), idx + 60)
        .replace(/\s+/g, " ")
        .trim();
    }
  } catch {
    /* ignore */
  }
  return null;
}

async function waitForApplicationForm(context) {
  let tick = 0;
  while (true) {
    for (const p of context.pages()) {
      if (p.isClosed()) continue;
      const found = await p
        .locator("#name")
        .count()
        .catch(() => 0);
      if (found > 0) return p;
    }
    tick++;
    if (tick % 5 === 0) {
      console.log(
        "[Listening...] Waiting for Application Form (#name) to load in any tab...",
      );
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
    } else {
      const timer = setTimeout(async () => {
        console.log("⏱️ Headless session finished. Closing browser.");
        await browser.close().catch(() => {});
        resolve();
      }, 180000);
      browser.on("disconnected", () => {
        clearTimeout(timer);
        resolve();
      });
    }
  });
}

let lastSolvedCaptcha = null;
let lastCaptchaInputSelector = null;

async function solveCaptcha(page) {
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
    "img[name*='captcha']",
  ];

  let captchaImg = null;
  for (const sel of imgSelectors) {
    const el = page.locator(sel).first();
    if (
      (await el.count().catch(() => 0)) > 0 &&
      (await el.isVisible().catch(() => false))
    ) {
      captchaImg = el;
      break;
    }
  }

  if (!captchaImg) {
    const nearRefresh = page
      .locator(
        "a:has-text('Refresh'), a:has-text('click here'), span:has-text('Refresh')",
      )
      .first();
    if (await nearRefresh.count().catch(() => 0)) {
      const containerImg = page
        .locator(
          "xpath=//a[contains(., 'Refresh') or contains(., 'click here')]/ancestor::*[contains(., 'Verification') or contains(., 'Code') or self::fieldset or self::table or self::tr or self::div][1]//img",
        )
        .first();
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
    await captchaImg.scrollIntoViewIfNeeded().catch(() => {});
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
    "input[id*='code']",
  ];

  let captchaInput = null;
  let matchedCaptchaSelector = null;
  for (const sel of inputSelectors) {
    const el = page.locator(sel).first();
    if (
      (await el.count().catch(() => 0)) > 0 &&
      (await el.isVisible().catch(() => false))
    ) {
      captchaInput = el;
      matchedCaptchaSelector = sel;
      break;
    }
  }

  if (!captchaInput) {
    const containerSel =
      "xpath=//img[contains(@src, 'captcha') or contains(@src, 'code') or contains(@id, 'captcha') or contains(@src, 'valid')]/ancestor::*[self::fieldset or self::table or self::tr or self::div][1]//input[@type='text' or not(@type)]";
    const containerInput = page.locator(containerSel).first();
    if ((await containerInput.count().catch(() => 0)) > 0) {
      captchaInput = containerInput;
      matchedCaptchaSelector = containerSel;
    }
  }

  if (captchaInput) {
    await captchaInput.scrollIntoViewIfNeeded().catch(() => {});
    await captchaInput.click({ force: true }).catch(() => {});
    await captchaInput
      .evaluate((el) => {
        el.value = "";
      })
      .catch(() => {});
    await page.keyboard.type(cleanedText, { delay: 80 });
    await captchaInput
      .evaluate((el, val) => {
        if (el.value !== val) {
          el.value = val;
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }, cleanedText)
      .catch(() => {});
    await page.keyboard.press("Tab").catch(() => {});
    await page.waitForTimeout(200).catch(() => {});
    lastSolvedCaptcha = cleanedText;
    lastCaptchaInputSelector = matchedCaptchaSelector;
    console.log(`✅ CAPTCHA "${cleanedText}" typed into input box.`);
    return cleanedText;
  } else {
    console.log("⚠️ Could not find CAPTCHA text box to enter code.");
    return null;
  }
}

async function refreshCaptchaImage(page) {
  const refreshSel =
    "a:has-text('Refresh'), a:has-text('click here'), span:has-text('Refresh'), button:has-text('Refresh'), #captcha_refresh, .captcha-refresh";
  const btn = page.locator(refreshSel).first();
  if (!(await btn.count().catch(() => 0))) return false;
  await btn.click({ force: true, timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(1200).catch(() => {});
  return true;
}

async function solveCaptchaRobust(page, { minLen = 4, maxAttempts = 3 } = {}) {
  let result = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    result = await solveCaptcha(page);
    if (result && result.length >= minLen) return result;
    if (attempt < maxAttempts) {
      console.log(
        `🤖 CAPTCHA read ("${result || ""}") looks too short/unreliable -- refreshing and retrying (${attempt}/${maxAttempts})...`,
      );
      const refreshed = await refreshCaptchaImage(page);
      if (!refreshed) break;
    }
  }
  return result;
}

async function callAIWithFallback(prompt, base64Image = null) {
  return await callAIWithCascade(prompt, base64Image);
}

async function readCaptchaWithAI(base64Image) {
  const prompt =
    "Read the distorted alphanumeric text in this CAPTCHA image. Reply with ONLY the exact characters you see, nothing else -- no spaces, no punctuation, no explanation.";
  return await callAIWithCascade(prompt, base64Image, {
    isCaptcha: true,
    fresh: true,
  });
}

async function readCaptchaWithGemini(base64Image) {
  return await readCaptchaWithAI(base64Image);
}

// ── SMART NAVIGATION (Saved Pattern → Deterministic → AI Fallback) ──────────
async function smartNavigate(page, context, targetPost) {
  for (const p of context.pages()) {
    if (p.isClosed()) continue;
    const found = await p
      .locator("#name")
      .count()
      .catch(() => 0);
    if (found > 0) return p;
  }

  const navKey = `nav_pattern::${new URL(page.url()).hostname}::${targetPost}`;
  const allPats = await loadPatterns();
  const savedNav = allPats["__nav"]?.[navKey];
  if (savedNav && savedNav.length) {
    console.log(
      `[⚡ Memory] Found ${savedNav.length}-step saved pattern for "${targetPost}" — replaying...`,
    );
    let replayPage = page;
    let patternWorked = false;
    for (const step of savedNav) {
      try {
        if (step.action === "click_text") {
          await replayPage
            .getByText(step.value, { exact: false })
            .first()
            .click({ timeout: 8000 })
            .catch(() => {});
        } else if (step.action === "click_selector") {
          await replayPage
            .locator(step.value)
            .first()
            .click({ timeout: 8000 })
            .catch(() => {});
        }
        await replayPage.waitForTimeout(2000).catch(() => {});
        const pages = context.pages().filter((p) => !p.isClosed());
        if (pages.length > 1) replayPage = pages[pages.length - 1];
        await replayPage.bringToFront().catch(() => {});

        for (const p of context.pages()) {
          if (p.isClosed()) continue;
          if (
            (await p
              .locator("#name, #name_en, #applicant_name")
              .count()
              .catch(() => 0)) > 0
          ) {
            console.log(`[⚡ Memory] ✅ Form found via saved pattern!`);
            patternWorked = true;
            return p;
          }
        }
      } catch {
        /* continue */
      }
    }
    if (!patternWorked) {
      console.log(
        `[⚡ Memory] Saved pattern didn't reach form — trying standard navigation...`,
      );
    }
  }

  const detResult = await deterministicNavigate(page, context, targetPost);
  if (detResult) return detResult;

  const hasAnyAI = Boolean(
    process.env.GEMINI_API_KEY ||
    process.env.GROQ_API_KEY ||
    process.env.OPENROUTER_API_KEY ||
    (process.env.CF_ACCOUNT_ID && process.env.CF_API_TOKEN),
  );
  if (hasAnyAI) {
    console.log(
      `[🤖 AI Brain] Standard automation finished — engaging AI Vision Brain (multi-provider cascade)...`,
    );
    return await aiNavigate(page, context, targetPost);
  }

  return null;
}

// ── DETERMINISTIC TELETALK RULE-BASED NAVIGATION ─────────────────────────────
async function deterministicNavigate(page, context, targetPost) {
  console.log(
    `[⚡ Standard Navigation] Checking standard Teletalk portal steps for "${targetPost}"...`,
  );

  let lastUrl = "";
  let applyClickCount = 0;

  for (let loop = 0; loop < 10; loop++) {
    await dismissModals(page);
    await page.waitForTimeout(600);

    const currentUrl = page.url();

    for (const p of context.pages()) {
      if (p.isClosed()) continue;
      if (
        (await p
          .locator("#name, #name_en, #applicant_name")
          .count()
          .catch(() => 0)) > 0
      ) {
        console.log(`[⚡ Standard Navigation] ✅ Application Form detected!`);
        return p;
      }
    }

    const ongoingLink = page
      .locator(
        "fieldset:has(legend:has-text('Ongoing Circular')) a, fieldset:has(legend:has-text('Ongoing')) a, a:has-text('Ongoing Circular'), div:has(legend:has-text('Ongoing')) a",
      )
      .first();
    if (await ongoingLink.isVisible().catch(() => false)) {
      console.log(
        `[⚡ Standard Navigation] 👉 Step: Clicking Ongoing Circular link...`,
      );
      await ongoingLink.click({ force: true, timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(2500);
      const pages = context.pages().filter((p) => !p.isClosed());
      if (pages.length > 1) page = pages[pages.length - 1];
      await page.bringToFront().catch(() => {});
      continue;
    }

    const applyBtn = page
      .locator(
        "a:has-text('Apply Online'), a:has-text('Apply now'), a:has-text('Apply Now'), a:has-text('Online Application'), a:has-text('আবেদন করুন'), button:has-text('Apply'), a.btn-apply, a.apply-btn",
      )
      .first();
    if (
      (await applyBtn.isVisible().catch(() => false)) &&
      applyClickCount < 2
    ) {
      const href = await applyBtn.getAttribute("href").catch(() => null);
      if (
        href &&
        href.startsWith("http") &&
        !href.includes("alljobs.teletalk.com.bd/jobs")
      ) {
        console.log(
          `[⚡ Standard Navigation] 👉 Following direct application portal link: ${href}`,
        );
        await page
          .goto(href, { timeout: 15000, waitUntil: "domcontentloaded" })
          .catch(() => {});
        await page.waitForTimeout(2000);
        applyClickCount = 0;
        continue;
      }

      console.log(`[⚡ Standard Navigation] 👉 Step: Clicking "Apply" link...`);
      applyClickCount++;
      await applyBtn.click({ force: true, timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(2000);
      const pages = context.pages().filter((p) => !p.isClosed());
      if (pages.length > 1) page = pages[pages.length - 1];
      await page.bringToFront().catch(() => {});
      continue;
    }

    // Step B: Post or Circular Selection (Radio buttons)
    let radios = await page
      .locator("input[type=radio]")
      .all()
      .catch(() => []);

    // ── SMART: ignore hidden/disabled radios when deciding how many real
    // choices exist. Some Teletalk themes render duplicate/template radio
    // inputs that stay in the DOM but hidden (display:none, a collapsed
    // accordion row, etc). Counting those inflates radios.length and can
    // make a genuinely single-option page look like it has several,
    // defeating the "only one option" shortcut below.
    if (radios.length > 1) {
      const visFlags = await Promise.all(
        radios.map((r) => r.isVisible().catch(() => false)),
      );
      const onlyVisible = radios.filter((_, i) => visFlags[i]);
      if (onlyVisible.length > 0) radios = onlyVisible;
    }

    if (radios.length > 0) {
      let matchedRadio = null;

      // Read every radio's own label text FIRST. We need this both for
      // matching against targetPost, and -- crucially -- for correctly
      // telling apart a genuine Yes/No question (like "Premium Member?")
      // from a post-selection list, WITHOUT relying on scanning the whole
      // page's text (see the bug note below).
      const allLabels = [];
      for (const r of radios) {
        const labelText = await r
          .evaluate((el) => {
            const row =
              el.closest("tr, label, div.radio, div.form-check, li, td") ||
              el.parentElement;
            return row ? row.innerText : "";
          })
          .catch(() => "");
        allLabels.push(labelText.trim().replace(/\s+/g, " "));
      }

      // ── BUGFIX ──────────────────────────────────────────────────────
      // Previously this checked the ENTIRE page's text for the word
      // "alljobs" (`/alljobs/i.test(pageText)`) to decide whether the
      // current radio group was the "Are you a Premium Member of
      // Alljobs?" question. But "alljobs" also appears on the ACTUAL
      // post-selection page itself (it's part of the portal's own
      // domain / footer text, e.g. alljobs.teletalk.com.bd). That made
      // isPremiumQuestion wrongly fire on the real post list too, which
      // sent it into the "answer No" branch below. Since none of the
      // post radios literally say "No", it fell back to:
      //     radios[radios.length - 1]   // "Default to the last radio"
      // ...silently checking the LAST job post in the list instead of
      // the one you actually asked for via --post.
      //
      // Fix: only treat this as a Yes/No question if the radios'
      // OWN LABELS are actually "Yes"/"No" (or Bangla equivalents) --
      // which is true for the real Premium Member question and never
      // true for a list of post titles. This can no longer be fooled by
      // unrelated "alljobs" text elsewhere on the page.
      const looksLikeYesNo =
        allLabels.length > 0 &&
        allLabels.every((t) => /^(yes|no|হ্যাঁ|না)$/i.test(t.trim()));
      const pageText = await page
        .evaluate(() => document.body.innerText)
        .catch(() => "");
      const isPremiumQuestion =
        looksLikeYesNo &&
        (/premium member/i.test(pageText) || /alljobs/i.test(pageText));
      // ── END BUGFIX ──────────────────────────────────────────────────

      if (isPremiumQuestion) {
        console.log(
          `[⚡ Standard Navigation] 👉 Step: Answering "No" to Alljobs Premium Member...`,
        );
        const noRadio = page
          .locator(
            "input[type=radio][value='0'], input[type=radio][value='no'], input[type=radio]#no, label:has-text('No') input[type=radio]",
          )
          .first();
        if (await noRadio.count().catch(() => 0)) {
          await noRadio.check({ force: true }).catch(() => {});
        } else {
          // Safe here now: we've already confirmed via looksLikeYesNo that
          // every radio in this group is literally "Yes"/"No", so the last
          // one really is the "No" option, not an arbitrary job post.
          await radios[radios.length - 1]
            .check({ force: true })
            .catch(() => {});
        }
      } else if (radios.length === 1) {
        // ── SMART SHORTCUT: only one real option on this page ──────────
        // If there's exactly one (visible/enabled) radio, there is no
        // actual choice to make — this is what "confused, so it asked
        // AI" used to trip on, because the strict text-matching passes
        // below could fail to match (extra whitespace, a slightly
        // different label format, grade/department suffix, etc.) even
        // though the single listed post is obviously the right one.
        // Select it directly, no AI round-trip needed.
        matchedRadio = radios[0];
        selectedPostLabel = allLabels[0] || "(only option on this page)";
        console.log(
          `[⚡ Standard Navigation] 👉 Step: Only one option present — selecting it automatically: "${(allLabels[0] || "").slice(0, 80)}"`,
        );

        // Still sanity-check it against the requested post when one was
        // given, purely as a heads-up (never as a reason to stop — with
        // only one option there is nothing else to pick).
        if (targetPost) {
          const targetNorm = targetPost.toLowerCase().replace(/[^a-z0-9]/g, "");
          const labelNorm = (allLabels[0] || "")
            .toLowerCase()
            .replace(/[^a-z0-9]/g, "");
          const words = targetPost
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter((w) => w.length >= 3);
          const related =
            (labelNorm &&
              targetNorm &&
              (labelNorm.includes(targetNorm) ||
                targetNorm.includes(labelNorm))) ||
            (words.length > 0 && words.some((w) => labelNorm.includes(w)));
          if (!related) {
            console.log(
              `[⚠️ Standard Navigation] Note: the only available option doesn't clearly match requested "${targetPost}" — proceeding anyway since there's no alternative, but double-check the confirmation PDF/email.`,
            );
          }
        }
      } else {
        // Post selection list — match the REQUESTED post exactly and, if
        // it's missing, abort loudly instead of silently submitting the
        // wrong job.
        if (targetPost) {
          const targetNorm = targetPost.toLowerCase().replace(/[^a-z0-9]/g, "");

          // Pass 1 (safest): the label contains the FULL requested title.
          radios.forEach((r, i) => {
            if (matchedRadio) return;
            const labelNorm = allLabels[i]
              .toLowerCase()
              .replace(/[^a-z0-9]/g, "");
            if (labelNorm && labelNorm.includes(targetNorm)) {
              matchedRadio = r;
              console.log(
                `[⚡ Standard Navigation] 👉 Step: Selecting post "${allLabels[i].slice(0, 60)}" (full-title match for requested "${targetPost}")...`,
              );
            }
          });

          // Pass 2: every significant word of the requested title appears
          // in the label. All words must match, so "Assistant Director"
          // never matches "Assistant Programmer".
          if (!matchedRadio) {
            const words = targetPost
              .toLowerCase()
              .split(/[^a-z0-9]+/)
              .filter((w) => w.length >= 3);
            radios.forEach((r, i) => {
              if (matchedRadio || !words.length) return;
              const labelLower = allLabels[i].toLowerCase();
              if (labelLower && words.every((w) => labelLower.includes(w))) {
                matchedRadio = r;
                console.log(
                  `[⚡ Standard Navigation] 👉 Step: Selecting post "${allLabels[i].slice(0, 60)}" (all-words match for requested "${targetPost}")...`,
                );
              }
            });
          }

          // Pass 3 (fuzzy, best-match-with-margin): neither exact pass
          // matched -- score every option by the FRACTION of requested
          // words it contains, and only auto-pick if the best score is
          // decent AND clearly ahead of the runner-up. This catches
          // reordered/abbreviated labels ("Programmer, Assistant (IT)")
          // without risking a wrong pick among genuinely similar posts
          // ("Assistant Programmer" vs "Assistant Director").
          if (!matchedRadio) {
            const words = targetPost
              .toLowerCase()
              .split(/[^a-z0-9]+/)
              .filter((w) => w.length >= 3);
            if (words.length) {
              const scores = allLabels.map((l) => {
                const labelLower = l.toLowerCase();
                const hit = words.filter((w) => labelLower.includes(w)).length;
                return hit / words.length;
              });
              let bestIdx = -1,
                bestScore = 0,
                secondScore = 0;
              scores.forEach((s, i) => {
                if (s > bestScore) {
                  secondScore = bestScore;
                  bestScore = s;
                  bestIdx = i;
                } else if (s > secondScore) {
                  secondScore = s;
                }
              });
              if (
                bestIdx !== -1 &&
                bestScore >= 0.6 &&
                bestScore - secondScore >= 0.34
              ) {
                matchedRadio = radios[bestIdx];
                console.log(
                  `[⚡ Standard Navigation] 👉 Step: Selecting post "${allLabels[bestIdx].slice(0, 60)}" (fuzzy best-match ${Math.round(bestScore * 100)}% for requested "${targetPost}", next-best ${Math.round(secondScore * 100)}%)...`,
                );
              }
            }
          }

          // SAFETY: never silently submit a different post than requested.
          if (!matchedRadio) {
            console.log(
              `[⚠️ Standard Navigation] ❌ No post option confidently matches requested "${targetPost}". Available options:`,
            );
            for (const l of allLabels)
              console.log(`     - ${l || "(blank label)"}`);
            console.log(
              `   ➔ Aborting standard navigation — the AI Vision agent may take over, but no wrong post will be submitted blindly.`,
            );
            return null;
          }
        } else {
          // Caller launched without --post: choosing the first active
          // option is then the user's explicit choice.
          if (radios.length > 0) {
            matchedRadio = radios[0];
            selectedPostLabel =
              allLabels[0] || "first available option (no --post given)";
            console.log(
              `[⚡ Standard Navigation] 👉 Step: Selecting first active circular/post option (no --post specified)...`,
            );
          }
        }
      }

      // ── THE CLICK + VERIFICATION ────────────────────────────────────────
      // Pulled out of the post-selection branch so it runs for EVERY path
      // that sets matchedRadio -- including the single-option smart
      // shortcut above. (The isPremiumQuestion branch handles its own
      // .check() calls directly and never sets matchedRadio, so it's
      // unaffected by this.)
      if (matchedRadio) {
        const wantedIdx = radios.indexOf(matchedRadio);
        await matchedRadio.check({ force: true }).catch(() => {});
        await page.waitForTimeout(400);

        let checkedIdx = -1;
        for (let i = 0; i < radios.length; i++) {
          if (await radios[i].isChecked().catch(() => false)) {
            checkedIdx = i;
            break;
          }
        }

        if (checkedIdx !== wantedIdx) {
          console.log(
            `[⚠️ Standard Navigation] ❌ POST SELECTION FAILED VERIFICATION!`,
          );
          console.log(`   Requested: "${allLabels[wantedIdx] || "(unknown)"}"`);
          console.log(
            `   Actually checked: ${checkedIdx >= 0 ? `"${allLabels[checkedIdx]}"` : "(nothing — the click did not register)"}`,
          );
          console.log(
            `   ➔ Aborting — will NOT click Next with the wrong/unchecked post. Wrong-post submission prevented.`,
          );
          return null;
        }

        console.log(
          `[⚡ Standard Navigation] ✅ Verified: the radio actually checked is "${allLabels[wantedIdx].slice(0, 60)}"`,
        );
        if (targetPost) selectedPostLabel = allLabels[wantedIdx].slice(0, 100);
      }

      // Click "Next" / "Submit" button
      const nextBtn = page
        .locator(
          "input[value='Next'], button:has-text('Next'), input[type='submit'], button[type='submit'], a:has-text('Next'), input[value='পরবর্তী']",
        )
        .first();
      if (await nextBtn.isVisible().catch(() => false)) {
        console.log(`[⚡ Standard Navigation] 👉 Step: Clicking "Next"...`);
        await nextBtn.click({ force: true, timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(2500);
        const pages = context.pages().filter((p) => !p.isClosed());
        if (pages.length > 1) page = pages[pages.length - 1];
        await page.bringToFront().catch(() => {});
        continue;
      }
    }

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
    for (const p of context.pages()) {
      if (p.isClosed()) continue;
      if (
        (await p
          .locator("#name, #name_en, #applicant_name")
          .count()
          .catch(() => 0)) > 0
      ) {
        console.log(`[AI] ✅ Application Form reached after ${step} steps!`);
        if (recordedSteps.length > 0) {
          const pats = await loadPatterns();
          if (!pats["__nav"]) pats["__nav"] = {};
          pats["__nav"][navKey] = recordedSteps;
          await fs
            .mkdir(path.join(__dirname, "..", "data"), { recursive: true })
            .catch(() => {});
          await fs.writeFile(PATTERNS_PATH, JSON.stringify(pats, null, 2));
          console.log(
            `[💾 Memory] Saved ${recordedSteps.length}-step navigation pattern for "${targetPost}".`,
          );
        }
        return p;
      }
    }

    await dismissModals(page);

    let screenshot;
    try {
      screenshot = await page.screenshot({ type: "png", fullPage: false });
    } catch (e) {
      console.log(`[AI] Screenshot failed: ${e.message}`);
      break;
    }

    const instruction = await askAINavigation(
      screenshot.toString("base64"),
      targetPost,
      step,
    );
    if (!instruction) {
      console.log(
        "[AI] Couldn't determine next step — waiting for manual navigation.",
      );
      break;
    }

    const actionStr = `${instruction.action}::${instruction.value}`;
    console.log(
      `[AI Step ${step + 1}/${maxSteps}] Action: ${instruction.reason || instruction.action}`,
    );

    const currentUrl = page.url();
    if (actionStr === lastActionStr && currentUrl === lastUrl) {
      stagnantCount++;
      if (stagnantCount >= 2) {
        console.log(
          `[🤖 AI Loop Detected] AI gave the same action twice without page change.`,
        );
        console.log(
          `[🤖 AI Cascade] 🔄 Blacklisting current provider & trying next AI in cascade...`,
        );
        stagnantCount = 0;
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
        if ((await el.count().catch(() => 0)) > 0) {
          await el.scrollIntoViewIfNeeded().catch(() => {});
          await el.click({ timeout: 8000 });
          recordedSteps.push({
            action: "click_text",
            value: instruction.value,
          });
          actionSucceeded = true;
        }
      } else if (instruction.action === "click_selector") {
        const el = page.locator(instruction.value).first();
        if ((await el.count().catch(() => 0)) > 0) {
          await el.scrollIntoViewIfNeeded().catch(() => {});
          await el.click({ timeout: 8000 });
          recordedSteps.push({
            action: "click_selector",
            value: instruction.value,
          });
          actionSucceeded = true;
        }
      } else if (instruction.action === "done") {
        console.log("[AI] Navigation finished.");
        break;
      }
    } catch (e) {
      console.log(`[AI] Click failed: ${e.message}`);
    }

    await page.waitForTimeout(2500).catch(() => {});
    const pages = context.pages().filter((p) => !p.isClosed());
    if (pages.length > 1) {
      page = pages[pages.length - 1];
      await page.bringToFront().catch(() => {});
      await page.waitForTimeout(1000).catch(() => {});
    }

    if (actionSucceeded) {
      console.log(
        `[⚡ Hybrid Handback] Testing if basic deterministic pattern can continue from here...`,
      );
      const detResult = await deterministicNavigate(page, context, targetPost);
      if (detResult) {
        console.log(
          `[⚡ Hybrid Handback] ✅ Basic automation took over and reached the form!`,
        );
        if (recordedSteps.length > 0) {
          const pats = await loadPatterns();
          if (!pats["__nav"]) pats["__nav"] = {};
          pats["__nav"][navKey] = recordedSteps;
          await fs
            .mkdir(path.join(__dirname, "..", "data"), { recursive: true })
            .catch(() => {});
          await fs.writeFile(PATTERNS_PATH, JSON.stringify(pats, null, 2));
          console.log(
            `[💾 Memory] Saved complete navigation pattern for "${targetPost}".`,
          );
        }
        return detResult;
      }
      console.log(
        `[⚡ Hybrid Handback] Basic automation needs AI guidance for next step...`,
      );
    }
  }

  return null;
}

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
    const cleaned = raw
      .replace(/^```[\w]*\n?/gm, "")
      .replace(/```$/gm, "")
      .trim();
    return JSON.parse(cleaned);
  } catch (e) {
    console.log(`[AI] Parse error: ${e.message}`);
    return null;
  }
}

// ── MODAL DISMISSAL ─────────────────────────────────────────────────────────
async function dismissModals(page) {
  const closeSelectors = [
    "button.close",
    "button.btn-close",
    ".modal-header .close",
    "[data-dismiss='modal']",
    "[data-bs-dismiss='modal']",
    ".modal .close",
    ".popup-close",
    ".overlay-close",
    "#closeModal",
    ".modal-footer .btn-secondary",
    "button:has-text('Close')",
    "button:has-text('OK')",
    "button:has-text('×')",
    "button:has-text('✕')",
    "a:has-text('Close')",
    "a:has-text('×')",
  ];

  for (const sel of closeSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 400 }).catch(() => false)) {
        await el.click({ force: true, timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(500).catch(() => {});
      }
    } catch {
      /* ignore */
    }
  }

  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(300).catch(() => {});
}

// ── TICK ALL VISIBLE CHECKBOXES ─────────────────────────────────────────────
async function tickAllCheckboxes(page) {
  try {
    const previewSelectors = [
      "#info_yes",
      "input[name='info_yes']",
      "#agree",
      "input[name='agree']",
      "#declaration",
      "input[name='declaration']",
      "input[type='checkbox']",
    ];
    for (const sel of previewSelectors) {
      const els = await page
        .locator(sel)
        .all()
        .catch(() => []);
      for (const el of els) {
        const isVisible = await el.isVisible().catch(() => false);
        if (!isVisible) continue;
        await el
          .evaluate((e) => {
            e.checked = true;
            if (typeof e.onchange === "function") {
              try {
                e.onchange();
              } catch (err) {}
            }
            e.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            e.dispatchEvent(new Event("input", { bubbles: true }));
            e.dispatchEvent(new Event("change", { bubbles: true }));
          })
          .catch(() => {});
        await el.check({ force: true, timeout: 1000 }).catch(() => {});
      }
    }
    console.log("✅ Ticked preview declaration checkbox.");
  } catch (e) {
    console.log(`[TickAll] ${e.message}`);
  }
}

// ── PRECISE DECLARATION CHECKBOX ───────────────────────────────────────────
async function tickDeclarationCheckbox(page) {
  try {
    const agree = page
      .locator("#agree, input[name='agree'], input#declaration")
      .first();
    if (await agree.count().catch(() => 0)) {
      await agree
        .evaluate((el) => {
          el.checked = true;
          if (typeof el.onchange === "function") {
            try {
              el.onchange();
            } catch (e) {}
          }
          el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        })
        .catch(() => {});
      await page
        .locator("label[for='agree'], label.form-check-label")
        .first()
        .click({ force: true, timeout: 1000 })
        .catch(() => {});
      await agree.check({ force: true, timeout: 1000 }).catch(() => {});
      console.log("✅ Declaration checkbox (#agree) ticked.");
      return;
    }

    const checkboxes = await page
      .locator("input[type=checkbox]")
      .all()
      .catch(() => []);
    for (const cb of checkboxes) {
      const isVisible = await cb.isVisible().catch(() => false);
      if (!isVisible) continue;

      const text = await cb
        .evaluate((el) => {
          const tr = el.closest("tr");
          const fieldset = el.closest("fieldset");
          const div = el.closest("div.form-group, div.row, div, p, form");
          const parent = el.parentElement;
          const label = el.id
            ? document.querySelector(`label[for="${el.id}"]`)
            : null;
          return [
            tr ? tr.innerText : "",
            fieldset ? fieldset.innerText : "",
            div ? div.innerText : "",
            parent ? parent.innerText : "",
            label ? label.innerText : "",
          ].join(" ");
        })
        .catch(() => "");

      if (
        /declare|declaration|knowledge and belief|correct, true|next step|terms|condition/i.test(
          text,
        )
      ) {
        await cb
          .evaluate((el) => {
            el.checked = true;
            if (typeof el.onchange === "function") {
              try {
                el.onchange();
              } catch (e) {}
            }
            el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          })
          .catch(() => {});
        await cb.check({ force: true, timeout: 1000 }).catch(() => {});
        console.log("✅ Declaration checkbox ticked.");
        return;
      }
    }
  } catch (e) {
    console.log(`[Checkbox] ${e.message}`);
  }
}

// ── HANDLE OPTIONAL SECTIONS (Masters, Job Experience) ───────────────────────
async function handleOptionalSections(page, profile) {
  try {
    const hasGraduation = Boolean(
      profile.graduation &&
      (profile.graduation.examination ||
        profile.graduation.institute ||
        profile.graduation.subject),
    );
    const hasMasters = Boolean(
      profile.masters && (profile.masters.examination || profile.masters.exam),
    );
    const hasExperience = Boolean(
      profile.experience &&
      (profile.experience.organization || profile.experience.designation),
    );

    const allCbs = await page
      .locator("input[type=checkbox]")
      .all()
      .catch(() => []);
    for (const cb of allCbs) {
      const parentText = await cb
        .evaluate((el) => {
          const row =
            el.closest("tr, div, td, p, fieldset, table") || el.parentElement;
          return row ? row.innerText : "";
        })
        .catch(() => "");

      if (
        /graduation/i.test(parentText) &&
        !/masters|ssc|hsc|declare|declaration/i.test(parentText)
      ) {
        if (hasGraduation) {
          await cb.check({ force: true }).catch(() => {});
          await cb
            .evaluate((el) => {
              el.checked = true;
              if (typeof el.onclick === "function") {
                try {
                  el.onclick();
                } catch (e) {}
              }
              if (typeof el.onchange === "function") {
                try {
                  el.onchange();
                } catch (e) {}
              }
              el.dispatchEvent(new Event("click", { bubbles: true }));
              el.dispatchEvent(new Event("change", { bubbles: true }));
            })
            .catch(() => {});
          console.log("📋 Enabled Graduation qualification section checkbox.");
        } else {
          await cb.uncheck({ force: true }).catch(() => {});
          await cb
            .evaluate((el) => {
              el.checked = false;
              if (typeof el.onclick === "function") {
                try {
                  el.onclick();
                } catch (e) {}
              }
              if (typeof el.onchange === "function") {
                try {
                  el.onchange();
                } catch (e) {}
              }
              el.dispatchEvent(new Event("click", { bubbles: true }));
              el.dispatchEvent(new Event("change", { bubbles: true }));
            })
            .catch(() => {});
          console.log("🔒 Kept Graduation section unchecked (not in profile).");
        }
      }

      if (
        /masters/i.test(parentText) &&
        !/graduation|declare|declaration/i.test(parentText)
      ) {
        if (hasMasters) {
          await cb.check({ force: true }).catch(() => {});
          await cb
            .evaluate((el) => {
              el.checked = true;
              if (typeof el.onclick === "function") {
                try {
                  el.onclick();
                } catch (e) {}
              }
              if (typeof el.onchange === "function") {
                try {
                  el.onchange();
                } catch (e) {}
              }
              el.dispatchEvent(new Event("click", { bubbles: true }));
              el.dispatchEvent(new Event("change", { bubbles: true }));
            })
            .catch(() => {});
          console.log("📋 Enabled Masters qualification section.");
        } else {
          await cb.uncheck({ force: true }).catch(() => {});
          await cb
            .evaluate((el) => {
              el.checked = false;
              if (typeof el.onclick === "function") {
                try {
                  el.onclick();
                } catch (e) {}
              }
              if (typeof el.onchange === "function") {
                try {
                  el.onchange();
                } catch (e) {}
              }
              el.dispatchEvent(new Event("click", { bubbles: true }));
              el.dispatchEvent(new Event("change", { bubbles: true }));
            })
            .catch(() => {});
          console.log("🔒 Kept Masters section unchecked (not in profile).");
        }
      }

      if (
        /job experience|employment|experiences/i.test(parentText) &&
        !/declare|declaration/i.test(parentText)
      ) {
        if (hasExperience) {
          await cb.check({ force: true }).catch(() => {});
          await cb
            .evaluate((el) => {
              el.checked = true;
              if (typeof el.onclick === "function") {
                try {
                  el.onclick();
                } catch (e) {}
              }
              if (typeof el.onchange === "function") {
                try {
                  el.onchange();
                } catch (e) {}
              }
              el.dispatchEvent(new Event("click", { bubbles: true }));
              el.dispatchEvent(new Event("change", { bubbles: true }));
            })
            .catch(() => {});
          console.log("📋 Enabled Job Experience section.");
        } else {
          await cb.uncheck({ force: true }).catch(() => {});
          await cb
            .evaluate((el) => {
              el.checked = false;
              if (typeof el.onclick === "function") {
                try {
                  el.onclick();
                } catch (e) {}
              }
              if (typeof el.onchange === "function") {
                try {
                  el.onchange();
                } catch (e) {}
              }
              el.dispatchEvent(new Event("click", { bubbles: true }));
              el.dispatchEvent(new Event("change", { bubbles: true }));
            })
            .catch(() => {});
          console.log(
            "🔒 Kept Job Experience section unchecked (not in profile).",
          );
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
    const selects = await page
      .locator("select")
      .all()
      .catch(() => []);

    for (const sel of selects) {
      const isVisible = await sel.isVisible().catch(() => false);
      if (!isVisible) continue;

      const id = (await sel.getAttribute("id").catch(() => "")) || "";
      const name = (await sel.getAttribute("name").catch(() => "")) || "";

      if (
        /^(name|father|mother|dob|nationality|religion|gender|marital|nid|breg|passport|mobile|email|quota|dep_status|present|permanent|ssc|hsc|gra|mas)/i.test(
          id,
        )
      )
        continue;
      if (
        /^(name|father|mother|dob|nationality|religion|gender|marital|nid|breg|passport|mobile|email|quota|dep_status|present|permanent|ssc|hsc|gra|mas)/i.test(
          name,
        )
      )
        continue;
      if (
        /board|roll|exam|year|result|gpa|cgpa|subject|group|district|upazila|post|careof|village/i.test(
          id + " " + name,
        )
      )
        continue;

      const rowText = await sel
        .evaluate((el) => {
          const row =
            el.closest("tr, div.form-group, div.field, fieldset, p") ||
            el.parentElement;
          return (row ? row.innerText : "").toLowerCase();
        })
        .catch(() => "");

      const isExpField =
        /other_exp|exp_val|other_qualification/i.test(id + " " + name) ||
        /computer|skill|proficiency|ict|ms office|typing|typewriting|training|do you have/i.test(
          rowText,
        );

      if (!isExpField) continue;

      const key = id || name || rowText.slice(0, 30);
      if (key && processed.has(key)) continue;
      if (key) processed.add(key);

      const hasYesOption = await sel
        .evaluate((el) => {
          for (let i = 0; i < el.options.length; i++) {
            const opt = el.options[i];
            const txt = (opt.text || "").trim().toLowerCase();
            const val = (opt.value || "").trim().toLowerCase();
            if (
              txt === "yes" ||
              val === "yes" ||
              val === "1" ||
              txt.includes("yes") ||
              txt.includes("হ্যাঁ") ||
              val === "y"
            ) {
              el.selectedIndex = i;
              el.value = opt.value;
              if (typeof el.onchange === "function") {
                try {
                  el.onchange();
                } catch (e) {}
              }
              if (typeof window.onChangeIdExp === "function") {
                try {
                  window.onChangeIdExp(el, el.value);
                } catch (e) {}
              }
              if (typeof window.changeExp === "function") {
                try {
                  window.changeExp(el);
                } catch (e) {}
              }
              el.dispatchEvent(new Event("input", { bubbles: true }));
              el.dispatchEvent(new Event("change", { bubbles: true }));
              return opt.text.trim();
            }
          }
          return null;
        })
        .catch(() => null);

      if (hasYesOption) {
        console.log(
          `[Auto-Fill] 💻 Selected "${hasYesOption}" for qualification: ${rowText.slice(0, 60).replace(/\s+/g, " ")}`,
        );
      }
    }

    if (profile.driving_license !== undefined) {
      const drivingSelects = await page
        .locator("select[name*='driving'], select[id*='driving']")
        .all()
        .catch(() => []);
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
    const result = await selLocator
      .evaluate((el) => {
        let chosenIndex = -1;
        for (let i = 0; i < el.options.length; i++) {
          const opt = el.options[i];
          const text = (opt.text || "").trim().toLowerCase();
          const val = (opt.value || "").trim().toLowerCase();
          if (
            text === "yes" ||
            text.startsWith("yes") ||
            text.includes("yes") ||
            val === "yes" ||
            val === "1" ||
            text.includes("হ্যাঁ") ||
            val === "y"
          ) {
            chosenIndex = i;
            break;
          }
        }
        if (chosenIndex === -1 && el.options.length >= 2) {
          for (let i = 1; i < el.options.length; i++) {
            const opt = el.options[i];
            const text = (opt.text || "").trim().toLowerCase();
            const val = (opt.value || "").trim().toLowerCase();
            if (
              !text.includes("select") &&
              !text.includes("no") &&
              !text.includes("না") &&
              val !== "0" &&
              val !== "no" &&
              val !== "2"
            ) {
              chosenIndex = i;
              break;
            }
          }
        }
        if (chosenIndex === -1 && el.options.length > 1) {
          chosenIndex = 1;
        }

        if (chosenIndex !== -1) {
          el.selectedIndex = chosenIndex;
          el.value = el.options[chosenIndex].value;
          if (typeof el.onchange === "function") {
            try {
              el.onchange();
            } catch (e) {}
          }
          if (typeof window.onChangeIdExp === "function") {
            try {
              window.onChangeIdExp(el, el.value);
            } catch (e) {}
          }
          if (typeof window.changeExp === "function") {
            try {
              window.changeExp(el);
            } catch (e) {}
          }
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return {
            index: chosenIndex,
            text: el.options[chosenIndex].text,
            value: el.options[chosenIndex].value,
          };
        }
        return null;
      })
      .catch(() => null);

    if (result) {
      console.log(
        `[Auto-Fill] ✅ Selected "${result.text}" (value: "${result.value}")`,
      );
      await selLocator
        .selectOption({ index: result.index }, { timeout: 1000 })
        .catch(() => {});
    }
  } catch (e) {
    // ignore
  }
}

// ── ROBUST SELECT WITH NATIVE EVENT DISPATCH ────────────────────────────────
async function selectRobust(page, locatorOrSelector, wanted) {
  const el =
    typeof locatorOrSelector === "string"
      ? page.locator(locatorOrSelector)
      : locatorOrSelector;
  if (!(await el.count().catch(() => 0))) return false;

  const options = await el
    .locator("option")
    .all()
    .catch(() => []);
  let matchedValue = null;
  const target = String(wanted)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

  for (const opt of options) {
    const text = (await opt.innerText().catch(() => "")).trim();
    const val = (await opt.getAttribute("value").catch(() => "")).trim();
    const normText = text.toLowerCase().replace(/[^a-z0-9]/g, "");
    const normVal = val.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (
      normText === target ||
      normVal === target ||
      (target.length > 2 &&
        (normText.includes(target) || target.includes(normText)))
    ) {
      matchedValue = val;
      break;
    }
  }

  if (matchedValue !== null) {
    await el
      .selectOption({ value: matchedValue }, { timeout: 1000 })
      .catch(() => {});
  } else {
    await el
      .selectOption({ label: String(wanted).trim() }, { timeout: 1000 })
      .catch(() => {});
  }

  await el
    .evaluate((selectEl) => {
      selectEl.dispatchEvent(new Event("change", { bubbles: true }));
      selectEl.dispatchEvent(new Event("input", { bubbles: true }));
    })
    .catch(() => {});
  return true;
}

async function scanAndFillUnknownFields(page, profile) {
  const host = await getPageHost(page);
  const patterns = await loadPatterns();

  const learned = patterns[host]?.learned_values || {};
  let appliedFromMemory = 0;
  for (const [selector, info] of Object.entries(learned)) {
    const el = page.locator(selector);
    if (!(await el.count().catch(() => 0))) continue;
    const cur = await el.inputValue().catch(() => "");
    if (cur && cur.trim()) continue;
    if (info.action === "fill") {
      await el.fill(info.value).catch(() => {});
      appliedFromMemory++;
    } else if (info.action === "select") {
      await el.selectOption({ label: info.option }).catch(() => {});
      appliedFromMemory++;
    }
  }
  if (appliedFromMemory)
    console.log(
      `[Memory] ⚡ Applied ${appliedFromMemory} learned field(s) instantly.`,
    );

  if (!hasAnyAI) return;

  const unfilled = await page
    .evaluate(() => {
      const skip = new Set([
        "hidden",
        "submit",
        "button",
        "image",
        "file",
        "checkbox",
        "radio",
      ]);
      const results = [];
      for (const el of document.querySelectorAll("input, select, textarea")) {
        if (skip.has(el.type)) continue;
        if (el.disabled || el.offsetParent === null) continue;
        if (
          el.name &&
          /captcha|valid_code|verification|vcode|security_code/i.test(el.name)
        )
          continue;
        if (
          el.id &&
          /captcha|valid_code|verification|vcode|security_code/i.test(el.id)
        )
          continue;
        if (el.name && /other_exp/i.test(el.name)) continue;
        if (el.id && /other_exp/i.test(el.id)) continue;
        const val = el.tagName === "SELECT" ? el.value : el.value.trim();
        if (val) continue;

        let label = "";
        if (el.id) {
          const lbl = document.querySelector(`label[for="${el.id}"]`);
          if (lbl) label = lbl.innerText.trim();
        }
        if (!label) {
          const cell = el.closest("td, th, div.form-group, div.field");
          if (cell)
            label = cell.innerText.replace(el.value, "").trim().slice(0, 120);
        }
        if (!label && el.placeholder) label = el.placeholder;
        if (!label && el.name) label = el.name.replace(/_/g, " ");

        const selector = el.id
          ? `#${el.id}`
          : el.name
            ? `[name="${el.name}"]`
            : null;
        if (!selector) continue;

        const isSelect = el.tagName === "SELECT";
        results.push({
          selector,
          label: label.slice(0, 120),
          type: isSelect ? "select" : el.type || "text",
          options: isSelect
            ? Array.from(el.options)
                .map((o) => o.text.trim())
                .filter((t) => t && t !== "-Select-" && t !== "-- Select --")
                .slice(0, 25)
            : [],
        });
      }
      return results;
    })
    .catch(() => []);

  const truly_new = unfilled.filter((f) => !learned[f.selector]);
  if (!truly_new.length) {
    console.log("[AI Scan] No new unknown fields found.");
    return;
  }

  console.log(
    `[AI Scan] 🔎 Found ${truly_new.length} unfilled unknown field(s) — asking Gemini to infer values...`,
  );

  const profileSummary = JSON.stringify(
    {
      name: profile.name_en,
      name_bn: profile.name_bn,
      father: profile.father_en,
      mother: profile.mother_en,
      dob: profile.dob,
      gender: profile.gender,
      religion: profile.religion,
      nationality: profile.nationality,
      blood_group: profile.blood_group || "(unknown)",
      marital_status: profile.marital_status,
      mobile: profile.mobile,
      email: profile.email,
      national_id: profile.national_id,
      present_address: profile.present_address,
      permanent_address: profile.permanent_address,
    },
    null,
    2,
  );

  const fieldList = truly_new
    .map(
      (f) =>
        `selector: "${f.selector}" | label: "${f.label}" | type: ${f.type}${f.options.length ? ` | options: [${f.options.slice(0, 10).join(", ")}]` : ""}`,
    )
    .join("\n");

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
    const screenshot = await page
      .screenshot({ type: "png", fullPage: true })
      .catch(() => null);
    const base64 = screenshot ? screenshot.toString("base64") : null;
    const raw = await callAIWithFallback(prompt, base64);
    if (!raw) {
      console.log("[AI Scan] No AI response");
      return;
    }
    const cleaned = raw
      .replace(/^```[\w]*\n?/gm, "")
      .replace(/```$/gm, "")
      .trim();
    const actionsRaw = JSON.parse(cleaned);

    const nonSkip = actionsRaw.filter((a) => a.action !== "skip");
    if (nonSkip.length > 0) {
      console.log(
        `\n[AI Scan] Applying ${nonSkip.length} inferred field(s) automatically:`,
      );
      nonSkip.forEach((a, i) => {
        const val = a.action === "select" ? a.option : a.value;
        console.log(`  [${i + 1}] "${a.label || a.selector}" \u2192 "${val}"`);
      });
      sendVerificationEmail(nonSkip, host).catch(() => {});
    }

    const actions = actionsRaw;

    const newLearned = { ...learned };
    let filled = 0;
    for (const action of actions) {
      if (action.action === "skip") continue;
      const el = page.locator(action.selector);
      if (!(await el.count().catch(() => 0))) continue;

      if (action.action === "fill") {
        await el.fill(String(action.value)).catch(() => {});
        newLearned[action.selector] = {
          action: "fill",
          value: String(action.value),
          label: action.label,
        };
        console.log(`[AI Scan] ✏️  "${action.label}" → "${action.value}"`);
        filled++;
      } else if (action.action === "select") {
        await el.selectOption({ label: action.option }).catch(() => {});
        newLearned[action.selector] = {
          action: "select",
          option: action.option,
          label: action.label,
        };
        console.log(
          `[AI Scan] 📋 "${action.label}" → selected "${action.option}"`,
        );
        filled++;
      }
    }

    if (filled > 0) {
      const allPatterns = await loadPatterns();
      if (!allPatterns[host]) allPatterns[host] = {};
      allPatterns[host].learned_values = newLearned;
      await fs
        .mkdir(path.join(__dirname, "..", "data"), { recursive: true })
        .catch(() => {});
      await fs.writeFile(PATTERNS_PATH, JSON.stringify(allPatterns, null, 2));
      console.log(
        `[Memory] 💾 Saved ${filled} new inferred field(s) for future runs.`,
      );
    }
  } catch (e) {
    console.log(`[AI Scan] Error: ${e.message}`);
  }
}

// ── POST-SUBMIT AUTONOMOUS AGENT ─────────────────────────────────────────────────
async function detectStepType(page, { debug = false } = {}) {
  try {
    const info = await page.evaluate(() => {
      const nameEl = document.querySelector("#name, #applicant_name, #father");
      const fileEls = Array.from(document.querySelectorAll("input[type=file]"));
      const agreeEl = document.querySelector(
        "#agree, input[name='agree'], input#declaration",
      );
      const captchaEl = document.querySelector(
        "#captcha, #valid_code, input[name*='captcha' i], input[name*='valid' i], img[src*='captcha' i]",
      );
      return {
        hasMainForm: !!nameEl,
        mainFormMatchTag: nameEl
          ? `${nameEl.tagName}#${nameEl.id}${nameEl.type ? "[type=" + nameEl.type + "]" : ""}${nameEl.hidden || nameEl.style.display === "none" ? "(hidden)" : ""}`
          : null,
        fileInputCount: fileEls.length,
        fileInputIds: fileEls.map(
          (el) => `#${el.id || "(no id)"}[name=${el.name || "(no name)"}]`,
        ),
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
      console.log(
        `[detectStepType] → "${stepType}" | mainForm=${info.hasMainForm}${info.mainFormMatchTag ? ` (matched ${info.mainFormMatchTag})` : ""} | fileInputs=${info.fileInputCount}${info.fileInputCount ? ` [${info.fileInputIds.join(", ")}]` : ""} | agree=${info.hasAgree} | captcha=${info.hasCaptcha}`,
      );
    }

    return stepType;
  } catch (e) {
    if (debug) console.log(`[detectStepType] error: ${e.message}`);
    return "unknown";
  }
}

async function shutdownAfterSuccess(browser) {
  console.log(
    "\n🏁 Application submitted and confirmation PDF emailed. Closing browser and exiting...\n",
  );
  await browser.close().catch(() => {});
  process.exit(0);
}

async function postSubmitAgent(browser, context, startPage, profile) {
  if (!hasAnyAI) return;
  console.log(
    "🤖 [Post-Submit Agent] Watching for next steps after submission...",
  );

  let lastUrl = startPage.url();
  let lastStepType = await detectStepType(startPage, { debug: true });
  let idleCount = 0;
  const MAX_IDLE = 300;
  const POST_PATTERNS_KEY = "post_submit_flow";

  const initialPathname = (() => {
    try {
      return new URL(lastUrl).pathname;
    } catch {
      return lastUrl;
    }
  })();
  let pendingStepKey = `${initialPathname}::${lastStepType}`;
  let pendingAttempts = 0;
  const MAX_PENDING_ATTEMPTS = 6;

  while (idleCount < MAX_IDLE) {
    await new Promise((r) => setTimeout(r, 3000));
    if (browser.isConnected() === false) break;

    const pages = context.pages().filter((p) => !p.isClosed());
    if (!pages.length) break;
    const page = pages[pages.length - 1];

    const curUrl = page.url();
    const curStepType = await detectStepType(page, { debug: true });
    const pathname = new URL(curUrl).pathname;
    const stepKey = `${pathname}::${curStepType}`;

    const isNewStep = curUrl !== lastUrl || curStepType !== lastStepType;
    if (isNewStep) {
      lastUrl = curUrl;
      lastStepType = curStepType;
      pendingStepKey = stepKey;
      pendingAttempts = 0;
    }

    if (!isNewStep && pendingStepKey === null) {
      idleCount++;
      continue;
    }

    if (curStepType === "main_form") {
      idleCount++;
      continue;
    }

    if (pendingStepKey !== stepKey) {
      pendingStepKey = stepKey;
      pendingAttempts = 0;
    }

    if (pendingAttempts >= MAX_PENDING_ATTEMPTS) {
      idleCount++;
      continue;
    }

    idleCount = 0;
    pendingAttempts++;
    console.log(
      `📍 [Post-Submit] Handling step (attempt ${pendingAttempts}/${MAX_PENDING_ATTEMPTS}, ${curStepType}): ${curUrl}`,
    );

    if (curStepType === "upload") {
      console.log(
        "📸 [Post-Submit] Upload step detected — filling photo/signature directly...",
      );
      await handleImageUpload(page, [], profile);
      await tickAllCheckboxes(page);
      await tickDeclarationCheckbox(page);
      const clicked = await findAndClickSubmit(page).catch(() => false);
      if (!clicked) {
        await page
          .locator("input[type=submit], button[type=submit], #submit")
          .first()
          .click({ force: true })
          .catch(() => {});
      }
      pendingStepKey = null;
      if (isFinalConfirmationUrl(page.url())) {
        await downloadAndEmailPdf(page, profile).catch(() => {});
        return await shutdownAfterSuccess(browser);
      }
      continue;
    }

    const allPats = await loadPatterns();
    const host = await getPageHost(page);
    const postFlow = allPats[host]?.[POST_PATTERNS_KEY] || {};
    const urlKey = `${pathname}::${curStepType}`;
    const savedSteps = postFlow[urlKey] || postFlow[pathname];
    if (savedSteps) {
      console.log(
        `[⚡ Memory] Replaying saved steps for ${postFlow[urlKey] ? urlKey : pathname}`,
      );
      const reachedFinal = await replayPostSteps(page, savedSteps, profile);
      pendingStepKey = null;
      if (reachedFinal) return await shutdownAfterSuccess(browser);
      continue;
    }

    const screenshot = await page.screenshot({ type: "png" }).catch(() => null);
    if (!screenshot) continue;

    const decision = await geminiDecidePage(
      screenshot.toString("base64"),
      profile,
    );
    if (!decision) {
      console.log(
        `[Post-Submit AI] ⚠️ Couldn't classify this page (attempt ${pendingAttempts}/${MAX_PENDING_ATTEMPTS}) -- every AI provider may be failing right now. Will retry.`,
      );
      continue;
    }

    console.log(
      `[Post-Submit AI] 🤔 Detected: ${decision.type} — ${decision.reason || ""}`,
    );
    pendingStepKey = null;

    const stepsToSave = [];

    if (decision.type === "success") {
      console.log(
        `🎉 [SUCCESS] ${decision.message || "Application submitted successfully!"}`,
      );
      await downloadAndEmailPdf(page, profile).catch(() => {});
      return await shutdownAfterSuccess(browser);
    } else if (decision.type === "image_upload") {
      await handleImageUpload(page, decision.fields || [], profile);
      stepsToSave.push({ action: "image_upload", fields: decision.fields });
      await tickAllCheckboxes(page);
      stepsToSave.push({ action: "tick_checkboxes" });
      await page
        .locator(
          decision.submit_selector || "input[type=submit], button[type=submit]",
        )
        .first()
        .click({ force: true })
        .catch(() => {});
      stepsToSave.push({
        action: "click",
        selector: decision.submit_selector || "input[type=submit]",
      });
    } else if (decision.type === "checkboxes_and_submit") {
      await tickAllCheckboxes(page);
      stepsToSave.push({ action: "tick_checkboxes" });
      await page
        .locator(
          decision.submit_selector || "input[type=submit], button[type=submit]",
        )
        .first()
        .click({ force: true })
        .catch(() => {});
      stepsToSave.push({
        action: "click",
        selector: decision.submit_selector || "input[type=submit]",
      });
    } else if (decision.type === "new_form") {
      console.log(
        `📝 [Post-Submit] New form detected — filling with profile data...`,
      );
      await fillMainForm(page, profile);
      await scanAndFillUnknownFields(page, profile);
      await tickAllCheckboxes(page);
      stepsToSave.push({ action: "fill_form" });
    } else if (decision.type === "click") {
      await page
        .locator(decision.selector)
        .first()
        .click({ force: true })
        .catch(() => {});
      stepsToSave.push({ action: "click", selector: decision.selector });
    } else if (decision.type === "confirm_dialog") {
      page.on("dialog", async (dialog) => {
        await dialog.accept();
      });
      stepsToSave.push({ action: "accept_dialog" });
    }

    if (stepsToSave.length > 0) {
      const updPats = await loadPatterns();
      if (!updPats[host]) updPats[host] = {};
      if (!updPats[host][POST_PATTERNS_KEY])
        updPats[host][POST_PATTERNS_KEY] = {};
      updPats[host][POST_PATTERNS_KEY][urlKey] = stepsToSave;
      await fs
        .mkdir(path.join(__dirname, "..", "data"), { recursive: true })
        .catch(() => {});
      await fs.writeFile(PATTERNS_PATH, JSON.stringify(updPats, null, 2));
      console.log(`[💾 Memory] Saved post-submit steps for ${urlKey}`);
    }

    if (isFinalConfirmationUrl(curUrl)) {
      await downloadAndEmailPdf(page, profile).catch(() => {});
      return await shutdownAfterSuccess(browser);
    } else {
      console.log(
        `[Post-Submit] ⏭️  Not a final confirmation page (${curUrl}) — skipping PDF email for now.`,
      );
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
      await page
        .locator(step.selector)
        .first()
        .click({ force: true })
        .catch(() => {});
    } else if (step.action === "fill_form") {
      await fillMainForm(page, profile);
      await tickAllCheckboxes(page);
    } else if (step.action === "accept_dialog") {
      page.on("dialog", async (d) => {
        await d.accept();
      });
    }
    await page.waitForTimeout(1500).catch(() => {});
  }
  if (isFinalConfirmationUrl(page.url())) {
    await downloadAndEmailPdf(page, profile).catch(() => {});
    return true;
  } else {
    console.log(
      `[Post-Submit] ⏭️  Not a final confirmation page (${page.url()}) — skipping PDF email for now.`,
    );
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
    const cleaned = raw
      .replace(/^```[\w]*\n?/gm, "")
      .replace(/```$/gm, "")
      .trim();
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

async function handleImageUpload(page, fields, profile) {
  const photoPath = await resolveUploadFilePath(profile, "photo");
  const sigPath = await resolveUploadFilePath(profile, "signature");

  console.log(
    `[Image] Looking for uploads. photoPath="${photoPath}" sigPath="${sigPath}"`,
  );

  const photoInput = page.locator("#photo");
  const sigInput = page.locator("#signature");
  const hasPhotoId = await photoInput.count().catch(() => 0);
  const hasSigId = await sigInput.count().catch(() => 0);
  console.log(
    `[Image] #photo found: ${hasPhotoId > 0} | #signature found: ${hasSigId > 0}`,
  );
  if (hasPhotoId || hasSigId) {
    if (hasPhotoId) await uploadFile(photoInput, photoPath, "photo");
    if (hasSigId) await uploadFile(sigInput, sigPath, "signature");
    return;
  }

  const detected = await page
    .locator("input[type=file]")
    .all()
    .catch(() => []);
  console.log(
    `[Image] Generic input[type=file] scan found ${detected.length} element(s).`,
  );
  if (detected.length) {
    for (let i = 0; i < detected.length; i++) {
      const aiHintIsSig =
        fields && fields[i] && /sign/i.test(fields[i].label || "");
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

  for (const f of fields) {
    const isSig = /sign/i.test(f.label || "");
    const filePath = isSig ? sigPath : photoPath;
    const input = page.locator(f.selector);
    if (await input.count())
      await uploadFile(input, filePath, isSig ? "signature" : "photo");
  }
}

function isFinalConfirmationUrl(url) {
  return (
    /appcopy|application[_-]?copy|admit[_-]?card|success|thank|complete|congrat|confirmation|receipt/i.test(
      url,
    ) && !/preview/i.test(url)
  );
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
      host: smtpHost,
      port: parseInt(process.env.SMTP_PORT || "587"),
      secure: false,
      auth: { user: smtpUser, pass: smtpPass },
    });

    const rows = inferredFields
      .map((f) => {
        const val = f.action === "select" ? f.option : f.value;
        return `<tr><td style="padding:8px 12px;border-bottom:1px solid #eee;color:#555">${f.label || f.selector}</td><td style="padding:8px 12px;border-bottom:1px solid #eee;font-weight:bold;color:#1a1a2e">${val}</td></tr>`;
      })
      .join("");

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
        </div>`,
    });
    console.log(
      `📧 [Email] Verification email sent to ${notifyEmail} with ${inferredFields.length} inferred field(s).`,
    );
  } catch (e) {
    console.log(`[Email] Could not send verification email: ${e.message}`);
  }
}

// ── PDF DOWNLOAD + EMAIL ───────────────────────────────────────────────────
async function downloadAndEmailPdf(page, profile) {
  try {
    const dlDir = path.join(__dirname, "..", "data", "downloads");
    await fs.mkdir(dlDir, { recursive: true }).catch(() => {});

    const btn = page
      .locator(
        "#download, button#download, button:has-text('Download'), a[href*='download'], input[value*='Download'], button.btn-primary:has-text('Download')",
      )
      .first();
    const hasDl = await btn.count().catch(() => 0);

    let savePath = null;
    let suggestedName = null;

    if (hasDl) {
      console.log(
        "\ud83d\udce5 [PDF] Download button found — trying file download...",
      );
      try {
        const dlEvent = page.waitForEvent("download", { timeout: 5000 });
        await btn.click({ force: true }).catch(() => {});
        const download = await dlEvent;
        suggestedName =
          download.suggestedFilename() || `application_${Date.now()}.pdf`;
        savePath = path.join(dlDir, suggestedName);
        await download.saveAs(savePath);
        console.log(`\ud83d\udcce [PDF] Downloaded: ${suggestedName}`);
      } catch (_) {
        // Download event didn't fire (likely window.print()) — fall through to page.pdf()
      }
    }

    if (!savePath) {
      console.log(
        "\ud83d\udda8\ufe0f [PDF] Saving page as PDF (print-to-PDF)...",
      );
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

    await emailPdfAttachment(savePath, suggestedName, profile).catch((e) =>
      console.log(`[Email] PDF email failed: ${e.message}`),
    );
  } catch (e) {
    console.log(`[PDF] Download failed: ${e.message}`);
  }
}

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
    toList = [applicantEmail];
    if (
      notifyEmail &&
      notifyEmail.toLowerCase() !== applicantEmail.toLowerCase()
    ) {
      ccList = [notifyEmail];
    }
  } else if (notifyEmail) {
    console.log(
      `[Email] ⚠️  profile.email is empty — falling back to NOTIFY_EMAIL ("${notifyEmail}") as recipient. Add "email" to config/profile.json to send the PDF to the applicant directly.`,
    );
    toList = [notifyEmail];
  } else {
    console.log(
      "[Email] No recipient email configured (profile.email and NOTIFY_EMAIL are both empty). Skipping PDF email.",
    );
    return;
  }

  const { default: nodemailer } = await import("nodemailer");
  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: parseInt(process.env.SMTP_PORT || "587"),
    secure: false,
    auth: { user: smtpUser, pass: smtpPass },
  });

  const applicantName = profile?.name_en || "Applicant";
  const toStr = toList.join(", ");
  const ccStr = ccList.join(", ");

  const requestedPost = postTitle || "";
  const filledPost = selectedPostLabel || "";
  const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const postMatch =
    !requestedPost ||
    !filledPost ||
    norm(filledPost).includes(norm(requestedPost)) ||
    norm(requestedPost).includes(norm(filledPost));

  await transporter.sendMail({
    from: process.env.SMTP_FROM || smtpUser,
    to: toStr,
    cc: ccStr || undefined,
    subject: `🎉 Application Submitted — ${applicantName}${requestedPost ? ` — ${requestedPost}` : ""} (PDF Attached)`,
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:auto">
        <div style="background:#16a34a;color:#fff;padding:20px 24px;border-radius:8px 8px 0 0">
          <h2 style="margin:0">🎉 Application Successfully Submitted!</h2>
        </div>
        <div style="background:#fff;border:1px solid #e5e7eb;border-top:none;padding:20px 24px;border-radius:0 0 8px 8px">
          <p style="color:#555">The job application for <strong>${applicantName}</strong> has been submitted successfully.</p>
          ${requestedPost ? `<p style="color:#555">📝 <strong>Requested post (from dashboard):</strong> ${requestedPost}</p>` : ""}
          ${filledPost ? `<p style="color:#555"><strong>Post actually selected on portal:</strong> ${filledPost}</p>` : `<p style="color:#555"><strong>Post actually selected on portal:</strong> (not recorded — verify the attached PDF)</p>`}
          ${!postMatch ? `<p style="color:#b91c1c;background:#fef2f2;border:1px solid #fecaca;padding:12px;border-radius:6px">⚠️ <strong>Mismatch detected:</strong> the portal selected a different post than the one requested. Verify the attached PDF before paying any fee or submitting payment!</p>` : ""}
          <p style="color:#555">📎 Confirmation file: <strong>${filename}</strong></p>
          <p style="color:#555">The application PDF is attached to this email for your records.</p>
        </div>
      </div>`,
    attachments: [{ filename, path: pdfPath, contentType: "application/pdf" }],
  });
  console.log(
    `📧 [Email] Application PDF sent — To: ${toStr}${ccStr ? " | Cc: " + ccStr : ""} (From: ${process.env.SMTP_FROM || smtpUser})`,
  );
}

async function fillMainForm(page, profile) {
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
  await fillRevealedIdField(
    page,
    "#breg",
    "#breg_no",
    profile.birth_registration,
  );
  await fillRevealedIdField(
    page,
    "#passport",
    "#passport_no",
    profile.passport_id,
  );

  await selectFuzzy(page, "#marital_status", profile.marital_status);

  await fillText(page, "#mobile", profile.mobile);
  await fillText(page, "#confirm_mobile", profile.mobile);
  await fillText(page, "#email", profile.email);

  await selectFuzzy(page, "#quota", profile.quota);
  await selectFuzzy(page, "#dep_status", profile.departmental_status);

  await fillAddressBlock(page, "present", profile.present_address);
  await fillAddressBlock(page, "permanent", profile.permanent_address);

  await fillLevelWithGroup(page, "ssc", profile.ssc);
  await fillLevelWithGroup(page, "hsc", profile.hsc);
  await fillGraduation(page, profile.graduation);

  // Masters and Job Experience are left alone (checkboxes default off) --
  // add profile.masters / profile.experience later if you need them filled.
}

async function fillRevealedIdField(page, selectSel, inputSel, value) {
  const select = page.locator(selectSel);
  if (!(await select.count())) return;

  const strVal =
    value !== undefined && value !== null ? String(value).trim() : "";
  const hasValue = strVal !== "" && !/^(no|na|none|0|false)$/i.test(strVal);

  await select
    .evaluate((el, isYes) => {
      let chosen = -1;
      for (let i = 0; i < el.options.length; i++) {
        const opt = el.options[i];
        const txt = (opt.text || "").trim().toLowerCase();
        const val = (opt.value || "").trim().toLowerCase();
        if (isYes) {
          if (
            txt === "yes" ||
            val === "yes" ||
            val === "1" ||
            txt.includes("yes") ||
            txt.includes("হ্যাঁ") ||
            val === "y"
          ) {
            chosen = i;
            break;
          }
        } else {
          if (
            txt === "no" ||
            val === "no" ||
            val === "0" ||
            val === "2" ||
            val === "na" ||
            txt.includes("no") ||
            txt.includes("না") ||
            val === "n"
          ) {
            chosen = i;
            break;
          }
        }
      }
      if (chosen !== -1) {
        el.selectedIndex = chosen;
        el.value = el.options[chosen].value;
        if (typeof el.onchange === "function") {
          try {
            el.onchange();
          } catch (e) {}
        }
        if (typeof window.onChangePassport === "function") {
          try {
            window.onChangePassport(el);
          } catch (e) {}
        }
        if (typeof window.onChangeNid === "function") {
          try {
            window.onChangeNid(el);
          } catch (e) {}
        }
        if (typeof window.onChangeBreg === "function") {
          try {
            window.onChangeBreg(el);
          } catch (e) {}
        }
        if (typeof window.onChangeIdExp === "function") {
          try {
            window.onChangeIdExp(el, el.value);
          } catch (e) {}
        }
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }, hasValue)
    .catch(() => {});

  if (!hasValue) {
    const input = page.locator(inputSel);
    if (await input.count().catch(() => 0)) {
      await input.fill("").catch(() => {});
    }
    return;
  }

  const input = page.locator(inputSel);
  await input.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  await input.fill(strVal).catch(() => {});
  await input
    .evaluate((el, val) => {
      el.value = val;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, strVal)
    .catch(() => {});
}

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

async function fillLevelWithGroup(page, prefix, level) {
  if (!level) return;
  const examSel = `#${prefix}_exam`;
  const groupSel = `#${prefix}_group`;
  const boardSel = `#${prefix}_board`;

  const examOk = await selectFuzzy(page, examSel, level.examination);
  await selectFuzzy(page, boardSel, level.board);
  if (examOk) await waitForOptions(page, groupSel, 2, 4000);
  await selectFuzzy(page, groupSel, level.group);

  await fillText(page, `#${prefix}_roll`, level.roll);
  await fillResultType(page, prefix, level, /^gpa$/i, "GPA");
  await selectFuzzy(page, `#${prefix}_year`, level.year);
}

async function fillGraduation(page, grad) {
  if (!grad) return;

  const gradCbSel = [
    "input[type=checkbox]#gra_applicable",
    "input[type=checkbox][name*='gra_app']",
    "input[type=checkbox][name*='chk_gra']",
    "input[type=checkbox][id*='gra']",
  ].join(", ");
  const gradCbs = await page
    .locator(gradCbSel)
    .all()
    .catch(() => []);
  for (const cb of gradCbs) {
    if (!(await cb.isVisible().catch(() => false))) continue;
    await cb
      .evaluate((el) => {
        el.checked = true;
        if (typeof el.onclick === "function") {
          try {
            el.onclick();
          } catch (e) {}
        }
        if (typeof el.onchange === "function") {
          try {
            el.onchange();
          } catch (e) {}
        }
        el.dispatchEvent(new Event("click", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      })
      .catch(() => {});
    await cb.check({ force: true }).catch(() => {});
    await page.waitForTimeout(300);
    break;
  }

  const examOk = await selectFuzzy(page, "#gra_exam", grad.examination);

  const instituteOk = await selectFuzzy(page, "#gra_institute", grad.institute);
  if (instituteOk) await waitForOptions(page, "#gra_subject", 2, 4000);

  await selectFuzzy(page, "#gra_subject", grad.subject);

  await selectFuzzy(page, "#gra_year", grad.year);
  const durStr = String(grad.duration).replace(/^0+/, "");
  const durOk =
    (await selectFuzzy(page, "#gra_duration", `${grad.duration} Years`)) ||
    (await selectFuzzy(page, "#gra_duration", `${durStr} Years`)) ||
    (await selectFuzzy(page, "#gra_duration", durStr));

  await fillResultType(page, "gra", grad, /^cgpa$/i, "CGPA");
}

async function fillResultType(page, prefix, level, resultKeywordRe, kind) {
  if (!level || !resultKeywordRe.test(level.result || "")) return;
  const scale = level.scale || (kind === "CGPA" ? "4" : "5");
  const wanted = `${kind}(out of ${scale})`;

  const typeSel = `#${prefix}_result_type`;
  const ok = await selectFuzzy(page, typeSel, wanted);
  if (!ok) return;

  const numberSel = `#${prefix}_result`;
  const input = page.locator(numberSel);
  await input.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  await input.fill(String(level.gpa)).catch(() => {});
}

// ── PATTERN MEMORY SYSTEM ───────────────────────────────────────────────────
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
  await fs
    .mkdir(path.join(__dirname, "..", "data"), { recursive: true })
    .catch(() => {});
  await fs.writeFile(PATTERNS_PATH, JSON.stringify(all, null, 2));
  console.log(`[Memory] 💾 Saved pattern for "${fieldKey}" on ${host}`);
}

async function getPageHost(page) {
  try {
    return new URL(page.url()).hostname;
  } catch {
    return "unknown";
  }
}

async function aiFixField(page, fieldKey, value, hint) {
  if (
    !GEMINI_API_KEY &&
    !OPENROUTER_API_KEY &&
    !GROQ_API_KEY &&
    !(CF_ACCOUNT_ID && CF_API_TOKEN)
  )
    return null;
  console.log(
    `[AI] 🤔 Field "${fieldKey}" failed normally — trying AI fallback...`,
  );

  let screenshot;
  try {
    screenshot = await page.screenshot({ type: "png", fullPage: false });
  } catch {
    return null;
  }

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
    const cleaned = raw
      .replace(/^```[\w]*\n?/gm, "")
      .replace(/```$/gm, "")
      .trim();
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

async function fillText(page, selector, value, fieldKey) {
  if (value === undefined || value === null || value === "") return;

  const el = page.locator(selector);
  if (await el.count().catch(() => 0)) {
    await el.click({ force: true }).catch(() => {});
    await el.fill(String(value)).catch(() => {});
    await el
      .evaluate((e, v) => {
        e.value = v;
        e.dispatchEvent(new Event("input", { bubbles: true }));
        e.dispatchEvent(new Event("change", { bubbles: true }));
      }, String(value))
      .catch(() => {});
    return;
  }

  const host = await getPageHost(page);
  const key = fieldKey || selector;
  const patterns = await loadPatterns();
  const mem = patterns[host]?.[key];
  if (mem && mem.action === "fill") {
    await page
      .locator(mem.selector)
      .fill(String(value))
      .catch(() => {});
    return;
  }
  if (mem && mem.action === "type") {
    const mel = page.locator(mem.selector);
    await mel.click().catch(() => {});
    await mel.selectText().catch(() => {});
    await page.keyboard.type(String(value), { delay: 40 }).catch(() => {});
    return;
  }

  const fix = await aiFixField(
    page,
    key,
    String(value),
    `Selector "${selector}" not found`,
  );
  if (!fix || fix.action === "skip") return;
  if (fix.action === "fill") {
    await page
      .locator(fix.selector)
      .fill(String(value))
      .catch(() => {});
    await savePattern(host, key, { action: "fill", selector: fix.selector });
  } else if (fix.action === "type") {
    const el2 = page.locator(fix.selector);
    await el2.click().catch(() => {});
    await el2.selectText().catch(() => {});
    await page.keyboard.type(String(value), { delay: 40 }).catch(() => {});
    await savePattern(host, key, { action: "type", selector: fix.selector });
  }
}

async function selectFuzzy(page, selector, wanted, fieldKey) {
  if (wanted === undefined || wanted === null || String(wanted).trim() === "")
    return false;
  const host = await getPageHost(page);
  const key = fieldKey || selector;

  const patterns = await loadPatterns();
  const mem = patterns[host]?.[key];
  if (mem && mem.action === "select") {
    const ok = await page
      .locator(mem.selector)
      .selectOption({ label: mem.option })
      .then(() => true)
      .catch(() => false);
    if (ok) return true;
  }

  const select = page.locator(selector);
  if (!(await select.count())) {
    const fix = await aiFixField(
      page,
      key,
      String(wanted),
      `Select "${selector}" not present`,
    );
    if (!fix || fix.action === "skip") return false;
    if (fix.action === "select") {
      const ok = await page
        .locator(fix.selector)
        .selectOption({ label: fix.option })
        .then(() => true)
        .catch(() => false);
      if (ok)
        await savePattern(host, key, {
          action: "select",
          selector: fix.selector,
          option: fix.option,
        });
      return ok;
    }
    return false;
  }

  const options = await select.locator("option").allTextContents();
  const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const target = normalize(String(wanted));

  const synonyms = {
    notapplicable: ["nonquota", "none", "no", "general", "na", "nil"],
    nonquota: ["general", "none", "notapplicable", "no", "na", "nil"],
    none: ["no", "notapplicable", "na", "nil", "nonquota", "general"],
    single: ["unmarried"],
    unmarried: ["single"],
    married: ["married"],
    male: ["m"],
    female: ["f"],
    islam: ["muslim", "islamic"],
    bangladeshi: ["bangladesh", "bd"],
  };

  const targetsToTry = [target, ...(synonyms[target] || [])];

  let match = null;
  for (const t of targetsToTry) {
    match = options.find((o) => normalize(o) === t);
    if (!match)
      match = options.find((o) => normalize(o).includes(t) && t.length > 2);
    if (!match)
      match = options.find(
        (o) => t.includes(normalize(o)) && normalize(o).length > 2,
      );
    if (match) break;
  }

  if (match) {
    await select.selectOption({ label: match }).catch(() => {});
    await select
      .evaluate((el) => {
        if (typeof el.onchange === "function") {
          try {
            el.onchange();
          } catch (e) {}
        }
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new Event("input", { bubbles: true }));
      })
      .catch(() => {});
    return true;
  }

  const allOpts = options.join(" | ");
  const fix = await aiFixField(
    page,
    key,
    String(wanted),
    `Dropdown "${selector}" has no match for "${wanted}". Available options: ${allOpts.slice(0, 300)}`,
  );
  if (!fix || fix.action === "skip") return false;
  if (fix.action === "select") {
    const ok = await page
      .locator(fix.selector || selector)
      .selectOption({ label: fix.option })
      .then(() => true)
      .catch(() => false);
    if (ok)
      await savePattern(host, key, {
        action: "select",
        selector: fix.selector || selector,
        option: fix.option,
      });
    return ok;
  }
  return false;
}

async function waitForOptions(page, selector, minCount, timeout) {
  const select = page.locator(selector);
  try {
    const count = await select.locator("option").count();
    if (count >= minCount) return;
  } catch (_) {}
  const cappedTimeout = Math.min(timeout, 4000);
  const deadline = Date.now() + cappedTimeout;
  while (Date.now() < deadline) {
    try {
      const n = await select.locator("option").count();
      if (n >= minCount) return;
    } catch (_) {
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
