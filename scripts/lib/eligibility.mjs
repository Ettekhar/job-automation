// Pre-flight eligibility check for Teletalk organization portals.
//
// The circular PDFs are legacy Bijoy-encoded and extract as garbled text, so
// the only reliable place to see a post's real restrictions is the online
// application form itself. This module walks the standard Teletalk portal
// flow (home -> ongoing circular -> circulars.php -> posts.php -> premium.php
// -> application.php) WITHOUT filling or submitting anything, then reads the
// education dropdowns and the form's own "minimum experience" notice.
//
// It never clicks a submit button after the application form is reached. The
// returned verdict is intentionally conservative:
//   - "restricted": the form has a hard requirement that may exclude the user.
//   - "clear":      no known hard requirement was detected.
//   - "unknown":    the form could not be reached or inspected; send a normal
//                   alert rather than guessing.

const NAV_TIMEOUT = 25000;
const SETTLE_MS = 700;

export function normalizeTitle(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function englishPart(label) {
  return String(label || "")
    .replace(/\s+/g, " ")
    .split("[")[0]
    .trim();
}

/**
 * Find the post radio that matches the scraped job title.
 * Returns the index into `posts`, or -1 when the match is missing/ambiguous.
 */
export function matchPostTitle(posts, jobTitle) {
  const target = normalizeTitle(jobTitle);
  if (!target) return -1;

  const prepared = posts.map((post, index) => ({
    index,
    text: normalizeTitle(englishPart(post.text)),
  }));

  const exact = prepared.filter((post) => post.text === target);
  if (exact.length === 1) return exact[0].index;
  if (exact.length > 1) return -1;

  const strong = prepared.filter(
    (post) => post.text.startsWith(`${target} `) || target.startsWith(`${post.text} `)
  );
  if (strong.length === 1) return strong[0].index;

  const loose = prepared.filter(
    (post) => post.text.includes(target) || target.includes(post.text)
  );
  if (loose.length === 1) return loose[0].index;

  return -1;
}

/**
 * Turn raw form data into human-readable eligibility warnings.
 * Exported for unit tests.
 */
export function buildEligibilityWarnings(formData = {}) {
  const warnings = [];
  const hscOptions = Array.isArray(formData.hscExamOptions) ? formData.hscExamOptions : [];
  const bodyText = String(formData.bodyText || "");

  // Diploma-only HSC/Equivalent level. This is the BOGMC SAE case: the form
  // offers only "Diploma-in-Engineering", so an H.S.C / B.Sc candidate cannot
  // truthfully complete that education row.
  const diplomaOnly =
    hscOptions.length > 0 &&
    hscOptions.every((option) => /diploma|technical|vocational|bteb/i.test(option));

  if (diplomaOnly) {
    const list = hscOptions.map((option) => `"${option}"`).join(", ");
    const qualification = hscOptions.length === 1 ? list : `one of ${list}`;
    warnings.push({
      code: "education-diploma-only",
      text:
        `This post is not for you unless you have ${qualification} — ` +
        `the application form's HSC/Equivalent level only offers ` +
        `${hscOptions.length === 1 ? "that qualification" : "those qualifications"}.`,
    });
  }

  // "Minimum 4 year(s) of experience is mandatory" is rendered on the form
  // itself (Parjatan Programmer is one example).
  const experienceMatch = bodyText.match(
    /minimum\s+(\d+)\s*year(?:\(s\))?\s+(?:of\s+)?experience\b[^\n\r]{0,120}/i
  );
  if (experienceMatch) {
    const years = Number(experienceMatch[1]);
    const required = Number.isFinite(years)
      ? `${years} year${years === 1 ? "" : "s"}`
      : "the stated number of years";
    warnings.push({
      code: "experience-minimum",
      text:
        `This post is not for you if you have less than ${required} of job experience — ` +
        `the application form says "Minimum ${experienceMatch[1]} year(s) of experience is mandatory".`,
    });
  }

  return warnings;
}

async function findOngoingCircularHref(page) {
  return page.evaluate(() => {
    const isExternal = (href) => {
      try {
        const url = new URL(href, location.href);
        return (
          !/(^|\.)teletalk\.com\.bd$/i.test(url.hostname) ||
          /^alljobs\./i.test(url.hostname)
        );
      } catch {
        return true;
      }
    };

    // Preferred path: the first link after the "Ongoing Circular" heading.
    const all = [...document.querySelectorAll("body *")];
    const start = all.findIndex(
      (el) =>
        el.children.length === 0 &&
        /ongoing\s+circular/i.test((el.textContent || "").trim())
    );
    if (start >= 0) {
      const end = Math.min(all.length, start + 300);
      for (let i = start; i < end; i++) {
        const el = all[i];
        if (el.tagName === "A" && el.getAttribute("href") && !isExternal(el.href)) {
          return el.href;
        }
      }
    }

    // Fallback: first circular-looking internal link, skipping Previous ones.
    const links = [...document.querySelectorAll("a[href]")];
    const candidate = links.find((a) => {
      const href = a.getAttribute("href") || "";
      if (!href || href === "#" || isExternal(a.href)) return false;
      if (/previous/i.test(a.innerText || "")) return false;
      return /(index_current\.php|circulars\.php|[^/]*_?20\d{2,6}\/?$)/i.test(href);
    });
    return candidate ? candidate.href : null;
  });
}

async function findApplicationFormHref(page) {
  return page.evaluate(() => {
    const links = [...document.querySelectorAll("a[href]")];
    const exact = links.find((a) =>
      /application\s*form|apply\s*online/i.test(a.innerText || "")
    );
    if (exact) return exact.href;
    const circular = links.find((a) =>
      /circulars\.php/i.test(a.getAttribute("href") || "")
    );
    return circular ? circular.href : null;
  });
}

async function clickNext(page) {
  const button = page
    .locator(
      '#submit, input[type="submit"], button[type="submit"], ' +
        'input[value*="Next" i], button:has-text("Next")'
    )
    .first();

  if (!(await button.count())) {
    throw new Error("Next button not found");
  }

  await button.waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
  const navigation = page
    .waitForNavigation({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT })
    .catch(() => {});

  await button.click({ timeout: 10000 }).catch(async () => {
    await button.click({ force: true, timeout: 10000 }).catch(() => {});
  });

  await navigation;
  await page.waitForTimeout(SETTLE_MS);
}

/**
 * Inspect one job's application form.
 *
 * @param {import("playwright").Page} page A fresh page owned by the caller.
 * @param {object} job Scraped job ({ title, applyUrl, source, ... }).
 * @param {{ log?: Function }} options
 */
export async function inspectJobEligibility(page, job, options = {}) {
  const log = typeof options.log === "function" ? options.log : () => {};
  const checkedAt = new Date().toISOString();
  const unknown = (note) => ({
    status: "unknown",
    warnings: [],
    checkedAt,
    source: "application-form",
    note,
  });

  if (job?.source === "bb") {
    return unknown("Bangladesh Bank job — form pre-check not supported");
  }

  const applyUrl = String(job?.applyUrl || "");
  let parsed;
  try {
    parsed = new URL(applyUrl);
  } catch {
    return unknown("Invalid apply URL");
  }

  if (!/(^|\.)teletalk\.com\.bd$/i.test(parsed.hostname)) {
    return unknown("Not a Teletalk organization portal");
  }
  if (
    /^alljobs\.teletalk\.com\.bd$/i.test(parsed.hostname) &&
    /\/jobs\/government\//i.test(parsed.pathname)
  ) {
    return unknown("No organization application portal");
  }

  page.setDefaultTimeout(15000);
  log(`[Eligibility] Checking application form for "${job.title}"...`);
  let verifyUrl = null;

  try {
    await page.goto(applyUrl, {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT,
    });
    await page.waitForTimeout(SETTLE_MS);

    // 1. Portal home -> ongoing circular page.
    if (!/circulars\.php|posts\.php|premium\.php|application\.php/i.test(page.url())) {
      const href = await findOngoingCircularHref(page);
      if (!href) return unknown("Ongoing circular link not found");
      log(`[Eligibility] Opening ongoing circular: ${href}`);
      await page.goto(href, {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT,
      });
      await page.waitForTimeout(SETTLE_MS);
    }

    // 2. Circular page -> the "Application Form" / circulars.php page.
    if (!/circulars\.php|posts\.php|premium\.php|application\.php/i.test(page.url())) {
      const href = await findApplicationFormHref(page);
      if (!href) return unknown("Application form link not found");
      log(`[Eligibility] Opening application form: ${href}`);
      await page.goto(href, {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT,
      });
      await page.waitForTimeout(SETTLE_MS);
    }

    // 3. circulars.php -> posts.php (choose the only/current circular).
    if (/circulars\.php/i.test(page.url())) {
      const radio = page.locator('input[name="circular_id"]').first();
      if (!(await radio.count())) return unknown("Circular selector not found");
      await radio.check().catch(() => {});
      await clickNext(page);
    }

    // 4. posts.php -> premium.php (choose the matching post).
    if (/posts\.php/i.test(page.url())) {
      const posts = await page.$$eval('input[name="post_code"]', (elements) =>
        elements.map((element) => {
          const label = element.closest("label") || element.parentElement;
          return {
            value: element.value,
            text: label ? label.innerText.trim() : "",
          };
        })
      );

      const index = matchPostTitle(posts, job.title);
      if (index < 0) {
        return unknown(`Post "${job.title}" not found or ambiguous on the circular`);
      }

      log(
        `[Eligibility] Selected post: ${posts[index].text
          .replace(/\s+/g, " ")
          .slice(0, 120)}`
      );
      const radio = page.locator('input[name="post_code"]').nth(index);
      await radio.check().catch(() => {});
      await clickNext(page);
    }

    // A post-specific deep link is more useful in the email than the portal
    // home page. premium.php only contains the public post code, not a
    // session token, so it is safe to keep.
    if (/premium\.php/i.test(page.url())) {
      verifyUrl = page.url();
    }

    // 5. premium.php -> application.php (choose "No" to Alljobs Premium).
    if (/premium\.php/i.test(page.url())) {
      const no = page.locator("#nid_02");
      if (await no.count()) {
        await no.check().catch(() => {});
        await clickNext(page);
      }
    }

    // 6. Read the application form. Never fill or submit it.
    await page.waitForSelector("#name", { timeout: 15000 }).catch(() => {});
    if (!(await page.locator("#name").count())) {
      return unknown(`Application form not reached (ended at ${page.url()})`);
    }

    const formData = await page.evaluate(() => {
      const opts = (selector) => {
        const select = document.querySelector(selector);
        if (!select) return [];
        return [...select.options]
          .map((option) => (option.textContent || "").trim())
          .filter((text) => text && !/^select$/i.test(text));
      };

      return {
        hscExamOptions: opts("#hsc_exam"),
        sscExamOptions: opts("#ssc_exam"),
        graExamOptions: opts("#gra_exam"),
        bodyText: (document.body.innerText || "").slice(0, 60000),
      };
    });

    const warnings = buildEligibilityWarnings(formData);
    const status = warnings.length > 0 ? "restricted" : "clear";
    log(
      `[Eligibility] ${job.title}: ${status}` +
        (warnings.length
          ? ` (${warnings.length} restriction${warnings.length === 1 ? "" : "s"})`
          : "")
    );

    return {
      status,
      warnings,
      checkedAt,
      source: "application-form",
      verifyUrl: verifyUrl || applyUrl,
      hscExamOptions: formData.hscExamOptions,
    };
  } catch (error) {
    return unknown(error?.message || String(error));
  }
}
