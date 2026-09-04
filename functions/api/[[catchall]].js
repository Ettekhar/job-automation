/**
 * Cloudflare Pages Functions - Edge API Handler
 * Handles all /api/* routes directly on Cloudflare Workers edge network.
 */

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, "");
  const method = request.method;

  const jsonHeaders = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Cache-Control": "public, max-age=60",
  };

  if (method === "OPTIONS") {
    return new Response(null, { headers: jsonHeaders });
  }

  // Helper to fetch static data asset
  async function getAssetJson(filePath, fallback = {}) {
    try {
      const assetUrl = new URL(filePath, request.url);
      const res = await env.ASSETS.fetch(assetUrl);
      if (res.ok) {
        return await res.json();
      }
    } catch (e) {
      console.error("Asset fetch error:", e);
    }
    return fallback;
  }

  // 1. /api/overview
  if (path === "/overview" || path === "/overview/") {
    const jobs = await getAssetJson("/data/jobs.json", []);
    const notices = await getAssetJson("/data/bb-notices.json", []);
    const history = await getAssetJson("/data/scrape-history.json", []);
    const status = await getAssetJson("/data/status.json", {});

    const matchedJobs = jobs.filter((j) => j.isMatch);
    const bbJobs = jobs.filter((j) => j.source === "bb");
    const matchedNotices = notices.filter((n) => n.isMatch);

    return new Response(
      JSON.stringify({
        success: true,
        stats: {
          totalJobs: jobs.length,
          matchedJobs: matchedJobs.length,
          seenCount: jobs.length,
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
            mode: "GitHub Actions Cron",
          },
        },
      }),
      { headers: jsonHeaders }
    );
  }

  // 2. /api/jobs (with filtering, search, pagination)
  if (path === "/jobs" || path === "/jobs/") {
    const filter = url.searchParams.get("filter") || "matched";
    const search = (url.searchParams.get("search") || "").toLowerCase().trim();
    const limit = parseInt(url.searchParams.get("limit") || "300", 10);

    const jobs = await getAssetJson("/data/jobs.json", []);

    let filtered = jobs;
    if (filter === "matched") {
      filtered = jobs.filter((j) => j.isMatch);
    } else if (filter === "bb") {
      filtered = jobs.filter((j) => j.source === "bb");
    } else if (filter === "other") {
      filtered = jobs.filter((j) => !j.isMatch && j.source !== "bb");
    }

    if (search) {
      filtered = filtered.filter(
        (j) =>
          (j.title && j.title.toLowerCase().includes(search)) ||
          (j.category && j.category.toLowerCase().includes(search)) ||
          (j.orgId && j.orgId.toLowerCase().includes(search))
      );
    }

    const total = filtered.length;
    const paginated = filtered.slice(0, limit);

    return new Response(
      JSON.stringify({
        success: true,
        jobs: paginated,
        total,
        page: 1,
      }),
      { headers: jsonHeaders }
    );
  }

  // 3. /api/bb/notices
  if (path.startsWith("/bb/notices")) {
    const notices = await getAssetJson("/data/bb-notices.json", []);
    return new Response(
      JSON.stringify({
        success: true,
        notices,
        total: notices.length,
      }),
      { headers: jsonHeaders }
    );
  }

  // 4. /api/keywords
  if (path === "/keywords" || path === "/keywords/") {
    const keywords = await getAssetJson("/data/keywords.json", { include: [], exclude: [] });
    return new Response(JSON.stringify({ success: true, keywords }), { headers: jsonHeaders });
  }

  // 5. /api/settings
  if (path === "/settings" || path === "/settings/") {
    return new Response(
      JSON.stringify({
        success: true,
        settings: {
          autoScrapeEnabled: true,
          autoScrapeIntervalMinutes: 360,
          notifyEmail: "taion@razibmarketing.net",
          smtpReady: true,
          mode: "Cloudflare Pages",
        },
      }),
      { headers: jsonHeaders }
    );
  }

  // 6. /api/scrape/history
  if (path.startsWith("/scrape/history")) {
    const history = await getAssetJson("/data/scrape-history.json", []);
    return new Response(JSON.stringify({ success: true, history }), { headers: jsonHeaders });
  }

  // 7. /api/auth/me and /api/auth/status
  if (path === "/auth/me" || path === "/auth/me/") {
    // Cloudflare Access integration: Cloudflare passes Cf-Access-Authenticated-User-Email
    const cfEmail = request.headers.get("Cf-Access-Authenticated-User-Email") || "taion16240@gmail.com";
    return new Response(
      JSON.stringify({
        success: true,
        user: {
          name: "Taion (Admin)",
          email: cfEmail,
          picture: null,
        },
      }),
      { headers: jsonHeaders }
    );
  }

  if (path === "/auth/status" || path === "/auth/status/") {
    return new Response(
      JSON.stringify({
        googleConfigured: true,
        user: {
          name: "Taion (Admin)",
          email: "taion16240@gmail.com",
          picture: null,
        },
      }),
      { headers: jsonHeaders }
    );
  }

  // 8. /api/scrape (trigger notice)
  if (path === "/scrape" || path === "/bb/scrape") {
    return new Response(
      JSON.stringify({
        success: true,
        message: "Automated scan is active on GitHub Actions cron (runs every 6 hours). You can also run it manually from GitHub Actions tab.",
        workflowUrl: "https://github.com/Ettekhar/job-automation/actions/workflows/check-jobs.yml",
      }),
      { headers: jsonHeaders }
    );
  }

  // 9. /api/profile
  if (path === "/profile" || path === "/profile/") {
    const example = await getAssetJson("/data/profile.example.json", {});
    return new Response(
      JSON.stringify({
        success: true,
        exists: false,
        example,
      }),
      { headers: jsonHeaders }
    );
  }

  // Fallback for any other /api endpoint: pass to static asset or return 200 empty json
  try {
    const fallbackRes = await env.ASSETS.fetch(request);
    if (fallbackRes.ok) return fallbackRes;
  } catch (e) {}

  return new Response(
    JSON.stringify({
      success: true,
      message: "OK",
    }),
    { headers: jsonHeaders }
  );
}
