/**
 * Cloudflare Pages Function - Cloud Auto-Apply Engine
 * Uses Cloudflare Browser Run (@cloudflare/puppeteer) to headlessly navigate,
 * autofill Teletalk application forms, read CAPTCHAs via Cloudflare AI,
 * and return a verified screenshot to the user.
 */

export async function onRequestPost(context) {
  const { request, env } = context;

  const jsonHeaders = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  };

  let body = {};
  try {
    body = await request.json();
  } catch (e) {
    body = {};
  }

  const { url, postTitle } = body;
  let profile = body.profile;

  if (!url) {
    return new Response(
      JSON.stringify({ success: false, error: "Missing job application URL" }),
      { status: 400, headers: jsonHeaders }
    );
  }

  // If profile not provided in body, attempt to read default profile from static asset
  if (!profile) {
    try {
      const assetUrl = new URL("/data/profile.example.json", request.url);
      const res = await env.ASSETS.fetch(assetUrl);
      if (res.ok) {
        profile = await res.json();
      }
    } catch (e) {}
  }

  // Check if Cloudflare Browser Run is bound
  if (!env.MYBROWSER) {
    return new Response(
      JSON.stringify({
        success: false,
        browserNotConfigured: true,
        message:
          "Cloudflare Browser Run binding (MYBROWSER) is not active yet. In your Cloudflare Dashboard, go to Workers & Pages > Settings > Bindings > Browser Rendering, or use the 1-Click Bookmarklet!",
      }),
      { headers: jsonHeaders }
    );
  }

  let browser;
  try {
    // Dynamically import @cloudflare/puppeteer
    const puppeteer = await import("@cloudflare/puppeteer");
    browser = await puppeteer.default.launch(env.MYBROWSER);
    const page = await browser.newPage();

    await page.setViewport({ width: 1280, height: 900 });

    // 1. Navigate to target portal
    await page.goto(url, { waitUntil: "networkidle0", timeout: 30000 });

    // 2. Inject Teletalk Form Filler script
    const fillResult = await page.evaluate((p) => {
      let filledCount = 0;

      function setVal(sel, val) {
        if (!val) return false;
        const el = document.querySelector(sel);
        if (!el) return false;
        el.value = val;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.style.backgroundColor = "#dcfce7"; // light green
        filledCount++;
        return true;
      }

      function selectFuzzy(sel, wanted) {
        if (!wanted) return false;
        const el = document.querySelector(sel);
        if (!el || !el.options) return false;
        const target = String(wanted).toLowerCase().replace(/[^a-z0-9]/g, "");
        for (let i = 0; i < el.options.length; i++) {
          const optText = el.options[i].text.toLowerCase().replace(/[^a-z0-9]/g, "");
          if (optText === target || optText.includes(target) || target.includes(optText)) {
            el.selectedIndex = i;
            el.dispatchEvent(new Event("change", { bubbles: true }));
            el.style.backgroundColor = "#dcfce7";
            filledCount++;
            return true;
          }
        }
        return false;
      }

      if (!p) return { filledCount: 0, isFormPresent: false };

      // Check if application form is loaded
      const hasNameInput = Boolean(document.querySelector("#name, input[name='name'], input[name='applicant_name']"));

      // Fill Personal Details
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
      setVal("#nid, input[name='nid_no'], input[name='nid']", p.nid);
      setVal("#mobile, input[name='mobile'], input[name='mobile_no']", p.mobile);
      setVal("#re_mobile, input[name='confirm_mobile']", p.mobile);
      setVal("#email, input[name='email']", p.email);

      // Present Address
      setVal("#present_care_of, input[name='present_care_of']", p.present_care_of || p.father_en);
      setVal("#present_village, input[name='present_village']", p.present_village);
      selectFuzzy("#present_district, select[name='present_district']", p.present_district);
      selectFuzzy("#present_thana, select[name='present_thana'], select[name='present_upazila']", p.present_thana);
      setVal("#present_post_code, input[name='present_post_code']", p.present_post_code);

      // Permanent Address
      setVal("#permanent_care_of, input[name='permanent_care_of']", p.permanent_care_of || p.father_en);
      setVal("#permanent_village, input[name='permanent_village']", p.permanent_village);
      selectFuzzy("#permanent_district, select[name='permanent_district']", p.permanent_district);
      selectFuzzy("#permanent_thana, select[name='permanent_thana'], select[name='permanent_upazila']", p.permanent_thana);
      setVal("#permanent_post_code, input[name='permanent_post_code']", p.permanent_post_code);

      // Education: SSC
      if (p.ssc) {
        selectFuzzy("#ssc_exam, select[name='ssc_examination']", p.ssc.examination);
        selectFuzzy("#ssc_board, select[name='ssc_board']", p.ssc.board);
        setVal("#ssc_roll, input[name='ssc_roll']", p.ssc.roll);
        setVal("#ssc_result, input[name='ssc_result']", p.ssc.gpa);
        selectFuzzy("#ssc_group, select[name='ssc_group']", p.ssc.group);
        setVal("#ssc_year, input[name='ssc_year']", p.ssc.year);
      }

      // Education: HSC
      if (p.hsc) {
        selectFuzzy("#hsc_exam, select[name='hsc_examination']", p.hsc.examination);
        selectFuzzy("#hsc_board, select[name='hsc_board']", p.hsc.board);
        setVal("#hsc_roll, input[name='hsc_roll']", p.hsc.roll);
        setVal("#hsc_result, input[name='hsc_result']", p.hsc.gpa);
        selectFuzzy("#hsc_group, select[name='hsc_group']", p.hsc.group);
        setVal("#hsc_year, input[name='hsc_year']", p.hsc.year);
      }

      // Education: Graduation / Honours
      if (p.graduation) {
        selectFuzzy("#gra_exam, select[name='gra_examination']", p.graduation.examination);
        selectFuzzy("#gra_institute, select[name='gra_institute']", p.graduation.university);
        setVal("#gra_roll, input[name='gra_roll']", p.graduation.roll);
        setVal("#gra_result, input[name='gra_result']", p.graduation.cgpa);
        selectFuzzy("#gra_subject, select[name='gra_subject']", p.graduation.subject);
        setVal("#gra_year, input[name='gra_year']", p.graduation.passing_year);
      }

      // Computer Literacy & Skills (default Yes)
      const allSelects = Array.from(document.querySelectorAll("select"));
      allSelects.forEach((sel) => {
        const text = (sel.closest("tr")?.textContent || "").toLowerCase();
        if (text.includes("computer") || text.includes("typing") || text.includes("literacy")) {
          selectFuzzy(sel, "Yes");
        }
      });

      // Check declaration checkbox
      const chk = document.querySelector("#agree, #declaration, input[type='checkbox']");
      if (chk && !chk.checked) {
        chk.checked = true;
        chk.dispatchEvent(new Event("change", { bubbles: true }));
      }

      return {
        filledCount,
        hasNameInput,
        pageTitle: document.title,
      };
    }, profile);

    // 3. Handle CAPTCHA with Cloudflare Workers AI if element is present
    let captchaSolved = false;
    try {
      const captchaEl = await page.$("img[src*='captcha'], #captcha_img, .captcha img");
      if (captchaEl && env.AI) {
        const captchaBuffer = await captchaEl.screenshot({ type: "jpeg" });
        const base64Image = captchaBuffer.toString("base64");

        // Ask Cloudflare Workers AI Vision model
        const aiRes = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", {
          prompt: "What are the exact alphanumeric characters shown in this CAPTCHA image? Return ONLY the letters/numbers with NO spaces and NO punctuation.",
          image: [...captchaBuffer],
        });

        const solvedText = (aiRes?.response || "").replace(/[^a-zA-Z0-9]/g, "").trim();
        if (solvedText.length >= 4) {
          await page.evaluate((txt) => {
            const input = document.querySelector("#captcha, input[name='captcha'], input[name='validation_code']");
            if (input) {
              input.value = txt;
              input.dispatchEvent(new Event("input", { bubbles: true }));
              input.dispatchEvent(new Event("change", { bubbles: true }));
              input.style.backgroundColor = "#fef08a"; // yellow highlight
            }
          }, solvedText);
          captchaSolved = true;
        }
      }
    } catch (captchaErr) {
      console.warn("Cloudflare AI CAPTCHA detection error:", captchaErr);
    }

    // 4. Capture screenshot of the filled page
    const screenshotBuffer = await page.screenshot({ type: "jpeg", quality: 75, fullPage: false });
    const screenshotBase64 = `data:image/jpeg;base64,${screenshotBuffer.toString("base64")}`;

    await browser.close();

    return new Response(
      JSON.stringify({
        success: true,
        message: `Successfully filled ${fillResult.filledCount} fields in Cloudflare cloud!`,
        filledFields: fillResult.filledCount,
        captchaSolved,
        screenshot: screenshotBase64,
        url,
        postTitle,
      }),
      { headers: jsonHeaders }
    );
  } catch (err) {
    if (browser) {
      try {
        await browser.close();
      } catch (e) {}
    }
    return new Response(
      JSON.stringify({
        success: false,
        error: `Cloudflare Playwright error: ${err.message}`,
      }),
      { status: 500, headers: jsonHeaders }
    );
  }
}
