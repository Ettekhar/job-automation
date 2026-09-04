import "dotenv/config";
import { chromium } from "playwright";
import fs from "node:fs/promises";
import { notifyJob } from "../notify.mjs";
import {
  SEEN_PATH,
  readJson,
  writeJson,
  bulkUpsertJobs,
  recordScrapeRun,
  getKeywords,
  getSettings,
  saveNotices,
} from "./store.mjs";
import { scrapeBBJobs, scrapeBSCSNotices } from "./bbScraper.mjs";

const BASE = "https://alljobs.teletalk.com.bd";
const LISTING_URL = `${BASE}/jobs/government`;

// How many circulars to process in parallel (separate pages sharing one browser).
// Override with SCRAPE_CONCURRENCY env var if the host can take more/less load.
const CONCURRENCY = Number(process.env.SCRAPE_CONCURRENCY) || 6;

// Resource types we never need for scraping — blocking them cuts page-load time drastically.
const BLOCKED_RESOURCE_TYPES = new Set(["image", "media", "font", "stylesheet"]);

export function matchesKeywords(title, keywords) {
  const haystack = title || "";
  const matched = [];
  for (const k of keywords) {
    const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu");
    if (re.test(haystack)) {
      matched.push(k);
    }
  }
  return { isMatch: matched.length > 0, matchedKeywords: matched };
}

/**
 * Run `fn` over `items` with at most `limit` concurrent in-flight calls.
 * Preserves input order in the returned array. Errors are caught per-item
 * so one bad page doesn't kill the whole batch.
 */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      try {
        results[idx] = { ok: true, value: await fn(items[idx], idx) };
      } catch (err) {
        results[idx] = { ok: false, error: err };
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

async function newFastPage(browser) {
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);
  await page.route("**/*", (route) => {
    const type = route.request().resourceType();
    if (BLOCKED_RESOURCE_TYPES.has(type)) {
      return route.abort();
    }
    return route.continue();
  });
  return page;
}

export async function runScraper(options = {}) {
  const {
    dryRun = false,
    ignoreSeen = false,
    verbose = false,
    onProgress = () => { },
  } = options;

  const startTime = Date.now();
  const log = (msg, data = {}) => {
    const timeStr = new Date().toLocaleTimeString();
    const entry = { time: timeStr, message: msg, ...data };
    if (verbose || !data.silent) {
      console.log(`[${timeStr}] ${msg}`);
    }
    onProgress(entry);
  };

  log(`🚀 Starting Teletalk scrape (${dryRun ? "DRY RUN" : "LIVE MODE"})...`);

  const [seenList, rawKeywords, settings] = await Promise.all([
    readJson(SEEN_PATH, []),
    getKeywords(),
    getSettings(),
  ]);

  const seenIds = new Set(ignoreSeen ? [] : seenList);
  const keywords = rawKeywords.map((k) => k.toLowerCase());

  log(`Loaded ${keywords.length} target keywords and ${seenIds.size} previously seen job IDs.`);

  let browser = null;
  const allScrapedJobs = [];
  const newMatches = [];
  const stats = {
    circularsScanned: 0,
    totalPostsFound: 0,
    matchedPosts: 0,
    newMatchingPosts: 0,
    notificationsSent: 0,
    bbJobsFound: 0,
    bbMatchedPosts: 0,
    bbNewMatches: 0,
    errors: [],
  };

  try {
    log("Launching headless browser...");
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    // Listing pagination stays on one dedicated page — page numbers must be
    // discovered sequentially since we don't know the total count up front.
    const listingPage = await newFastPage(browser);
    log("Scanning government circulars listing...");
    const circulars = await getAllCirculars(listingPage, log);
    await listingPage.close().catch(() => { });
    stats.circularsScanned = circulars.length;
    log(`Found ${circulars.length} organization circular(s) to process. Processing with concurrency=${CONCURRENCY}...`);

    let processed = 0;
    const results = await mapWithConcurrency(circulars, CONCURRENCY, async (circular) => {
      const page = await newFastPage(browser);
      try {
        const posts = await getPostsForCircular(page, circular.url);
        const circularJobs = [];
        const circularNewMatches = [];
        let matchedCount = 0;

        for (const post of posts) {
          const uid = post.jobId;
          if (!uid || !post.title) continue;

          const { isMatch, matchedKeywords } = matchesKeywords(post.title, keywords);
          if (isMatch) matchedCount++;

          let detail = { organization: null, applyUrl: null, pdfUrl: null, deadline: null };

          if (isMatch || posts.length <= 5) {
            try {
              const detailUrl = `${BASE}/jobs/government/${circular.orgId}?jobId=${post.jobIdNumber}`;
              detail = await getPostDetail(page, detailUrl);
            } catch (dErr) {
              log(`⚠️ Could not fetch detail for ${post.title}: ${dErr.message}`);
            }
          }

          const jobObj = {
            id: uid,
            title: post.title,
            category: detail.organization || circular.orgId || "Government",
            orgId: circular.orgId,
            applyUrl: detail.applyUrl || `${BASE}/jobs/government/${circular.orgId}?jobId=${post.jobIdNumber}`,
            pdfUrl: detail.pdfUrl || null,
            deadline: detail.deadline || null,
            isMatch,
            matchedKeywords,
          };

          circularJobs.push(jobObj);

          if (isMatch) {
            const isNew = !seenIds.has(uid);
            const pdfSuffix = jobObj.pdfUrl ? ` — PDF: ${jobObj.pdfUrl}` : "";
            log(`  🎯 MATCH: "${post.title}" [${matchedKeywords.join(", ")}] (${isNew ? "NEW" : "SEEN"})${pdfSuffix}`);
            if (isNew) circularNewMatches.push(jobObj);
          }
        }

        processed++;
        log(`[${processed}/${circulars.length}] Done: ${circular.orgId || circular.url} (${posts.length} posts, ${matchedCount} matched)`, { silent: true });

        return { posts, circularJobs, circularNewMatches };
      } finally {
        await page.close().catch(() => { });
      }
    });

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const circular = circulars[i];
      if (!r.ok) {
        log(`⚠️ Error processing circular ${circular.url}: ${r.error.message}`);
        stats.errors.push(`Circular ${circular.url}: ${r.error.message}`);
        continue;
      }
      const { posts, circularJobs, circularNewMatches } = r.value;
      stats.totalPostsFound += posts.length;
      stats.matchedPosts += circularJobs.filter((j) => j.isMatch).length;
      stats.newMatchingPosts += circularNewMatches.length;
      allScrapedJobs.push(...circularJobs);
      newMatches.push(...circularNewMatches);
    }

    log(`Scrape finished. Found ${stats.totalPostsFound} posts across ${stats.circularsScanned} circulars.`);
    log(`Total Matches: ${stats.matchedPosts} (${stats.newMatchingPosts} new).`);

    // ─── Bangladesh Bank Scraper ───────────────────────────────────────────────
    log("🏦 Starting Bangladesh Bank e-recruitment scrape...");
    try {
      const bbResult = await scrapeBBJobs(browser, keywords, seenIds, log);
      stats.bbJobsFound = bbResult.jobs.length;
      stats.bbMatchedPosts = bbResult.matchedCount;
      stats.bbNewMatches = bbResult.newMatches.length;
      allScrapedJobs.push(...bbResult.jobs);
      newMatches.push(...bbResult.newMatches);
      // Update aggregate stats to include BB counts
      stats.totalPostsFound += bbResult.jobs.length;
      stats.matchedPosts += bbResult.matchedCount;
      stats.newMatchingPosts += bbResult.newMatches.length;
      log(`🏦 [BB] Complete: ${bbResult.jobs.length} jobs, ${bbResult.matchedCount} matched, ${bbResult.newMatches.length} new.`);
    } catch (bbErr) {
      log(`⚠️ [BB] Scrape failed: ${bbErr.message}`);
      stats.errors.push(`BB Scraper: ${bbErr.message}`);
    }
    // ──────────────────────────────────────────────────────────────────────────

    // ─── BSCS Notice Board ────────────────────────────────────────────────────
    log("📋 Scraping BSCS Notice Board...");
    try {
      const bscsResult = await scrapeBSCSNotices(browser, keywords, log);
      if (bscsResult.notices.length > 0) {
        await saveNotices(bscsResult.notices);
      }
      stats.bscsNotices = bscsResult.notices.length;
      stats.bscsMatched = bscsResult.matchedCount;
      log(`📋 [BSCS] Saved ${bscsResult.notices.length} notices (${bscsResult.matchedCount} keyword matches).`);
    } catch (bscsErr) {
      log(`⚠️ [BSCS] Notice scrape failed: ${bscsErr.message}`);
      stats.errors.push(`BSCS: ${bscsErr.message}`);
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Notifications phase — sent sequentially to avoid hammering the mail provider,
    // but this is cheap relative to scraping so it's left as-is.
    if (newMatches.length > 0) {
      log(`Sending notifications for ${newMatches.length} new matching job(s)...`);
      for (const job of newMatches) {
        if (dryRun) {
          log(`[DRY-RUN] Would notify for: "${job.title}" at ${job.category}`);
        } else {
          try {
            log(`📧 Sending email notification for: "${job.title}"...`);
            const notifyResult = await notifyJob(job, settings.notifyEmail);
            if (notifyResult?.results?.some((r) => r.success)) {
              stats.notificationsSent++;
              job.notifiedAt = new Date().toISOString();
              log(`✅ Notification delivered for: "${job.title}"`);
            } else if (notifyResult?.errors?.length) {
              log(`❌ Notification failed for "${job.title}": ${notifyResult.errors.join(", ")}`);
            }
            seenIds.add(job.id);
          } catch (nErr) {
            log(`❌ Failed to send notification for ${job.title}: ${nErr.message}`);
            stats.errors.push(`Notify ${job.id}: ${nErr.message}`);
          }
        }
      }
    } else {
      log("No new matching jobs to notify.");
    }

    // Persist all scraped jobs to disk
    if (allScrapedJobs.length > 0) {
      await bulkUpsertJobs(allScrapedJobs);
    }

    // Persist seen jobs if not dry run
    if (!dryRun) {
      const trimmed = Array.from(seenIds).slice(-3000);
      await writeJson(SEEN_PATH, trimmed);
    }

    const durationSeconds = Math.round((Date.now() - startTime) / 1000);
    const summary = {
      status: "completed",
      dryRun,
      durationSeconds,
      ...stats,
      matchedJobTitles: newMatches.map((m) => m.title),
      matchedJobPdfUrls: newMatches.map((m) => m.pdfUrl),
    };

    await recordScrapeRun(summary);
    log(`✨ Scrape cycle completed in ${durationSeconds}s.`);
    return summary;
  } catch (err) {
    const durationSeconds = Math.round((Date.now() - startTime) / 1000);
    log(`❌ Scrape encountered a fatal error: ${err.message}`);
    const summary = {
      status: "failed",
      error: err.message,
      dryRun,
      durationSeconds,
      ...stats,
    };
    await recordScrapeRun(summary);
    throw err;
  } finally {
    if (browser) {
      await browser.close().catch(() => { });
    }
  }
}

async function getAllCirculars(page, log) {
  const circulars = [];
  let pageNum = 1;

  while (true) {
    const url = pageNum === 1 ? LISTING_URL : `${LISTING_URL}?page=${pageNum}`;
    log(`Fetching listing page ${pageNum}...`, { silent: true });

    try {
      // domcontentloaded + an explicit selector wait is far faster than
      // networkidle, which stalls until all background polling/analytics
      // requests go quiet (often several extra seconds per page).
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    } catch (e) {
      log(`Timeout or error loading page ${pageNum}, checking content...`);
    }

    const hasCards = await page
      .waitForSelector(".job-wrapper", { timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    if (!hasCards) break;

    const pageCirculars = await page.$$eval(".job-wrapper", (wrappers) =>
      wrappers
        .map((w) => {
          const linkEl = w.querySelector("a.job-card");
          const href = linkEl ? linkEl.getAttribute("href") : null;
          return href ? new URL(href, location.origin).href : null;
        })
        .filter(Boolean)
    );

    if (pageCirculars.length === 0) break;

    for (const url of pageCirculars) {
      const orgId = new URL(url).pathname.split("/").filter(Boolean).pop();
      circulars.push({ url, orgId });
    }

    pageNum += 1;
    if (pageNum > 50) break;
  }

  return circulars;
}

async function getPostsForCircular(page, circularUrl) {
  await page.goto(circularUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

  const found = await page
    .waitForSelector(".job-card-wrapper .job-card-container", {
      timeout: 12000,
    })
    .then(() => true)
    .catch(() => false);
  if (!found) return [];

  return page.$$eval(".job-card-wrapper .job-card-container", (cards) =>
    cards.map((c) => {
      const titleEl = c.querySelector(".job-content h3");
      const idEl = c.querySelector(".org-name p");
      const idText = idEl ? idEl.textContent.trim() : "";
      const match = idText.match(/GJOB(\d+)/);
      return {
        title: titleEl ? titleEl.textContent.trim() : null,
        jobId: match ? `GJOB${match[1]}` : null,
        jobIdNumber: match ? match[1] : null,
      };
    })
  );
}

async function getPostDetail(page, detailUrl) {
  await page.goto(detailUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page
    .waitForSelector(".right-side-details .card-title", { timeout: 12000 })
    .catch(() => { });

  return page.evaluate(() => {
    const root = document.querySelector(".right-side-details");
    if (!root) return {};

    const organization = root.querySelector(".card-about")?.textContent.trim();
    const applyUrl = root.querySelector(".apply-online")?.getAttribute("href");
    const pdfUrl = root.querySelector(".iframe-wrapper iframe")?.getAttribute("src");
    const deadlineText = root.querySelector(".deadline")?.textContent.trim();

    return { organization, applyUrl, pdfUrl, deadline: deadlineText };
  });
}
