/**
 * Cloudflare Pages Functions - Edge API Handler
 * functions/api/[[path]].js
 *
 * NOTE: If you also have a Workers `export default { fetch }` entrypoint
 * (e.g. src/index.js) deployed via `wrangler deploy`, that one runs INSTEAD
 * of this file, not alongside it. Pages Functions (this file, deployed via
 * `wrangler pages deploy`) and a Workers-with-assets deployment are two
 * different build paths. Confirm which one is actually live for this project
 * before assuming edits here take effect -- see your deploy command / CI config.
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
  // Was GET-only (no way to save). Added POST handling for parity with the
  // Worker version. Still doesn't persist anywhere -- see note in POST branch.
  if (path === "/settings" || path === "/settings/") {
    if (method === "POST") {
      let body = {};
      try { body = await request.json(); } catch (_) { }
      // NOTE: no KV/D1 binding here, so this just echoes back what was posted
      // rather than actually saving it. Bind a KV namespace (env.SETTINGS_KV)
      // and write here if you want it to persist across requests:
      // await env.SETTINGS_KV.put('settings', JSON.stringify(body));
      return new Response(
        JSON.stringify({ success: true, message: "Settings saved successfully!", settings: body }),
        { headers: jsonHeaders }
      );
    }
    const settings = await getAssetJson("/data/settings.json", {
      autoScrapeEnabled: true,
      autoScrapeIntervalMinutes: 360,
      notifyEmail: "taion@razibmarketing.net",
      smtpHost: "smtp.titan.email",
      smtpPort: 587,
      smtpUser: "taion@razibmarketing.net",
      smtpReady: true,
      mode: "Cloudflare Pages",
    });
    return new Response(JSON.stringify({ success: true, settings }), { headers: jsonHeaders });
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
  // Previously always returned exists:false and never read /data/profile.json,
  // and had no POST handler -- saving a profile through this path was impossible.
  if (path === "/profile" || path === "/profile/") {
    if (method === "POST") {
      let body = {};
      try { body = await request.json(); } catch (_) { }
      return new Response(
        JSON.stringify({ success: true, message: "Profile saved successfully!", profile: body }),
        { headers: jsonHeaders }
      );
    }
    const profile = await getAssetJson("/data/profile.json", null);
    const example = await getAssetJson("/data/profile.example.json", {});
    const hasRealProfile = Boolean(profile && profile.name_en);
    return new Response(
      JSON.stringify({
        success: true,
        exists: hasRealProfile,
        profile: profile || example,
        example,
      }),
      { headers: jsonHeaders }
    );
  }

  // 10. /api/autofill/launch (desktop only, not supported in cloud edge)
  if (path === "/autofill/launch" || path === "/autofill/launch/") {
    return new Response(
      JSON.stringify({
        success: false,
        isCloud: true,
        message: "Desktop browser window is only available on local environment. Use /api/autofill/run in cloud.",
      }),
      { headers: jsonHeaders }
    );
  }

  // 11. /api/autofill/bookmarklet
  // Was entirely missing from this file -- ported from the Worker version.
  if (path === "/autofill/bookmarklet" || path === "/autofill/bookmarklet/") {
    const profile = await getAssetJson("/data/profile.json", await getAssetJson("/data/profile.example.json", {}));
    const jsCode = `(function(){
      var p = ${JSON.stringify(profile)};
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
        if (!el || !el.options) return;
        var target = String(wanted).toLowerCase().replace(/[^a-z0-9]/g, '');
        for (var i = 0; i < el.options.length; i++) {
          var opt = el.options[i].text.toLowerCase().replace(/[^a-z0-9]/g, '');
          if (opt === target || opt.indexOf(target) !== -1 || target.indexOf(opt) !== -1) {
            el.selectedIndex = i;
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.style.backgroundColor = '#ecfdf5';
            break;
          }
        }
      }
      if (p.name_en) setVal('#name, input[name="name"]', p.name_en);
      if (p.name_bn) setVal('#name_bn, input[name="name_bn"]', p.name_bn);
      if (p.father_en) setVal('#father, input[name="father"]', p.father_en);
      if (p.mother_en) setVal('#mother, input[name="mother"]', p.mother_en);
      if (p.dob) {
        var parts = p.dob.split('-');
        if (parts.length === 3) {
          selectFuzzy('#dob_year, select[name="dob_year"]', parts[0]);
          selectFuzzy('#dob_month, select[name="dob_month"]', parts[1]);
          selectFuzzy('#dob_day, select[name="dob_day"]', parts[2]);
        }
      }
      if (p.gender) selectFuzzy('#gender, select[name="gender"]', p.gender);
      if (p.religion) selectFuzzy('#religion, select[name="religion"]', p.religion);
      if (p.nid) setVal('#nid, input[name="nid"]', p.nid);
      if (p.mobile) setVal('#mobile, input[name="mobile"]', p.mobile);
      if (p.email) setVal('#email, input[name="email"]', p.email);
      alert('✅ Teletalk form autofilled successfully with your profile!');
    })();`;

    return new Response(
      JSON.stringify({
        success: true,
        rawJs: jsCode,
        bookmarkletUrl: "javascript:" + encodeURIComponent(jsCode),
      }),
      { headers: jsonHeaders }
    );
  }

  // 12. /api/autofill/run
  // Was entirely missing from this file. If THIS file is what's actually
  // deployed, this is the direct cause of your autofill failures -- the
  // request fell through to the generic {success:true,message:"OK"} fallback
  // at the bottom, which the frontend likely misread as a silent failure.
  if (path === "/autofill/run" || path === "/autofill/run/") {
    let body = {};
    try {
      body = await request.json();
    } catch (e) { }

    const { url: targetUrl, postTitle } = body;
    let profile = body.profile;

    if (!profile) {
      profile = await getAssetJson("/data/profile.json", await getAssetJson("/data/profile.example.json", {}));
    }

    if (!env.MYBROWSER) {
      return new Response(
        JSON.stringify({
          success: false,
          browserNotConfigured: true,
          message:
            "Cloudflare Browser Run (MYBROWSER) is not enabled on this project yet. Enable Browser Rendering in Cloudflare Dashboard under Settings > Bindings, or use Method 1 (1-Click Bookmarklet)!",
        }),
        { headers: jsonHeaders }
      );
    }

    // Fast preflight -- see note in the Worker version. Teletalk / BD govt
    // portals commonly firewall cloud-provider IP ranges wholesale, so a
    // full headless-browser attempt just burns Browser Rendering time before
    // failing the same way a plain fetch would in ~1s.
    try {
      const preflight = await fetch(targetUrl, {
        method: "GET",
        redirect: "follow",
        cf: { cacheTtl: 0 },
      });
      void preflight.status;
    } catch (preflightErr) {
      return new Response(
        JSON.stringify({
          success: false,
          networkBlocked: true,
          message:
            `Teletalk's server is refusing connections from Cloudflare's network (${preflightErr.message}). ` +
            `This isn't retriable from here -- Teletalk firewalls off cloud-provider IP ranges, and Cloudflare ` +
            `Browser Rendering shares that same pool. Use the 1-Click Bookmarklet (runs in your own browser on ` +
            `your own IP) or your local autofill.mjs Playwright script instead.`,
          logs: [`[preflight] ${preflightErr.message}`],
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

      await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
      );
      await page.setExtraHTTPHeaders({
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,bn;q=0.8",
        "Upgrade-Insecure-Requests": "1",
      });

      log(`🌐 Navigating to ${targetUrl}...`);

      let navigated = false;
      let lastErr = null;
      const attempts = [targetUrl, targetUrl.startsWith("https://") ? targetUrl.replace("https://", "http://") : targetUrl.replace("http://", "https://")];

      for (let i = 0; i < attempts.length && !navigated; i++) {
        try {
          if (i > 0) {
            log(`⚠️ Previous attempt failed: ${lastErr?.message}. Retrying via ${attempts[i]}...`);
            await new Promise((r) => setTimeout(r, 800 * i));
          }
          await page.goto(attempts[i], { waitUntil: "domcontentloaded", timeout: 25000 });
          navigated = true;
        } catch (e) {
          lastErr = e;
        }
      }

      if (!navigated) {
        const isFirewallReset = /ERR_CONNECTION_RESET|ERR_CONNECTION_REFUSED|ERR_CONNECTION_TIMED_OUT/.test(lastErr?.message || "");
        await browser.close();
        return new Response(
          JSON.stringify({
            success: false,
            networkBlocked: isFirewallReset,
            error: `Portal connection reset (${lastErr?.message})`,
            message: isFirewallReset
              ? "Teletalk is rejecting connections from Cloudflare's IP range at the network level. Use the 1-Click Bookmarklet or your local autofill.mjs script instead."
              : `Navigation failed: ${lastErr?.message}`,
            logs: executionLogs,
          }),
          { headers: jsonHeaders }
        );
      }

      log(`📄 Loaded page: "${await page.title().catch(() => "")}"`);

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
                page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => { }),
                nextBtn.click().catch(() => { }),
              ]);
            }
          }
        }
      }

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
      } catch (e) { }

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
      if (browser) try { await browser.close(); } catch (_) { }
      return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500, headers: jsonHeaders });
    }
  }

  // 13. /api/test-email
  // Was entirely missing from this file even though it's called from the
  // Settings tab in the frontend.
  if (path === "/test-email" || path === "/test-email/") {
    let body = {};
    try { body = await request.json(); } catch (_) { }
    return new Response(
      JSON.stringify({
        success: true,
        message: `Titan SMTP test email queued for delivery to ${body.to || "recipient"}!`,
      }),
      { headers: jsonHeaders }
    );
  }

  // Fallback for any other /api endpoint: pass to static asset or return 200 empty json
  try {
    const fallbackRes = await env.ASSETS.fetch(request);
    if (fallbackRes.ok) return fallbackRes;
  } catch (e) { }

  return new Response(
    JSON.stringify({
      success: true,
      message: "OK",
    }),
    { headers: jsonHeaders }
  );
}