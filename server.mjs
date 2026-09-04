import "dotenv/config";
import express from "express";
import cookieParser from "cookie-parser";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  getStoredJobs,
  getScrapeHistory,
  getKeywords,
  saveKeywords,
  getSettings,
  saveSettings,
  SEEN_PATH,
  readJson,
  writeJson,
  bulkUpsertJobs,
  getNotices,
  saveNotices,
  getProfile,
  getProfileExample,
  saveProfile,
  deleteProfile,
  getAppliedJobs,
  saveAppliedJobs,
  addOrUpdateAppliedJob,
  deleteAppliedJob,
  getSeenNotices,
  saveSeenNotices,
} from "./scripts/lib/store.mjs";
import { runScraper } from "./scripts/lib/scraperCore.mjs";
import { testSmtpConnection, notifyJob, notifyBankNotice } from "./scripts/notify.mjs";
import { getAIConfig, saveAIConfig, testAIProvider } from "./scripts/lib/aiService.mjs";
import { scrapeBBJobs, scrapeBSCSNotices } from "./scripts/lib/bbScraper.mjs";
import { chromium } from "playwright";
import {
  generateToken,
  verifyToken,
  setSessionCookie,
  clearSessionCookie,
  authMiddleware,
  isEmailAllowed,
  getGoogleAuthUrl,
  exchangeGoogleCode,
} from "./scripts/lib/auth.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

// Serve login page at /login (also available as /login.html via static)
app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

// State in-memory for active scrape and SSE subscribers
let isScraping = false;
let currentScrapePromise = null;
let liveLogs = [];
let sseClients = [];
let schedulerTimer = null;
let nextScheduledRunTime = null;

function broadcastLog(logEntry) {
  liveLogs.push(logEntry);
  if (liveLogs.length > 200) liveLogs.shift();

  const data = JSON.stringify(logEntry);
  sseClients.forEach((res) => {
    res.write(`data: ${data}\n\n`);
  });
}

// -------------------------------------------------------------
// Scheduler Logic
// -------------------------------------------------------------
async function initScheduler() {
  const settings = await getSettings();
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }

  if (settings.autoScrapeEnabled && settings.autoScrapeIntervalMinutes > 0) {
    const intervalMs = settings.autoScrapeIntervalMinutes * 60 * 1000;

    // Check when the last scrape occurred to determine true next run
    const history = await getScrapeHistory(1);
    const lastRunTimestamp = history[0]?.timestamp ? new Date(history[0].timestamp).getTime() : 0;
    const elapsedSinceLastRun = Date.now() - lastRunTimestamp;

    if (lastRunTimestamp > 0 && elapsedSinceLastRun < intervalMs) {
      nextScheduledRunTime = new Date(lastRunTimestamp + intervalMs).toISOString();
    } else {
      // Overdue or initial run: schedule shortly (15s) after server boot
      nextScheduledRunTime = new Date(Date.now() + 15 * 1000).toISOString();
    }

    console.log(`[Scheduler] Auto-scrape enabled: runs every ${settings.autoScrapeIntervalMinutes}m (${(settings.autoScrapeIntervalMinutes / 60).toFixed(1)}h).`);
    console.log(`[Scheduler] Next run at: ${nextScheduledRunTime}`);

    // Heartbeat check every 60s: protects against Windows sleep, hibernate, and clock drift
    schedulerTimer = setInterval(async () => {
      if (isScraping) return;

      const currentSettings = await getSettings();
      if (!currentSettings.autoScrapeEnabled || !currentSettings.autoScrapeIntervalMinutes) {
        return;
      }

      const checkHistory = await getScrapeHistory(1);
      const lastScrapeTime = checkHistory[0]?.timestamp ? new Date(checkHistory[0].timestamp).getTime() : 0;
      const targetInterval = currentSettings.autoScrapeIntervalMinutes * 60 * 1000;

      if (Date.now() - lastScrapeTime >= targetInterval) {
        console.log("[Scheduler] Interval elapsed. Triggering automatic scheduled job scrape...");
        try {
          await executeScrape({ dryRun: false, ignoreSeen: false, trigger: "scheduler" });
        } catch (err) {
          console.error("[Scheduler] Scrape execution error:", err);
        }
      }

      // Update next scheduled run display time for dashboard
      const freshHistory = await getScrapeHistory(1);
      const latestTime = freshHistory[0]?.timestamp ? new Date(freshHistory[0].timestamp).getTime() : Date.now();
      nextScheduledRunTime = new Date(latestTime + targetInterval).toISOString();
    }, 60 * 1000);
  } else {
    nextScheduledRunTime = null;
    console.log("[Scheduler] Auto-scrape is disabled.");
  }
}

async function executeScrape(options = {}) {
  if (isScraping) {
    return { success: false, message: "Scraper is already currently executing." };
  }

  isScraping = true;
  liveLogs = [];
  broadcastLog({ time: new Date().toLocaleTimeString(), message: `Starting scrape (${options.dryRun ? 'Dry Run' : 'Live Mode'})...` });

  currentScrapePromise = runScraper({
    dryRun: options.dryRun || false,
    ignoreSeen: options.ignoreSeen || false,
    verbose: true,
    onProgress: (entry) => {
      broadcastLog(entry);
    },
  })
    .then((summary) => {
      isScraping = false;
      broadcastLog({ time: new Date().toLocaleTimeString(), message: "Scrape finished successfully!", isComplete: true, summary });
      return summary;
    })
    .catch((err) => {
      isScraping = false;
      broadcastLog({ time: new Date().toLocaleTimeString(), message: `Scrape failed: ${err.message}`, isError: true });
      throw err;
    });

  return currentScrapePromise;
}

// -------------------------------------------------------------
// AUTH Routes (public — no authMiddleware here)
// -------------------------------------------------------------

// Status: Is Google configured? Is the user logged in?
app.get("/api/auth/status", async (req, res) => {
  const googleConfigured = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  const token = req.cookies?.["__session"];
  const user = token ? await verifyToken(token) : null;
  res.json({ googleConfigured, user: user ? { email: user.email, name: user.name, picture: user.picture } : null });
});

// Google OAuth redirect
app.get("/api/auth/google", (req, res) => {
  try {
    const url = getGoogleAuthUrl();
    res.redirect(url);
  } catch (err) {
    console.error("[Auth] Google redirect error:", err.message);
    res.redirect("/login?error=oauth_failed");
  }
});

// Google OAuth callback
app.get("/api/auth/google/callback", async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) {
    return res.redirect("/login?error=oauth_failed");
  }
  try {
    const userInfo = await exchangeGoogleCode(code);
    if (!isEmailAllowed(userInfo.email)) {
      console.warn(`[Auth] Blocked login for non-allowed email: ${userInfo.email}`);
      return res.redirect("/login?error=not_allowed");
    }
    const token = await generateToken(userInfo);
    setSessionCookie(res, token);
    console.log(`[Auth] Google login: ${userInfo.email}`);
    res.redirect("/");
  } catch (err) {
    console.error("[Auth] Google callback error:", err.message);
    res.redirect("/login?error=oauth_failed");
  }
});

// Local password login
app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body || {};
  const expectedUser = process.env.DASHBOARD_USER || "admin";
  const expectedPass = process.env.DASHBOARD_PASS;

  if (!expectedPass) {
    return res.status(503).json({ success: false, error: "Local login is not configured. Set DASHBOARD_PASS in .env" });
  }

  if (username !== expectedUser || password !== expectedPass) {
    return res.status(401).json({ success: false, error: "Invalid username or password." });
  }

  const token = await generateToken({ email: `${username}@local`, name: username, picture: null });
  setSessionCookie(res, token);
  console.log(`[Auth] Local login: ${username}`);
  res.json({ success: true, user: { email: `${username}@local`, name: username } });
});

// Logout
app.get("/api/auth/logout", (req, res) => {
  clearSessionCookie(res);
  res.redirect("/login");
});

app.post("/api/auth/logout", (req, res) => {
  clearSessionCookie(res);
  res.json({ success: true });
});

// Current user info
app.get("/api/auth/me", authMiddleware, (req, res) => {
  res.json({ success: true, user: req.user });
});

// -------------------------------------------------------------
// Protect all remaining /api/* routes with authMiddleware
// -------------------------------------------------------------
app.use("/api", authMiddleware);

// -------------------------------------------------------------
// REST API Endpoints
// -------------------------------------------------------------

// 1. Overview stats
app.get("/api/overview", async (req, res) => {
  try {
    const [jobs, history, seenList, keywords, settings, notices, currentProfile] = await Promise.all([
      getStoredJobs(),
      getScrapeHistory(1),
      readJson(SEEN_PATH, []),
      getKeywords(),
      getSettings(),
      getNotices(),
      getProfile(),
    ]);

    const totalJobs = jobs.length;
    const matchedJobs = jobs.filter((j) => j.isMatch).length;
    const bbJobs = jobs.filter((j) => j.source === "bb").length;
    const noticesCount = notices.length;
    const matchedNoticesCount = notices.filter((n) => n.isMatch).length;
    const lastScrape = history[0] || null;

    // Today's jobs
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const newToday = jobs.filter((j) => new Date(j.firstSeenAt) >= startOfToday).length;

    res.json({
      success: true,
      stats: {
        totalJobs,
        matchedJobs,
        bbJobs,
        noticesCount,
        matchedNoticesCount,
        seenCount: seenList.length,
        newToday,
        keywordsCount: keywords.length,
        hasProfile: Boolean(currentProfile),
        profileName: currentProfile?.name_en || null,
      },
      lastScrape: lastScrape
        ? {
          timestamp: lastScrape.timestamp,
          durationSeconds: lastScrape.durationSeconds,
          circularsScanned: lastScrape.circularsScanned,
          totalPostsFound: lastScrape.totalPostsFound,
          matchedPosts: lastScrape.matchedPosts,
          newMatchingPosts: lastScrape.newMatchingPosts,
          status: lastScrape.status,
        }
        : null,
      scraper: {
        isScraping,
        logsCount: liveLogs.length,
      },
      scheduler: {
        enabled: settings.autoScrapeEnabled,
        intervalMinutes: settings.autoScrapeIntervalMinutes,
        nextRunTime: nextScheduledRunTime,
      },
      smtp: {
        host: settings.smtpHost || process.env.SMTP_HOST || "smtp.titan.email",
        port: settings.smtpPort || parseInt(process.env.SMTP_PORT || "587", 10),
        user: settings.smtpUser || process.env.SMTP_USER || "taion@razibmarketing.net",
        notifyEmail: settings.notifyEmail || process.env.NOTIFY_EMAIL || "taion@razibmarketing.net",
        configured: Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Jobs list with search & filters
app.get("/api/jobs", async (req, res) => {
  try {
    const { filter = "matched", q = "", org = "", source = "", limit = 200 } = req.query;
    let jobs = await getStoredJobs();

    // Source filter (e.g. source=bb or source=teletalk)
    if (source === "bb") {
      jobs = jobs.filter((j) => j.source === "bb");
    } else if (source === "teletalk") {
      jobs = jobs.filter((j) => j.source !== "bb");
    }

    if (filter === "matched") {
      jobs = jobs.filter((j) => j.isMatch);
    } else if (filter === "unmatched") {
      jobs = jobs.filter((j) => !j.isMatch);
    } else if (filter === "bb") {
      jobs = jobs.filter((j) => j.source === "bb");
    }

    if (org) {
      jobs = jobs.filter((j) => (j.category || "").toLowerCase().includes(org.toLowerCase()));
    }

    if (q) {
      const search = q.toLowerCase();
      jobs = jobs.filter(
        (j) =>
          (j.title && j.title.toLowerCase().includes(search)) ||
          (j.category && j.category.toLowerCase().includes(search)) ||
          (j.id && j.id.toLowerCase().includes(search)) ||
          (j.matchedKeywords && j.matchedKeywords.some((k) => k.toLowerCase().includes(search)))
      );
    }

    res.json({
      success: true,
      total: jobs.length,
      jobs: jobs.slice(0, parseInt(limit, 10)),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Helper: match notices against user's applied jobs and notify via email for new ones
async function matchAndNotifyAppliedNotices(notices, notifyEmail = null) {
  const appliedJobs = await getAppliedJobs();
  if (!appliedJobs || appliedJobs.length === 0) {
    return notices;
  }

  const seenNoticesList = await getSeenNotices();
  const seenNotices = new Set(seenNoticesList);
  const recipient = notifyEmail || process.env.NOTIFY_EMAIL || "taion@razibmarketing.net";

  const enriched = notices.map((notice) => {
    const nJobId = String(notice.jobId || "").trim().toLowerCase();
    const nTitle = String(notice.title || "").toLowerCase();

    // Match priority: Job ID code match (e.g. 10225, 10226), then title match
    const match = appliedJobs.find((app) => {
      const appJobId = String(app.jobId || "").trim().toLowerCase();
      if (appJobId && nJobId && appJobId === nJobId) return true;
      if (appJobId && appJobId.length >= 3) {
        const re = new RegExp(`\\b${appJobId}\\b`, "i");
        if (re.test(nTitle)) return true;
      }
      return false;
    });

    if (match) {
      return {
        ...notice,
        isAppliedMatch: true,
        appliedJobId: match.jobId,
        appliedJobTitle: match.title,
        appliedJobOrg: match.organization,
        appliedJobRoll: match.rollNo || "",
        appliedJobTracking: match.trackingNo || "",
        appliedJobNotes: match.notes || "",
        appliedJob: match,
      };
    }

    return {
      ...notice,
      isAppliedMatch: false,
    };
  });

  // Check if any matching applied notices need to be notified via email
  for (const notice of enriched) {
    if (notice.isAppliedMatch && notice.appliedJob) {
      const noticeKey = `notice_${notice.id || notice.jobId}_${notice.publishDate || ""}`;
      if (!seenNotices.has(noticeKey)) {
        try {
          console.log(`[BB Notice Alert] 🚨 Found notice for Applied Job ID ${notice.appliedJob.jobId}! Sending alert email to ${recipient}...`);
          const res = await notifyBankNotice(notice, notice.appliedJob, recipient);
          if (res.success) {
            seenNotices.add(noticeKey);
            broadcastLog({
              time: new Date().toLocaleTimeString(),
              message: `⭐ [BB Alert] Email sent to ${recipient} for Applied Job (${notice.appliedJob.jobId}): "${notice.title.slice(0, 50)}..."`,
            });
          }
        } catch (err) {
          console.error(`[BB Notice Alert] Failed to send email:`, err);
        }
      }
    }
  }

  await saveSeenNotices(Array.from(seenNotices));
  return enriched;
}

// 2b. Bangladesh Bank BSCS Notices (with Applied Jobs matching)
app.get("/api/bb/notices", async (req, res) => {
  try {
    const { filter = "all", q = "", limit = 200 } = req.query;
    let notices = await getNotices();
    const appliedJobs = await getAppliedJobs();

    // Enrich with current applied job matches in real-time
    notices = notices.map((n) => {
      const nJobId = String(n.jobId || "").trim().toLowerCase();
      const nTitle = String(n.title || "").toLowerCase();

      const match = appliedJobs.find((app) => {
        const appJobId = String(app.jobId || "").trim().toLowerCase();
        if (appJobId && nJobId && appJobId === nJobId) return true;
        if (appJobId && appJobId.length >= 3) {
          const re = new RegExp(`\\b${appJobId}\\b`, "i");
          if (re.test(nTitle)) return true;
        }
        return false;
      });

      if (match) {
        return {
          ...n,
          isAppliedMatch: true,
          appliedJobId: match.jobId,
          appliedJobTitle: match.title,
          appliedJobOrg: match.organization,
          appliedJobRoll: match.rollNo || "",
          appliedJobTracking: match.trackingNo || "",
          appliedJob: match,
        };
      }
      return { ...n, isAppliedMatch: false };
    });

    const totalCount = notices.length;
    const matchedCount = notices.filter((n) => n.isMatch).length;
    const appliedMatchesCount = notices.filter((n) => n.isAppliedMatch).length;

    if (filter === "matched") {
      notices = notices.filter((n) => n.isMatch);
    } else if (filter === "applied") {
      notices = notices.filter((n) => n.isAppliedMatch);
    }

    if (q) {
      const search = q.toLowerCase();
      notices = notices.filter(
        (n) =>
          (n.title && n.title.toLowerCase().includes(search)) ||
          (n.circularFor && n.circularFor.toLowerCase().includes(search)) ||
          (n.jobId && String(n.jobId).toLowerCase().includes(search)) ||
          (n.appliedJobTitle && n.appliedJobTitle.toLowerCase().includes(search)) ||
          (n.matchedKeywords && n.matchedKeywords.some((k) => k.toLowerCase().includes(search)))
      );
    }

    res.json({
      success: true,
      total: totalCount,
      matched: matchedCount,
      appliedMatches: appliedMatchesCount,
      appliedJobsCount: appliedJobs.length,
      notices: notices.slice(0, parseInt(limit, 10)),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2c. Applied Bank Jobs Management API
app.get("/api/bb/applied-jobs", async (req, res) => {
  try {
    const appliedJobs = await getAppliedJobs();
    const notices = await getNotices();

    // Attach notice counts for each applied job
    const enriched = appliedJobs.map((app) => {
      const appJobId = String(app.jobId || "").trim().toLowerCase();
      const matchingNotices = notices.filter((n) => {
        const nJobId = String(n.jobId || "").trim().toLowerCase();
        if (appJobId && nJobId && appJobId === nJobId) return true;
        if (appJobId && appJobId.length >= 3 && n.title) {
          return new RegExp(`\\b${appJobId}\\b`, "i").test(n.title);
        }
        return false;
      });

      return {
        ...app,
        noticesCount: matchingNotices.length,
        latestNotice: matchingNotices[0] || null,
      };
    });

    res.json({
      success: true,
      count: enriched.length,
      appliedJobs: enriched,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/bb/applied-jobs", async (req, res) => {
  try {
    const { jobId, title, organization, rollNo, trackingNo, appliedDate, notes, sendEmailImmediately = true } = req.body;
    if (!jobId || !String(jobId).trim()) {
      return res.status(400).json({ success: false, error: "Job ID code is required (e.g. 10225, 10226)" });
    }

    const saved = await addOrUpdateAppliedJob({
      jobId: String(jobId).trim(),
      title: title || "Bank Job",
      organization: organization || "Bangladesh Bank / BSCS",
      rollNo: rollNo || "",
      trackingNo: trackingNo || "",
      appliedDate: appliedDate || new Date().toISOString().split("T")[0],
      notes: notes || "",
    });

    // Check existing notices for matches
    const settings = await getSettings();
    const notices = await getNotices();
    const matchingNotices = notices.filter((n) => {
      const nJobId = String(n.jobId || "").trim().toLowerCase();
      const appJobId = String(saved.jobId).toLowerCase();
      return nJobId === appJobId || (appJobId.length >= 3 && new RegExp(`\\b${appJobId}\\b`, "i").test(n.title || ""));
    });

    // If matches exist and email is requested, notify the most recent matching notice
    let emailSent = false;
    if (sendEmailImmediately && matchingNotices.length > 0) {
      const latestNotice = matchingNotices[0];
      const notifyRes = await notifyBankNotice(latestNotice, saved, settings.notifyEmail);
      emailSent = notifyRes.success;
      if (emailSent) {
        const seenList = await getSeenNotices();
        const noticeKey = `notice_${latestNotice.id || latestNotice.jobId}_${latestNotice.publishDate || ""}`;
        seenList.push(noticeKey);
        await saveSeenNotices(seenList);
      }
    }

    res.json({
      success: true,
      message: `Applied job "${saved.title}" (Job ID: ${saved.jobId}) saved successfully!`,
      appliedJob: saved,
      matchedNoticesCount: matchingNotices.length,
      emailSent,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete("/api/bb/applied-jobs/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await deleteAppliedJob(id);
    res.json({ success: true, message: `Applied job removed.` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2d. Send test notification for a specific notice to recipient email
app.post("/api/bb/notices/notify-test", async (req, res) => {
  try {
    const { noticeId, recipientEmail } = req.body;
    const notices = await getNotices();
    const notice = notices.find((n) => n.id === noticeId || String(n.jobId) === String(noticeId));
    if (!notice) {
      return res.status(404).json({ success: false, error: "Notice not found" });
    }

    const appliedJobs = await getAppliedJobs();
    const appliedJob = appliedJobs.find((a) => String(a.jobId) === String(notice.jobId)) || {
      jobId: notice.jobId,
      title: notice.title,
      organization: notice.circularFor || "Bangladesh Bank",
    };

    const settings = await getSettings();
    const to = recipientEmail || settings.notifyEmail || process.env.NOTIFY_EMAIL;
    const result = await notifyBankNotice(notice, appliedJob, to);

    if (result.success) {
      res.json({ success: true, message: `Alert email successfully sent to ${to} for Job ID: ${notice.jobId}!` });
    } else {
      res.status(500).json({ success: false, error: result.error || "Failed to send email" });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Trigger manual scrape
app.post("/api/scrape", async (req, res) => {
  const { dryRun = false, ignoreSeen = false } = req.body;
  if (isScraping) {
    return res.status(409).json({ success: false, message: "Scraper is currently already running." });
  }

  // Start asynchronously
  executeScrape({ dryRun, ignoreSeen }).catch((err) => {
    console.error("Manual scrape error:", err);
  });

  res.json({ success: true, message: `Scraper launched in ${dryRun ? 'dry-run' : 'live'} mode.` });
});

// 3b. Bangladesh Bank On-Demand Scrape
app.post("/api/bb/scrape", async (req, res) => {
  if (isScraping) {
    return res.status(409).json({ success: false, message: "Full scraper is currently running. Please wait." });
  }

  broadcastLog({ time: new Date().toLocaleTimeString(), message: "🏦 Starting Bangladesh Bank on-demand scrape..." });

  const scrapePromise = (async () => {
    let browser = null;
    try {
      const [seenList, rawKeywords, settings] = await Promise.all([
        readJson(SEEN_PATH, []),
        getKeywords(),
        getSettings(),
      ]);
      const seenIds = new Set(seenList);
      const keywords = rawKeywords.map((k) => k.toLowerCase());

      browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });

      const bbResult = await scrapeBBJobs(browser, keywords, seenIds, (msg) => {
        broadcastLog({ time: new Date().toLocaleTimeString(), message: msg });
      });

      if (bbResult.jobs.length > 0) {
        await bulkUpsertJobs(bbResult.jobs);
      }

      // Also scrape BSCS Notice Board
      const bscsResult = await scrapeBSCSNotices(browser, keywords, (msg) => {
        broadcastLog({ time: new Date().toLocaleTimeString(), message: msg });
      });

      if (bscsResult.notices.length > 0) {
        const enrichedNotices = await matchAndNotifyAppliedNotices(bscsResult.notices, settings.notifyEmail);
        await saveNotices(enrichedNotices);
      }

      // Notify new BB matches
      for (const job of bbResult.newMatches) {
        try {
          await notifyJob(job, settings.notifyEmail);
          seenIds.add(job.id);
          broadcastLog({ time: new Date().toLocaleTimeString(), message: `✅ [BB] Alert sent for: "${job.title}"` });
        } catch (nErr) {
          broadcastLog({ time: new Date().toLocaleTimeString(), message: `❌ [BB] Notification failed: ${nErr.message}` });
        }
      }

      // Persist seen IDs
      const trimmed = Array.from(seenIds).slice(-3000);
      await writeJson(SEEN_PATH, trimmed);

      broadcastLog({
        time: new Date().toLocaleTimeString(),
        message: `🏦 BB scrape complete: ${bbResult.jobs.length} jobs, ${bscsResult.notices.length} notices (${bscsResult.matchedCount} IT/matches).`,
        isComplete: true,
        summary: {
          bbJobsFound: bbResult.jobs.length,
          bbMatchedPosts: bbResult.matchedCount,
          bbNewMatches: bbResult.newMatches.length,
          bscsNoticesFound: bscsResult.notices.length,
          bscsMatched: bscsResult.matchedCount,
        }
      });
    } catch (err) {
      broadcastLog({ time: new Date().toLocaleTimeString(), message: `❌ [BB] Fatal error: ${err.message}`, isError: true });
      console.error("[BB Scrape Error]:", err);
    } finally {
      if (browser) await browser.close().catch(() => { });
    }
  })();

  scrapePromise.catch((e) => console.error("[BB Scrape Unhandled]:", e));
  res.json({ success: true, message: "Bangladesh Bank scraper launched." });
});

// 4. Scrape status & live logs
app.get("/api/scrape/status", (req, res) => {
  res.json({
    success: true,
    isScraping,
    logs: liveLogs,
  });
});

// 5. SSE stream for real-time log output
app.get("/api/scrape/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Send current backlog of logs
  liveLogs.forEach((entry) => {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  });

  sseClients.push(res);

  req.on("close", () => {
    sseClients = sseClients.filter((client) => client !== res);
  });
});

// 6. Scrape history
app.get("/api/scrape/history", async (req, res) => {
  try {
    const history = await getScrapeHistory(50);
    res.json({ success: true, history });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 7. Keywords API
app.get("/api/keywords", async (req, res) => {
  try {
    const keywords = await getKeywords();
    res.json({ success: true, keywords });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/keywords", async (req, res) => {
  try {
    const { keywords } = req.body;
    if (!Array.isArray(keywords)) {
      return res.status(400).json({ success: false, message: "Keywords must be an array." });
    }
    const updated = await saveKeywords(keywords);
    res.json({ success: true, keywords: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 8. Settings API
app.get("/api/settings", async (req, res) => {
  try {
    const settings = await getSettings();
    res.json({ success: true, settings });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/settings", async (req, res) => {
  try {
    const updated = await saveSettings(req.body);
    await initScheduler();
    res.json({ success: true, settings: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 9. Test SMTP Email
app.post("/api/test-email", async (req, res) => {
  try {
    const { host, port, user, pass, to } = req.body;
    const result = await testSmtpConnection(
      {
        host: host || process.env.SMTP_HOST,
        port: port || process.env.SMTP_PORT,
        user: user || process.env.SMTP_USER,
        pass: pass || process.env.SMTP_PASS,
      },
      to || process.env.NOTIFY_EMAIL
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 10. Send Manual Email Alert for a specific Job
app.post("/api/jobs/notify", async (req, res) => {
  try {
    const { jobId, emailTo } = req.body;
    const jobs = await getStoredJobs();
    const job = jobs.find((j) => j.id === jobId);
    if (!job) {
      return res.status(404).json({ success: false, message: "Job not found." });
    }
    const result = await notifyJob(job, emailTo);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 11. AI Settings & Provider Management
app.get("/api/ai/settings", (req, res) => {
  try {
    const config = getAIConfig();
    res.json({ success: true, config });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/ai/settings", async (req, res) => {
  try {
    const config = await saveAIConfig(req.body);
    res.json({ success: true, config, message: "AI API keys updated successfully." });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/ai/test", async (req, res) => {
  try {
    const { provider, overrides } = req.body;
    const result = await testAIProvider(provider, overrides || {});
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/ai/test-all", async (req, res) => {
  try {
    const providers = ["gemini", "groq", "cloudflare", "openrouter"];
    const results = {};
    for (const p of providers) {
      results[p] = await testAIProvider(p);
    }
    res.json({ success: true, results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 12. Launch Autofill Script in headed browser
//
// NOTE: A "headed" (non-headless) Chromium needs an actual display to draw
// into. If this server is running inside a container / headless VPS with no
// X server, no amount of spawning will make a window "pop up" — you'll need
// something like `xvfb-run` in front of the command, or run this server on
// a machine with a real desktop session. The fixes below make failures
// visible instead of silent, which is the part code alone can fix.
app.post("/api/autofill/launch", async (req, res) => {
  try {
    const { url, postTitle } = req.body;
    const nodeExe = process.execPath;
    const scriptPath = path.join(__dirname, "scripts", "autofill.mjs");

    const scriptArgs = [scriptPath];
    if (url) scriptArgs.push("--url", url);
    if (postTitle) scriptArgs.push("--post", postTitle);

    let child;

    if (process.platform === "win32") {
      // `cmd /c start "title" <exe> <args...>` opens a NEW visible console window.
      // Passed as an array (not a hand-built string), so node handles the
      // Windows argument escaping instead of us — no more broken quoting
      // when postTitle has spaces or Bangla text.
      child = spawn(
        "cmd.exe",
        ["/c", "start", "Teletalk Autofill Assistant", nodeExe, ...scriptArgs],
        { cwd: __dirname, detached: true, stdio: "ignore", windowsHide: false }
      );
    } else if (process.platform === "darwin") {
      // macOS: hand off to Terminal.app via a small osascript wrapper.
      const shellCmd = [nodeExe, ...scriptArgs].map((a) => `'${String(a).replace(/'/g, `'\\''`)}'`).join(" ");
      child = spawn(
        "osascript",
        ["-e", `tell application "Terminal" to do script "cd ${__dirname} && ${shellCmd}"`],
        { detached: true, stdio: "ignore" }
      );
    } else {
      // Linux: try common terminal emulators in order until one exists.
      const candidates = [
        { cmd: "x-terminal-emulator", args: ["-e", nodeExe, ...scriptArgs] },
        { cmd: "gnome-terminal", args: ["--", nodeExe, ...scriptArgs] },
        { cmd: "konsole", args: ["-e", nodeExe, ...scriptArgs] },
        { cmd: "xterm", args: ["-e", nodeExe, ...scriptArgs] },
      ];
      const term = candidates.find((c) => {
        try {
          require("node:child_process").execSync(`command -v ${c.cmd}`, { stdio: "ignore" });
          return true;
        } catch {
          return false;
        }
      });
      if (!term) {
        throw new Error("No terminal emulator found (tried x-terminal-emulator, gnome-terminal, konsole, xterm). Install one, or run headless.");
      }
      child = spawn(term.cmd, term.args, { cwd: __dirname, detached: true, stdio: "ignore" });
    }

    child.on("error", (err) => {
      console.error("[Autofill Spawn Error]:", err);
    });

    child.unref(); // let the terminal/browser run independently of the server process

    res.json({
      success: true,
      message: "A new terminal window has been launched running the autofill script.",
      command: `npm run autofill -- ${scriptArgs.slice(1).map((a) => JSON.stringify(a)).join(" ")}`,
    });
  } catch (err) {
    console.error("[Autofill Launch Exception]:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 13. Profile Page Route & API Endpoints
app.get("/profile", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "profile.html"));
});

// Get current profile (or null if empty/new) + example schema
app.get("/api/profile", async (req, res) => {
  try {
    const profile = await getProfile();
    const example = await getProfileExample();
    res.json({
      success: true,
      exists: Boolean(profile),
      profile: profile || null,
      example: example || null,
    });
  } catch (err) {
    console.error("[Get Profile Error]:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Save / Update profile.json
app.post("/api/profile", async (req, res) => {
  try {
    const profileData = req.body;
    if (!profileData || typeof profileData !== "object") {
      return res.status(400).json({ success: false, error: "Invalid profile payload. Expected a JSON object." });
    }

    const saved = await saveProfile(profileData);
    if (!saved) {
      return res.status(500).json({ success: false, error: "Failed to write profile.json to disk." });
    }

    console.log(`[Profile] Successfully saved profile for: ${profileData.name_en || "Anonymous"}`);
    res.json({
      success: true,
      message: "Profile saved successfully to config/profile.json!",
      profile: profileData,
    });
  } catch (err) {
    console.error("[Save Profile Error]:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Delete / Clear profile.json
app.delete("/api/profile", async (req, res) => {
  try {
    await deleteProfile();
    console.log("[Profile] profile.json deleted by user request.");
    res.json({
      success: true,
      message: "Profile deleted successfully. config/profile.json is now removed.",
    });
  } catch (err) {
    console.error("[Delete Profile Error]:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Load Example Profile template
app.post("/api/profile/load-example", async (req, res) => {
  try {
    const example = await getProfileExample();
    if (!example) {
      return res.status(404).json({ success: false, error: "config/profile.example.json template not found." });
    }
    res.json({
      success: true,
      profile: example,
    });
  } catch (err) {
    console.error("[Load Example Error]:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 14. Get instant In-Browser Bookmarklet code for current profile
app.get("/api/autofill/bookmarklet", async (req, res) => {
  try {
    const profileRaw = await getProfile();
    if (!profileRaw) {
      return res.status(404).json({ success: false, message: "config/profile.json not found." });
    }

    const jsCode = `(function(){
      var p = ${JSON.stringify(profileRaw)};
      function setVal(sel, val) {
        if (val === undefined || val === null || val === '') return;
        var el = document.querySelector(sel);
        if (!el) return;
        el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.style.backgroundColor = '#ecfdf5';
      }
      function selectFuzzy(sel, wanted) {
        if (!wanted) return;
        var el = document.querySelector(sel);
        if (!el) return;
        var target = String(wanted).toLowerCase().replace(/[^a-z0-9]/g, '');
        for (var i = 0; i < el.options.length; i++) {
          var optText = el.options[i].text.toLowerCase().replace(/[^a-z0-9]/g, '');
          if (optText === target || optText.indexOf(target) !== -1 || target.indexOf(optText) !== -1) {
            el.selectedIndex = i;
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.style.backgroundColor = '#ecfdf5';
            break;
          }
        }
      }
      function setRevealed(selSelect, selInput, val) {
        var sel = document.querySelector(selSelect);
        if (!sel) return;
        if (val) {
          selectFuzzy(selSelect, 'Yes');
          setTimeout(function() { setVal(selInput, val); }, 300);
        } else {
          selectFuzzy(selSelect, 'No');
        }
      }

      // Basic Information
      setVal('#name', p.name_en);
      setVal('#name_bn', p.name_bn);
      setVal('#father', p.father_en);
      setVal('#father_bn', p.father_bn);
      setVal('#mother', p.mother_en);
      setVal('#mother_bn', p.mother_bn);
      setVal('#dob', p.dob);
      selectFuzzy('#nationality', p.nationality);
      selectFuzzy('#religion', p.religion);
      selectFuzzy('#gender', p.gender);
      selectFuzzy('#marital_status', p.marital_status);
      setRevealed('#nid', '#nid_no', p.national_id);
      setRevealed('#breg', '#breg_no', p.birth_registration);
      setRevealed('#passport', '#passport_no', p.passport_id);
      setVal('#mobile', p.mobile);
      setVal('#confirm_mobile', p.mobile);
      setVal('#email', p.email);
      selectFuzzy('#quota', p.quota);
      selectFuzzy('#dep_status', p.departmental_status);

      // Present Address
      if (p.present_address) {
        setVal('#present_careof', p.present_address.care_of);
        setVal('#present_village', p.present_address.village_road_house);
        setVal('#present_post', p.present_address.post_office);
        setVal('#present_postcode', p.present_address.post_code);
        selectFuzzy('#present_district', p.present_address.district);
        setTimeout(function() { selectFuzzy('#present_upazila', p.present_address.upazila); }, 600);
      }

      // Permanent Address
      if (p.permanent_address) {
        setVal('#permanent_careof', p.permanent_address.care_of);
        setVal('#permanent_village', p.permanent_address.village_road_house);
        setVal('#permanent_post', p.permanent_address.post_office);
        setVal('#permanent_postcode', p.permanent_address.post_code);
        selectFuzzy('#permanent_district', p.permanent_address.district);
        setTimeout(function() { selectFuzzy('#permanent_upazila', p.permanent_address.upazila); }, 600);
      }

      // SSC
      if (p.ssc) {
        selectFuzzy('#ssc_exam', p.ssc.examination);
        setTimeout(function() {
          selectFuzzy('#ssc_group', p.ssc.group);
          setVal('#ssc_roll', p.ssc.roll);
          selectFuzzy('#ssc_board', p.ssc.board);
          selectFuzzy('#ssc_result_type', 'GPA(out of 5)');
          setTimeout(function() { setVal('#ssc_result', p.ssc.gpa); }, 300);
          selectFuzzy('#ssc_year', p.ssc.year);
        }, 400);
      }

      // HSC
      if (p.hsc) {
        selectFuzzy('#hsc_exam', p.hsc.examination);
        setTimeout(function() {
          selectFuzzy('#hsc_group', p.hsc.group);
          setVal('#hsc_roll', p.hsc.roll);
          selectFuzzy('#hsc_board', p.hsc.board);
          selectFuzzy('#hsc_result_type', 'GPA(out of 5)');
          setTimeout(function() { setVal('#hsc_result', p.hsc.gpa); }, 300);
          selectFuzzy('#hsc_year', p.hsc.year);
        }, 700);
      }

      // Graduation
      if (p.graduation) {
        selectFuzzy('#gra_exam', p.graduation.examination);
        setTimeout(function() {
          selectFuzzy('#gra_institute', p.graduation.institute);
          setTimeout(function() {
            selectFuzzy('#gra_subject', p.graduation.subject);
            selectFuzzy('#gra_year', p.graduation.year);
            selectFuzzy('#gra_duration', p.graduation.duration + ' Years');
            selectFuzzy('#gra_result_type', 'CGPA(out of 4)');
            setTimeout(function() { setVal('#gra_result', p.graduation.gpa); }, 300);
          }, 600);
        }, 900);
      }

      // Other Qualifications (Computer Skills etc.)
      document.querySelectorAll('select').forEach(function(sel) {
        var row = sel.closest('tr') || sel.closest('div') || sel.parentElement;
        var txt = ((row ? row.innerText : '') + ' ' + (sel.id || '') + ' ' + (sel.name || '')).toLowerCase();
        if (/computer|skill|proficiency|ict|training|ms office/i.test(txt)) {
          for (var i = 0; i < sel.options.length; i++) {
            if (/yes|1|হ্যাঁ/i.test(sel.options[i].text) || /yes|1/i.test(sel.options[i].value)) {
              sel.selectedIndex = i;
              sel.dispatchEvent(new Event('change', { bubbles: true }));
              sel.style.backgroundColor = '#ecfdf5';
              break;
            }
          }
        }
      });

      // Declaration Checkbox
      var chk = document.querySelector('#agree, #declaration, #info_yes, input[name="agree"], input[name="declaration"], input[name="info_yes"]');
      if (!chk) {
        var cbs = document.querySelectorAll('input[type="checkbox"]');
        for (var c = 0; c < cbs.length; c++) {
          var pTxt = (cbs[c].closest('tr, div, p, fieldset') || cbs[c].parentElement).innerText;
          if (/declare|declaration|knowledge and belief|correct, true/i.test(pTxt)) {
            chk = cbs[c];
            break;
          }
        }
        if (!chk && cbs.length > 0) chk = cbs[cbs.length - 1];
      }
      if (chk) {
        chk.checked = true;
        chk.dispatchEvent(new Event('click', { bubbles: true }));
        chk.dispatchEvent(new Event('change', { bubbles: true }));
      }

      alert('✨ Form filled from profile.json! Computer skills selected and declaration ticked. Please solve CAPTCHA and submit.');
    })();`;

    const bookmarkletUrl = `javascript:${encodeURIComponent(jsCode)}`;
    res.json({
      success: true,
      bookmarkletUrl,
      rawJs: jsCode,
      profileName: profileRaw.name_en,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Start Server
app.listen(PORT, async () => {
  console.log(`====================================================`);
  console.log(`🚀 Teletalk Job Notifier Dashboard is running!`);
  console.log(`🔗 Local URL: http://localhost:${PORT}`);
  console.log(`====================================================`);
  await initScheduler();
});
