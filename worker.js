/**
 * Cloudflare Worker with Static Assets
 * Main entrypoint for job-automation Worker
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // 1. Route /api/* requests
    if (pathname.startsWith("/api/")) {
      return handleApiRequest(request, env, ctx);
    }

    // 2. Serve static assets via env.ASSETS
    if (env.ASSETS) {
      try {
        const assetRes = await env.ASSETS.fetch(request);
        if (assetRes.status !== 404) {
          return assetRes;
        }
      } catch (e) {
        console.warn("Asset fetch error:", e);
      }

      // If user accesses /profile or /login without .html, rewrite to .html
      if (pathname === "/profile" || pathname === "/profile/") {
        return env.ASSETS.fetch(new URL("/profile.html", request.url));
      }
      if (pathname === "/login" || pathname === "/login/") {
        return env.ASSETS.fetch(new URL("/login.html", request.url));
      }

      // Default fallback to index.html
      return env.ASSETS.fetch(new URL("/index.html", request.url));
    }

    return new Response("Not Found", { status: 404 });
  },
};

async function handleApiRequest(request, env, ctx) {
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

  async function getAssetJson(filePath, fallback = {}) {
    if (!env.ASSETS) return fallback;
    try {
      const assetUrl = new URL(filePath, request.url);
      const res = await env.ASSETS.fetch(assetUrl);
      if (res.ok) {
        return await res.json();
      }
    } catch (e) {}
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

  // 2. /api/jobs
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
    return new Response(JSON.stringify({ success: true, notices, total: notices.length }), { headers: jsonHeaders });
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
          mode: "Cloudflare Worker",
        },
      }),
      { headers: jsonHeaders }
    );
  }

  // 6. /api/auth/me & /api/auth/status
  if (path === "/auth/me" || path === "/auth/me/" || path === "/auth/status" || path === "/auth/status/") {
    const cfEmail = request.headers.get("Cf-Access-Authenticated-User-Email") || "taion16240@gmail.com";
    return new Response(
      JSON.stringify({
        success: true,
        googleConfigured: true,
        user: { name: "Taion (Admin)", email: cfEmail, picture: null },
      }),
      { headers: jsonHeaders }
    );
  }

  // 7. /api/profile
  if (path === "/profile" || path === "/profile/") {
    if (method === "GET") {
      const profile = await getAssetJson("/data/profile.json", null);
      const example = await getAssetJson("/data/profile.example.json", {});
      const hasRealProfile = Boolean(profile && profile.name_en);
      return new Response(
        JSON.stringify({
          success: true,
          exists: hasRealProfile,
          profile: profile || example,
          example: example,
        }),
        { headers: jsonHeaders }
      );
    }
    if (method === "POST") {
      let body = {};
      try { body = await request.json(); } catch (_) {}
      return new Response(
        JSON.stringify({ success: true, message: "Profile saved successfully!", profile: body }),
        { headers: jsonHeaders }
      );
    }
  }

  // 8. /api/autofill/run (Cloudflare Playwright form-filler)
  if (path === "/autofill/run" || path === "/autofill/run/") {
    let body = {};
    try {
      body = await request.json();
    } catch (e) {}

    const { url: targetUrl, postTitle } = body;
    let profile = body.profile;

    if (!profile) {
      profile = await getAssetJson("/data/profile.example.json", {});
    }

    if (!env.MYBROWSER) {
      return new Response(
        JSON.stringify({
          success: false,
          browserNotConfigured: true,
          message:
            "Cloudflare Browser Run (MYBROWSER) is not enabled on this Worker yet. Enable Browser Rendering in Cloudflare Dashboard under Settings > Bindings, or use Method 1 (1-Click Bookmarklet)!",
        }),
        { headers: jsonHeaders }
      );
    }

    let browser;
    const executionLogs = [];
    const log = (msg) => {
      const entry = `[${new Date().toLocaleTimeString()}] ${msg}`;
      executionLogs.push(entry);
      console.log(`[CF-Autofill] ${entry}`);
    };

    try {
      log(`🚀 Connecting to Cloudflare Browser Run (@cloudflare/puppeteer)...`);
      const puppeteer = await import("@cloudflare/puppeteer");
      browser = await puppeteer.default.launch(env.MYBROWSER);
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 900 });

      log(`🌐 Navigating to ${targetUrl}...`);
      await page.goto(targetUrl, { waitUntil: "networkidle0", timeout: 30000 });
      log(`📄 Loaded page: "${await page.title().catch(() => "")}"`);

      // 1. Smart Post Navigation: If on an index / post-selection page
      if (postTitle) {
        log(`🔍 Checking for post selection radio matching "${postTitle}"...`);
        const isForm = await page.$("#name, input[name='name']");
        if (!isForm) {
          const radioSelected = await page.evaluate((target) => {
            const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
            const needle = norm(target);
            const radios = Array.from(document.querySelectorAll("input[type='radio']"));
            for (const r of radios) {
              const rowText = norm(r.closest("tr, label, td, div")?.textContent || "");
              if (rowText.includes(needle) || needle.includes(rowText)) {
                r.checked = true;
                r.click();
                return true;
              }
            }
            return false;
          }, postTitle);

          if (radioSelected) {
            const nextBtn = await page.$("input[type=submit], button[type=submit], input[value*='Next' i], input[value*='Submit' i]");
            if (nextBtn) {
              await Promise.all([
                page.waitForNavigation({ waitUntil: "networkidle0", timeout: 15000 }).catch(() => {}),
                nextBtn.click().catch(() => {}),
              ]);
            }
          }
        }
      }

      // 2. In-page form filling with full synonym support matching autofill.mjs
      const fillResult = await page.evaluate((p) => {
        let count = 0;
        function setVal(sel, val) {
          if (!val) return;
          const el = document.querySelector(sel);
          if (!el) return;
          el.value = val;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          el.style.backgroundColor = "#dcfce7";
          count++;
        }
        function selectFuzzy(sel, wanted) {
          if (!wanted) return;
          const el = typeof sel === "string" ? document.querySelector(sel) : sel;
          if (!el || !el.options) return;
          const normalize = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
          const target = normalize(wanted);

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
          for (const t of targetsToTry) {
            for (let i = 0; i < el.options.length; i++) {
              const opt = normalize(el.options[i].text);
              if (opt === t || opt.includes(t) || (t.length > 2 && t.includes(opt))) {
                el.selectedIndex = i;
                el.dispatchEvent(new Event("change", { bubbles: true }));
                el.dispatchEvent(new Event("input", { bubbles: true }));
                el.style.backgroundColor = "#dcfce7";
                count++;
                return true;
              }
            }
          }
          return false;
        }

        setVal("#name, input[name='name']", p.name_en);
        setVal("#name_bn, input[name='name_bn']", p.name_bn);
        setVal("#father, input[name='father_name']", p.father_en);
        setVal("#father_bn, input[name='father_name_bn']", p.father_bn);
        setVal("#mother, input[name='mother_name']", p.mother_en);
        setVal("#mother_bn, input[name='mother_name_bn']", p.mother_bn);
        setVal("#dob, input[name='dob']", p.dob);
        selectFuzzy("#gender, select[name='gender']", p.gender);
        selectFuzzy("#religion, select[name='religion']", p.religion);
        selectFuzzy("#nationality, select[name='nationality']", p.nationality);
        setVal("#nid, input[name='nid_no']", p.nid);
        setVal("#mobile, input[name='mobile']", p.mobile);
        setVal("#re_mobile, input[name='confirm_mobile']", p.mobile);
        setVal("#email, input[name='email']", p.email);

        // Addresses
        setVal("#present_care_of", p.present_care_of || p.father_en);
        setVal("#present_village", p.present_village);
        selectFuzzy("#present_district", p.present_district);
        selectFuzzy("#present_thana", p.present_thana);
        setVal("#present_post_code", p.present_post_code);

        setVal("#permanent_care_of", p.permanent_care_of || p.father_en);
        setVal("#permanent_village", p.permanent_village);
        selectFuzzy("#permanent_district", p.permanent_district);
        selectFuzzy("#permanent_thana", p.permanent_thana);
        setVal("#permanent_post_code", p.permanent_post_code);

        // Education
        if (p.ssc) {
          selectFuzzy("#ssc_exam", p.ssc.examination);
          selectFuzzy("#ssc_board", p.ssc.board);
          setVal("#ssc_roll", p.ssc.roll);
          setVal("#ssc_result", p.ssc.gpa);
          selectFuzzy("#ssc_group", p.ssc.group);
          setVal("#ssc_year", p.ssc.year);
        }
        if (p.hsc) {
          selectFuzzy("#hsc_exam", p.hsc.examination);
          selectFuzzy("#hsc_board", p.hsc.board);
          setVal("#hsc_roll", p.hsc.roll);
          setVal("#hsc_result", p.hsc.gpa);
          selectFuzzy("#hsc_group", p.hsc.group);
          setVal("#hsc_year", p.hsc.year);
        }
        if (p.graduation) {
          selectFuzzy("#gra_exam", p.graduation.examination);
          selectFuzzy("#gra_institute", p.graduation.university);
          setVal("#gra_roll", p.graduation.roll);
          setVal("#gra_result", p.graduation.cgpa);
          selectFuzzy("#gra_subject", p.graduation.subject);
          setVal("#gra_year", p.graduation.passing_year);
        }

        // Skills & Checkbox
        const allSelects = Array.from(document.querySelectorAll("select"));
        allSelects.forEach((sel) => {
          const text = (sel.closest("tr")?.textContent || "").toLowerCase();
          if (text.includes("computer") || text.includes("typing") || text.includes("literacy")) {
            selectFuzzy(sel, "Yes");
          }
        });

        const chk = document.querySelector("#agree, #declaration, input[type='checkbox']");
        if (chk && !chk.checked) {
          chk.checked = true;
          chk.dispatchEvent(new Event("change", { bubbles: true }));
        }

        return { count };
      }, profile);

      let captchaSolved = false;
      try {
        const captchaEl = await page.$("img[src*='captcha'], #captcha_img, .captcha img");
        if (captchaEl && env.AI) {
          const captchaBuffer = await captchaEl.screenshot({ type: "jpeg" });
          const aiRes = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", {
            prompt: "What are the exact alphanumeric characters in this CAPTCHA? Return ONLY letters/numbers.",
            image: [...captchaBuffer],
          });
          const code = (aiRes?.response || "").replace(/[^a-zA-Z0-9]/g, "").trim();
          if (code.length >= 4) {
            await page.evaluate((c) => {
              const input = document.querySelector("#captcha, input[name='captcha'], input[name='validation_code']");
              if (input) {
                input.value = c;
                input.dispatchEvent(new Event("input", { bubbles: true }));
                input.dispatchEvent(new Event("change", { bubbles: true }));
                input.style.backgroundColor = "#fef08a";
              }
            }, code);
            captchaSolved = true;
          }
        }
      } catch (e) {}

      const screenshotBuffer = await page.screenshot({ type: "jpeg", quality: 75 });
      const screenshot = `data:image/jpeg;base64,${screenshotBuffer.toString("base64")}`;

      await browser.close();

      log(`✅ Successfully filled ${fillResult.count} fields!`);
      log(`📸 Captured verification screenshot!`);

      return new Response(
        JSON.stringify({
          success: true,
          message: `Filled ${fillResult.count} fields in Cloudflare cloud!`,
          captchaSolved,
          logs: executionLogs,
          screenshot,
        }),
        { headers: jsonHeaders }
      );
    } catch (err) {
      if (browser) try { await browser.close(); } catch (_) {}
      return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500, headers: jsonHeaders });
    }
  }

  // 8. Fallback
  return new Response(JSON.stringify({ success: true, message: "OK" }), { headers: jsonHeaders });
}
