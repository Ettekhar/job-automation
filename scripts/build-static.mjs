import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const CONFIG_DIR = path.join(ROOT, "config");
const DIST_DIR = path.join(ROOT, "dist");

async function readJsonSafe(filePath, fallback = {}) {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content);
  } catch {
    return fallback;
  }
}

async function writeJsonSafe(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

async function copyDir(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

async function build() {
  console.log("🛠️ Building static assets for Cloudflare Pages...");

  // 1. Read existing data
  const jobs = await readJsonSafe(path.join(DATA_DIR, "jobs.json"), []);
  const notices = await readJsonSafe(path.join(DATA_DIR, "bb-notices.json"), []);
  const seenJobs = await readJsonSafe(path.join(DATA_DIR, "seen-jobs.json"), []);
  const history = await readJsonSafe(path.join(DATA_DIR, "scrape-history.json"), []);
  const keywords = await readJsonSafe(path.join(CONFIG_DIR, "keywords.json"), { include: [], exclude: [] });
  const profileExample = await readJsonSafe(path.join(CONFIG_DIR, "profile.example.json"), {});
  const status = await readJsonSafe(path.join(DATA_DIR, "status.json"), {
    lastRun: new Date().toISOString(),
    trigger: "build",
  });

  const matchedJobs = jobs.filter((j) => j.isMatch);
  const bbJobs = jobs.filter((j) => j.source === "bb");
  const matchedNotices = notices.filter((n) => n.isMatch);

  const overviewData = {
    success: true,
    stats: {
      totalJobs: jobs.length,
      matchedJobs: matchedJobs.length,
      seenCount: Math.max(seenJobs.length, jobs.length),
      bbJobs: bbJobs.length,
      noticesCount: notices.length,
      matchedNoticesCount: matchedNotices.length,
      titanStatus: "Ready",
      lastScrape: history[0] || {
        timestamp: status.lastRun || new Date().toISOString(),
        durationSeconds: 120,
        trigger: "github-actions",
      },
      scheduler: {
        enabled: true,
        intervalMinutes: 360,
        nextRun: new Date(Date.now() + 6 * 3600 * 1000).toISOString(),
        mode: "GitHub Actions (Every 6h)",
      },
    },
  };

  const jobsData = {
    success: true,
    jobs: jobs,
    total: jobs.length,
    matchedCount: matchedJobs.length,
  };

  const noticesData = {
    success: true,
    notices: notices,
    total: notices.length,
    matchedCount: matchedNotices.length,
  };

  const keywordsData = {
    success: true,
    keywords: keywords,
  };

  const authMeData = {
    success: true,
    user: {
      name: "Admin (Cloudflare)",
      email: "taion16240@gmail.com",
      picture: null,
    },
  };

  const authStatusData = {
    success: true,
    googleConfigured: true,
    user: authMeData.user,
  };

  const settingsData = {
    success: true,
    settings: {
      autoScrapeEnabled: true,
      autoScrapeIntervalMinutes: 360,
      notifyEmail: "taion@razibmarketing.net",
      smtpReady: true,
      deployment: "Cloudflare Pages + GitHub Actions",
    },
  };

  // 2. Populate public/data
  const publicDataDir = path.join(PUBLIC_DIR, "data");
  await fs.mkdir(publicDataDir, { recursive: true });
  await writeJsonSafe(path.join(publicDataDir, "jobs.json"), jobs);
  await writeJsonSafe(path.join(publicDataDir, "bb-notices.json"), notices);
  await writeJsonSafe(path.join(publicDataDir, "scrape-history.json"), history);
  await writeJsonSafe(path.join(publicDataDir, "keywords.json"), keywords);
  await writeJsonSafe(path.join(publicDataDir, "overview.json"), overviewData);
  await writeJsonSafe(path.join(publicDataDir, "profile.example.json"), profileExample);
  await writeJsonSafe(path.join(publicDataDir, "status.json"), status);

  // 3. Create public/api endpoints for direct static serving
  const publicApiDir = path.join(PUBLIC_DIR, "api");
  await writeJsonSafe(path.join(publicApiDir, "overview"), overviewData);
  await writeJsonSafe(path.join(publicApiDir, "overview.json"), overviewData);
  await writeJsonSafe(path.join(publicApiDir, "jobs"), jobsData);
  await writeJsonSafe(path.join(publicApiDir, "jobs.json"), jobsData);
  await writeJsonSafe(path.join(publicApiDir, "bb", "notices"), noticesData);
  await writeJsonSafe(path.join(publicApiDir, "bb", "notices.json"), noticesData);
  await writeJsonSafe(path.join(publicApiDir, "keywords"), keywordsData);
  await writeJsonSafe(path.join(publicApiDir, "keywords.json"), keywordsData);
  await writeJsonSafe(path.join(publicApiDir, "settings"), settingsData);
  await writeJsonSafe(path.join(publicApiDir, "settings.json"), settingsData);
  await writeJsonSafe(path.join(publicApiDir, "auth", "status"), authStatusData);
  await writeJsonSafe(path.join(publicApiDir, "auth", "status.json"), authStatusData);
  await writeJsonSafe(path.join(publicApiDir, "auth", "me"), authMeData);
  await writeJsonSafe(path.join(publicApiDir, "auth", "me.json"), authMeData);

  // 4. Create public/_redirects for Cloudflare Pages SPA & API mapping
  const redirects = `# Cloudflare Pages Redirects
/api/overview /data/overview.json 200
/api/jobs* /data/jobs.json 200
/api/bb/notices /data/bb-notices.json 200
/api/keywords /data/keywords.json 200
/api/scrape/history /data/scrape-history.json 200
/api/auth/me /api/auth/me.json 200
/api/auth/status /api/auth/status.json 200
/api/settings /api/settings.json 200
`;
  await fs.writeFile(path.join(PUBLIC_DIR, "_redirects"), redirects, "utf-8");

  // 5. Copy everything to dist/
  await copyDir(PUBLIC_DIR, DIST_DIR);
  await copyDir(publicDataDir, path.join(DIST_DIR, "data"));

  console.log(`✅ Build complete!
  - Indexed ${jobs.length} jobs (${matchedJobs.length} matches)
  - Indexed ${notices.length} notices
  - Synced to public/data/ and dist/
  - Generated static API endpoints and _redirects`);
}

build().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
