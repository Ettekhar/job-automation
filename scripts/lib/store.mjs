import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "..", "data");
const CONFIG_DIR = path.join(__dirname, "..", "..", "config");

export const JOBS_PATH = path.join(DATA_DIR, "jobs.json");
export const SEEN_PATH = path.join(DATA_DIR, "seen-jobs.json");
export const SCRAPES_PATH = path.join(DATA_DIR, "scrape-history.json");
export const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");
export const KEYWORDS_PATH = path.join(CONFIG_DIR, "keywords.json");
export const NOTICES_PATH = path.join(DATA_DIR, "bb-notices.json");
export const PROFILE_PATH = path.join(CONFIG_DIR, "profile.json");
export const PROFILE_EXAMPLE_PATH = path.join(CONFIG_DIR, "profile.example.json");
export const APPLIED_JOBS_PATH = path.join(DATA_DIR, "applied-jobs.json");
export const SEEN_NOTICES_PATH = path.join(DATA_DIR, "seen-notices.json");

export async function readJson(filePath, fallback = {}) {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export async function writeJson(filePath, data) {
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
    return true;
  } catch (err) {
    console.error(`Error writing ${filePath}:`, err);
    return false;
  }
}

// Job Storage API
export async function getStoredJobs() {
  return await readJson(JOBS_PATH, []);
}

export async function saveJob(jobData) {
  const jobs = await getStoredJobs();
  const index = jobs.findIndex((j) => j.id === jobData.id);
  const now = new Date().toISOString();

  if (index !== -1) {
    jobs[index] = {
      ...jobs[index],
      ...jobData,
      lastScrapedAt: now,
    };
  } else {
    jobs.unshift({
      ...jobData,
      firstSeenAt: now,
      lastScrapedAt: now,
    });
  }

  await writeJson(JOBS_PATH, jobs);
  return jobs;
}

export async function bulkUpsertJobs(newJobsList) {
  const existingJobs = await getStoredJobs();
  const jobsMap = new Map(existingJobs.map((j) => [j.id, j]));
  const now = new Date().toISOString();

  for (const job of newJobsList) {
    if (jobsMap.has(job.id)) {
      const prev = jobsMap.get(job.id);
      jobsMap.set(job.id, {
        ...prev,
        ...job,
        lastScrapedAt: now,
        // preserve firstSeenAt and notifiedAt if already exists
        firstSeenAt: prev.firstSeenAt || now,
        notifiedAt: job.notifiedAt || prev.notifiedAt || null,
      });
    } else {
      jobsMap.set(job.id, {
        ...job,
        firstSeenAt: now,
        lastScrapedAt: now,
        notifiedAt: job.notifiedAt || null,
      });
    }
  }

  const updated = Array.from(jobsMap.values());
  // Sort by lastScrapedAt descending
  updated.sort((a, b) => new Date(b.lastScrapedAt || 0) - new Date(a.lastScrapedAt || 0));
  await writeJson(JOBS_PATH, updated);
  return updated;
}

// Scrape History API
export async function getScrapeHistory(limit = 50) {
  const history = await readJson(SCRAPES_PATH, []);
  return history.slice(0, limit);
}

export async function recordScrapeRun(runSummary) {
  const history = await readJson(SCRAPES_PATH, []);
  const entry = {
    id: `scrape_${Date.now()}`,
    timestamp: new Date().toISOString(),
    ...runSummary,
  };
  history.unshift(entry);
  await writeJson(SCRAPES_PATH, history.slice(0, 100)); // keep last 100
  return entry;
}

// Keywords API
export async function getKeywords() {
  const config = await readJson(KEYWORDS_PATH, { keywords: [] });
  return config.keywords || [];
}

export async function saveKeywords(keywordsList) {
  const raw = await readJson(KEYWORDS_PATH, {});
  raw.keywords = Array.from(new Set(keywordsList.map((k) => k.trim()).filter(Boolean)));
  await writeJson(KEYWORDS_PATH, raw);
  return raw.keywords;
}

// Settings API
export async function getSettings() {
  const defaults = {
    autoScrapeEnabled: false,
    autoScrapeIntervalMinutes: 60,
    notifyEmail: process.env.NOTIFY_EMAIL || "taion@razibmarketing.net",
    smtpHost: process.env.SMTP_HOST || "smtp.titan.email",
    smtpPort: parseInt(process.env.SMTP_PORT || "587", 10),
    smtpUser: process.env.SMTP_USER || "taion@razibmarketing.net",
    hasSmtpPass: Boolean(process.env.SMTP_PASS),
  };
  const stored = await readJson(SETTINGS_PATH, {});
  return { ...defaults, ...stored };
}

export async function saveSettings(newSettings) {
  const current = await getSettings();
  const updated = { ...current, ...newSettings };
  await writeJson(SETTINGS_PATH, updated);
  return updated;
}

// BB Notices (BSCS Notice Board) API
export async function getNotices() {
  return await readJson(NOTICES_PATH, []);
}

export async function saveNotices(noticesList) {
  // Keep notices sorted by publishDate desc, max 200
  const sorted = [...noticesList].sort((a, b) => {
    // DD/MM/YYYY → comparable
    const parse = (d) => {
      if (!d) return 0;
      const [day, mon, yr] = d.split("/");
      return new Date(`${yr}-${mon}-${day}`).getTime() || 0;
    };
    return parse(b.publishDate) - parse(a.publishDate);
  });
  await writeJson(NOTICES_PATH, sorted.slice(0, 200));
  return sorted;
}

// Profile API
export async function getProfile() {
  try {
    const raw = await fs.readFile(PROFILE_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function getProfileExample() {
  try {
    const raw = await fs.readFile(PROFILE_EXAMPLE_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function saveProfile(profileData) {
  return await writeJson(PROFILE_PATH, profileData);
}

export async function deleteProfile() {
  try {
    await fs.unlink(PROFILE_PATH);
    return true;
  } catch (err) {
    if (err.code === "ENOENT") return true;
    throw err;
  }
}

// Applied Bank Jobs API
export async function getAppliedJobs() {
  return await readJson(APPLIED_JOBS_PATH, []);
}

export async function saveAppliedJobs(jobsList) {
  await writeJson(APPLIED_JOBS_PATH, jobsList);
  return jobsList;
}

export async function addOrUpdateAppliedJob(jobData) {
  const jobs = await getAppliedJobs();
  const normalizedJobId = String(jobData.jobId || "").trim();
  const index = jobs.findIndex(
    (j) => (jobData.id && j.id === jobData.id) || (normalizedJobId && String(j.jobId).trim() === normalizedJobId)
  );

  const now = new Date().toISOString();
  const entry = {
    id: jobData.id || `applied_${normalizedJobId || Date.now()}`,
    jobId: normalizedJobId,
    title: jobData.title || "Bank Post",
    organization: jobData.organization || "Bangladesh Bank / BSCS",
    rollNo: jobData.rollNo || "",
    trackingNo: jobData.trackingNo || "",
    appliedDate: jobData.appliedDate || now.split("T")[0],
    notes: jobData.notes || "",
    source: "bb",
    updatedAt: now,
  };

  if (index !== -1) {
    jobs[index] = { ...jobs[index], ...entry };
  } else {
    entry.createdAt = now;
    jobs.unshift(entry);
  }

  await writeJson(APPLIED_JOBS_PATH, jobs);
  return entry;
}

export async function deleteAppliedJob(idOrJobId) {
  const jobs = await getAppliedJobs();
  const filtered = jobs.filter(
    (j) => j.id !== idOrJobId && String(j.jobId).trim() !== String(idOrJobId).trim()
  );
  await writeJson(APPLIED_JOBS_PATH, filtered);
  return true;
}

// Seen / Notified BSCS Notices cache
export async function getSeenNotices() {
  return await readJson(SEEN_NOTICES_PATH, []);
}

export async function saveSeenNotices(seenList) {
  const unique = Array.from(new Set(seenList)).slice(-2000);
  await writeJson(SEEN_NOTICES_PATH, unique);
  return unique;
}


