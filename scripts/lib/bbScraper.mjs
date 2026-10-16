/**
 * Bangladesh Bank (BB) E-Recruitment Scraper
 * Scrapes: https://erecruitment.bb.org.bd/onlineapp/joblist.php
 *
 * Returns job objects in the same shape as Teletalk jobs so they
 * slot directly into bulkUpsertJobs and the existing dashboard.
 */

const BB_BASE = "https://erecruitment.bb.org.bd";
const BB_LISTING_URL = `${BB_BASE}/onlineapp/joblist.php`;

// Resource types to block for faster loading
const BLOCKED = new Set(["image", "media", "font", "stylesheet"]);

/**
 * The BB portal is protected by an F5 anti-bot layer. Requests coming from
 * cloud/datacenter IP ranges (GitHub Actions, Cloudflare, AWS, ...) receive a
 * CAPTCHA challenge page instead of the real content — even when the request
 * originates from Bangladesh. Detecting it lets callers report the reason
 * clearly instead of silently finding "0 jobs".
 *
 * @returns {Promise<{blocked: boolean, supportId: string|null}>}
 */
export async function detectF5Challenge(page) {
  try {
    const text = await page.evaluate(() =>
      document.body ? document.body.innerText.slice(0, 5000) : ""
    );
    if (/human visitor|support ID|What code is in the image/i.test(text)) {
      const m = text.match(/support ID is:\s*(\d+)/i);
      return { blocked: true, supportId: m ? m[1] : null };
    }
  } catch {
    /* page may already be closed — treat as not blocked */
  }
  return { blocked: false, supportId: null };
}

/**
 * Create a page for BB scraping. If BB_PROXY_URL is set (e.g. a Bangladeshi
 * residential proxy such as http://user:pass@host:port), the page is served
 * through it — the BB portal's anti-bot layer accepts Bangladeshi residential
 * IPs, so a proxy is the way to make this work from cloud runners.
 */
async function newBBPage(browser) {
  const proxyUrl = process.env.BB_PROXY_URL;
  if (!proxyUrl) return { page: await browser.newPage(), context: null };

  const parsed = new URL(proxyUrl);
  const proxy = {
    server: `${parsed.protocol}//${parsed.host}`,
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
  };
  const context = await browser.newContext({ proxy });
  return { page: await context.newPage(), context };
}

async function closeBBPage(page, context) {
  await page.close().catch(() => {});
  if (context) await context.close().catch(() => {});
}

/**
 * Run the BB scraper. Requires an already-open Playwright browser instance.
 * @param {import('playwright').Browser} browser
 * @param {string[]} keywords  - lowercased keyword array (same format as Teletalk)
 * @param {Function} log       - progress logger (msg, opts?) => void
 * @returns {Promise<{ jobs: object[], matchedCount: number, newMatches: object[], seenIds: Set<string> }>}
 */
export async function scrapeBBJobs(browser, keywords, seenIds, log) {
  const { page, context } = await newBBPage(browser);
  page.setDefaultTimeout(35000);

  // Block unnecessary resources for speed
  await page.route("**/*", (route) => {
    if (BLOCKED.has(route.request().resourceType())) return route.abort();
    return route.continue();
  });

  const jobs = [];
  const newMatches = [];

  try {
    log("🏦 [BB] Navigating to Bangladesh Bank e-recruitment portal...");

    await page.goto(BB_LISTING_URL, {
      waitUntil: "domcontentloaded",
      timeout: 35000,
    });

    // F5 anti-bot challenge? Cloud IPs always get the CAPTCHA page.
    const challenge = await detectF5Challenge(page);
    if (challenge.blocked) {
      log(
        "⛔ [BB] The portal served a CAPTCHA challenge instead of the job list — this IP is flagged as a bot (normal for cloud/datacenter IPs). BB scan skipped for this run; the local Bangladeshi runner covers it."
      );
      return {
        jobs: [],
        matchedCount: 0,
        newMatches: [],
        blocked: true,
        blockReason: `F5 CAPTCHA challenge${challenge.supportId ? ` (support ID ${challenge.supportId})` : ""}`,
      };
    }

    // Wait for the job table
    const tableFound = await page
      .waitForSelector("table.pageBodyText", { timeout: 15000 })
      .then(() => true)
      .catch(() => false);

    if (!tableFound) {
      const pageTitle = await page.title().catch(() => "");
      log("⚠️ [BB] Job table not found — the portal may be down or serving different content.");
      return {
        jobs: [],
        matchedCount: 0,
        newMatches: [],
        blocked: false,
        note: `Job table not found (page title: "${pageTitle}")`,
      };
    }

    // Extract all job rows and the section (organization) headers above them
    const rawRows = await page.evaluate((bbBase) => {
      const results = [];
      let currentSection = "Bangladesh Bank";

      const rows = document.querySelectorAll("table.pageBodyText tr");
      for (const row of rows) {
        // Section header rows (colspan, bold advertisement title)
        const headerCell = row.querySelector("td[colspan]");
        if (headerCell) {
          currentSection = headerCell.textContent.trim().replace(/^Advertisement published by:\s*/i, "");
          continue;
        }

        // Skip the column header row
        const thEls = row.querySelectorAll("th");
        if (thEls.length > 0) continue;

        const cells = row.querySelectorAll("td");
        if (cells.length < 8) continue;

        const jobIdRaw = cells[0]?.textContent.trim();
        const positionEl = cells[1];

        // Extract position title (text before the [View Circular] link)
        let positionText = "";
        for (const node of positionEl.childNodes) {
          if (node.nodeType === Node.TEXT_NODE) {
            positionText += node.textContent;
          }
        }
        positionText = positionText.trim().replace(/\s+/g, " ");

        // Extract PDF URL from [View Circular] link
        const circularLink = positionEl.querySelector("a[href*='showpdf']");
        let pdfUrl = null;
        if (circularLink) {
          const href = circularLink.getAttribute("href") || "";
          const pdfMatch = href.match(/showpdf\("([^"]+)"/);
          if (pdfMatch) {
            const rawPath = pdfMatch[1]; // e.g. ../career/20260820_bb_67.pdf
            pdfUrl = bbBase + rawPath.replace(/^\.\./, "");
          }
        }

        // Extract Job ID from the apply onclick
        const applyEl = row.querySelector("a[onclick*='newApply']");
        let applyJobId = jobIdRaw;
        if (applyEl) {
          const onclickMatch = applyEl.getAttribute("onclick")?.match(/newApply\((\d+)/);
          if (onclickMatch) applyJobId = onclickMatch[1];
        }

        const noOfPost = cells[2]?.textContent.trim();
        const salary = cells[3]?.textContent.trim();
        const ageCalc = cells[4]?.textContent.trim();
        const educationalReq = cells[5]?.textContent.trim();
        const payment = cells[6]?.textContent.trim();
        const deadline = cells[7]?.textContent.trim();

        if (!jobIdRaw || !positionText) continue;

        results.push({
          rawId: jobIdRaw,
          applyJobId,
          title: positionText,
          section: currentSection,
          noOfPost,
          salary,
          ageCalc,
          educationalReq,
          payment,
          deadline,
          pdfUrl,
        });
      }
      return results;
    }, BB_BASE);

    log(`🏦 [BB] Found ${rawRows.length} job posting(s) on the portal.`);

    for (const row of rawRows) {
      const id = `BB-${row.applyJobId || row.rawId}`;
      const applyUrl = `${BB_BASE}/onlineapp/new_apply.php?advtno=${row.applyJobId || row.rawId}`;

      // Keyword matching using same logic as Teletalk (word-boundary aware)
      const { isMatch, matchedKeywords } = matchBBKeywords(row.title, row.educationalReq || "", keywords);

      const isNew = !seenIds.has(id);

      const jobObj = {
        id,
        source: "bb",                     // distinguishing field
        title: row.title,
        category: row.section,
        orgId: "bb",
        applyUrl,
        pdfUrl: row.pdfUrl || null,
        deadline: row.deadline || null,
        // BB-specific extra fields
        noOfPost: row.noOfPost || null,
        salary: row.salary || null,
        ageCalc: row.ageCalc || null,
        educationalReq: row.educationalReq || null,
        payment: row.payment || null,
        isMatch,
        matchedKeywords,
      };

      jobs.push(jobObj);

      if (isMatch) {
        const pdfNote = jobObj.pdfUrl ? ` — PDF: ${jobObj.pdfUrl}` : "";
        log(`  🎯 [BB] MATCH: "${row.title}" [${matchedKeywords.join(", ")}] (${isNew ? "NEW" : "SEEN"})${pdfNote}`);
        if (isNew) newMatches.push(jobObj);
      }
    }

    log(`🏦 [BB] Scrape done: ${jobs.length} jobs, ${jobs.filter(j => j.isMatch).length} matched, ${newMatches.length} new.`);
    return { jobs, matchedCount: jobs.filter(j => j.isMatch).length, newMatches };
  } catch (err) {
    log(`❌ [BB] Scraper error: ${err.message}`);
    return { jobs: [], matchedCount: 0, newMatches: [], blocked: false, note: err.message };
  } finally {
    await closeBBPage(page, context);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// BSCS Notice Board Scraper
// Scrapes: https://erecruitment.bb.org.bd/career/jobopportunity_bscs.php
// ─────────────────────────────────────────────────────────────────────────────

const BSCS_URL = `${BB_BASE}/career/jobopportunity_bscs.php`;
const BSCS_PDF_BASE = `${BB_BASE}/career/`;

/**
 * Scrape BSCS notification board. Returns all notices with keyword match flags.
 * @param {import('playwright').Browser} browser
 * @param {string[]} keywords   - lowercased keywords
 * @param {Function} log
 * @returns {Promise<{ notices: object[], matchedCount: number }>}
 */
export async function scrapeBSCSNotices(browser, keywords, log) {
  const { page, context } = await newBBPage(browser);
  page.setDefaultTimeout(35000);

  await page.route("**/*", (route) => {
    if (BLOCKED.has(route.request().resourceType())) return route.abort();
    return route.continue();
  });

  try {
    log("📋 [BSCS] Navigating to BSCS notice board...");
    await page.goto(BSCS_URL, { waitUntil: "domcontentloaded", timeout: 35000 });

    const challenge = await detectF5Challenge(page);
    if (challenge.blocked) {
      log(
        "⛔ [BSCS] The portal served a CAPTCHA challenge instead of the notice board — this IP is flagged as a bot (normal for cloud/datacenter IPs). BSCS scan skipped for this run."
      );
      return {
        notices: [],
        matchedCount: 0,
        blocked: true,
        blockReason: `F5 CAPTCHA challenge${challenge.supportId ? ` (support ID ${challenge.supportId})` : ""}`,
      };
    }

    const tableFound = await page
      .waitForSelector("table.w3-table-all", { timeout: 15000 })
      .then(() => true)
      .catch(() => false);

    if (!tableFound) {
      const pageTitle = await page.title().catch(() => "");
      log("⚠️ [BSCS] Notice table not found — portal may be down or serving different content.");
      return {
        notices: [],
        matchedCount: 0,
        blocked: false,
        note: `Notice table not found (page title: "${pageTitle}")`,
      };
    }

    const rawRows = await page.evaluate((pdfBase) => {
      const rows = document.querySelectorAll("table.w3-table-all tr:not(.bar)");
      const results = [];

      for (const row of rows) {
        const cells = row.querySelectorAll("td");
        if (cells.length < 5) continue;

        const jobId = cells[0]?.textContent.trim();
        const circularFor = cells[1]?.textContent.trim();
        const title = cells[2]?.textContent.trim();

        // Extract PDF filename from onclick or href
        let pdfUrl = null;
        const onclickEl = cells[3]?.querySelector("a[onclick]");
        if (onclickEl) {
          const m = onclickEl.getAttribute("onclick")?.match(/showpdf\('([^']+)'\)/);
          if (m) pdfUrl = pdfBase + m[1];
        }
        // Fallback: direct download href
        if (!pdfUrl) {
          const dlLink = cells[3]?.querySelector("a[href]");
          if (dlLink) {
            const href = dlLink.getAttribute("href") || "";
            if (href.endsWith(".pdf")) pdfUrl = href.startsWith("http") ? href : pdfBase + href;
          }
        }

        const publishDate = cells[4]?.textContent.trim();
        const closeDate = cells[5]?.textContent.trim();

        if (!jobId || !title) continue;
        results.push({ jobId, circularFor, title, pdfUrl, publishDate, closeDate });
      }
      return results;
    }, BSCS_PDF_BASE);

    log(`📋 [BSCS] Found ${rawRows.length} notice(s) on the board.`);

    const notices = rawRows.map((row) => {
      const { isMatch, matchedKeywords } = matchBBKeywords(row.title, "", keywords);
      return {
        id: `BSCS-${row.jobId}-${row.circularFor?.replace(/\s+/g, "-").toLowerCase()}`,
        jobId: row.jobId,
        source: "bscs",
        circularFor: row.circularFor,
        title: row.title,
        pdfUrl: row.pdfUrl,
        publishDate: row.publishDate,
        closeDate: row.closeDate,
        isMatch,
        matchedKeywords,
        scrapedAt: new Date().toISOString(),
      };
    });

    const matchedCount = notices.filter((n) => n.isMatch).length;
    if (matchedCount > 0) {
      log(`📋 [BSCS] 🎯 ${matchedCount} notice(s) match your keywords!`);
    }
    log(`📋 [BSCS] Complete: ${notices.length} notices, ${matchedCount} matched.`);

    return { notices, matchedCount };
  } catch (err) {
    log(`❌ [BSCS] Error: ${err.message}`);
    return { notices: [], matchedCount: 0, blocked: false, note: err.message };
  } finally {
    await closeBBPage(page, context);
  }
}

/**
 * Keyword matching for BB jobs — checks both title AND educational requirements
 * (so future IT/CSE posts with "software", "programmer" in requirements also match).
 */
export function matchBBKeywords(title = "", educationalReq = "", keywords = []) {
  const combined = `${title} ${educationalReq}`;
  const haystack = combined.toLowerCase();
  const matched = [];

  for (const k of keywords) {
    const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu");
    if (re.test(haystack)) {
      matched.push(k);
    }
  }

  // Bank IT posts in the title: e.g. "(IT)", "Officer (IT)", "Senior Officer (IT)", "IT Officer", "ICT"
  const bankITRegex = /(\(it\)|officer\s*\(\s*it\s*\)|senior\s+officer\s*\(\s*it\s*\)|\bit\s+officer\b|\bict\b)/i;
  if (bankITRegex.test(combined)) {
    if (!matched.some((m) => m.toLowerCase() === "it" || m.toLowerCase().includes("it"))) {
      matched.push("IT");
    }
  }

  // Bank CSE/IT titles that reliable bank circulars use but that may not
  // mention any keyword in their requirement text. Scanned against the TITLE
  // only — in requirement text these terms would be too noisy (e.g. "computer
  // literacy" appears in non-CSE posts).
  const bankCSETitles =
    /(\bsystem\s+(manager|engineer|analyst)\b|\bcomputer\s+(engineer|science)\b|\binformation\s+(technology|security)\b|\bsoftware\b|\bdeveloper\b|\bnetwork\s+engineer\b|\bhardware\s+engineer\b|\bdatabase\s+administrator\b|\bdata\s+scientist\b|\bcyber\s+security\b)/i;
  if (bankCSETitles.test(title)) {
    if (!matched.length) matched.push("CSE role");
  }

  return { isMatch: matched.length > 0, matchedKeywords: matched };
}
