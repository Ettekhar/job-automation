/**
 * autofillCore.mjs -- Universal Teletalk Form-Filling Engine
 * Shared between local desktop Playwright and Cloudflare Browser Run.
 */

// Strict submit selectors (standard across all Teletalk portals)
export const STRICT_SUBMIT_SEL = [
  "input[type=submit]",
  "button[type=submit]",
  "#submit",
  "#btnSubmit",
  "#submit_btn",
  "input[value*='Submit' i]",
  "input[value*='Next' i]",
].join(", ");

export const FALLBACK_SUBMIT_SEL = [
  "button:has-text('Submit')",
  "a:has-text('Submit')",
  "a:has-text('Next')",
  "input[type=image]",
].join(", ");

// ── 1. Smart Input & Dropdown Fillers ──────────────────────────────────────────

export async function fillText(page, selector, value) {
  if (value === undefined || value === null || value === "") return false;
  try {
    const el = page.locator(selector).first();
    if (await el.count().catch(() => 0)) {
      await el.click({ force: true }).catch(() => {});
      await el.fill(String(value)).catch(() => {});
      await el.evaluate((e, v) => {
        e.value = v;
        e.dispatchEvent(new Event("input", { bubbles: true }));
        e.dispatchEvent(new Event("change", { bubbles: true }));
        e.style.backgroundColor = "#dcfce7";
      }, String(value)).catch(() => {});
      return true;
    }
  } catch (_) {}
  return false;
}

export async function selectFuzzy(page, selector, wanted) {
  if (wanted === undefined || wanted === null || String(wanted).trim() === "") return false;
  try {
    const select = page.locator(selector).first();
    if (!(await select.count().catch(() => 0))) return false;

    const options = await select.locator("option").allTextContents().catch(() => []);
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
    let match = null;
    for (const t of targetsToTry) {
      match = options.find((o) => normalize(o) === t);
      if (!match) match = options.find((o) => normalize(o).includes(t) && t.length > 2);
      if (!match) match = options.find((o) => t.includes(normalize(o)) && normalize(o).length > 2);
      if (match) break;
    }

    if (match) {
      await select.selectOption({ label: match }).catch(() => {});
      await select.evaluate((el) => {
        if (typeof el.onchange === "function") {
          try { el.onchange(); } catch (e) {}
        }
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.style.backgroundColor = "#dcfce7";
      }).catch(() => {});
      return true;
    }
  } catch (_) {}
  return false;
}

export async function waitForOptions(page, selector, minCount = 2, timeout = 3000) {
  try {
    const select = page.locator(selector).first();
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const count = await select.locator("option").count().catch(() => 0);
      if (count >= minCount) return true;
      await page.waitForTimeout(200);
    }
  } catch (_) {}
  return false;
}

// ── 2. Form Fillers ────────────────────────────────────────────────────────────

export async function fillMainForm(page, profile) {
  if (!profile) return 0;
  let count = 0;

  // Basic Personal Info
  if (await fillText(page, "#name, input[name='name']", profile.name_en)) count++;
  if (await fillText(page, "#name_bn, input[name='name_bn']", profile.name_bn)) count++;
  if (await fillText(page, "#father, input[name='father_name']", profile.father_en)) count++;
  if (await fillText(page, "#father_bn, input[name='father_name_bn']", profile.father_bn)) count++;
  if (await fillText(page, "#mother, input[name='mother_name']", profile.mother_en)) count++;
  if (await fillText(page, "#mother_bn, input[name='mother_name_bn']", profile.mother_bn)) count++;
  if (await fillText(page, "#dob, input[name='dob']", profile.dob)) count++;

  if (await selectFuzzy(page, "#gender, select[name='gender']", profile.gender)) count++;
  if (await selectFuzzy(page, "#religion, select[name='religion']", profile.religion)) count++;
  if (await selectFuzzy(page, "#nationality, select[name='nationality']", profile.nationality)) count++;
  if (await selectFuzzy(page, "#marital_status, select[name='marital_status']", profile.marital_status)) count++;
  if (await selectFuzzy(page, "#quota, select[name='quota']", profile.quota || "None")) count++;

  // Identifiers
  if (await fillText(page, "#nid, input[name='nid_no'], input[name='nid']", profile.nid)) count++;
  if (await fillText(page, "#mobile, input[name='mobile'], input[name='mobile_no']", profile.mobile)) count++;
  if (await fillText(page, "#re_mobile, input[name='confirm_mobile']", profile.mobile)) count++;
  if (await fillText(page, "#email, input[name='email']", profile.email)) count++;

  // Present Address
  if (await fillText(page, "#present_care_of", profile.present_care_of || profile.father_en)) count++;
  if (await fillText(page, "#present_village", profile.present_village)) count++;
  if (await selectFuzzy(page, "#present_district", profile.present_district)) {
    count++;
    await waitForOptions(page, "#present_thana", 2, 3000);
    if (await selectFuzzy(page, "#present_thana", profile.present_thana)) count++;
  }
  if (await fillText(page, "#present_post_code", profile.present_post_code)) count++;

  // Permanent Address
  if (await fillText(page, "#permanent_care_of", profile.permanent_care_of || profile.father_en)) count++;
  if (await fillText(page, "#permanent_village", profile.permanent_village)) count++;
  if (await selectFuzzy(page, "#permanent_district", profile.permanent_district)) {
    count++;
    await waitForOptions(page, "#permanent_thana", 2, 3000);
    if (await selectFuzzy(page, "#permanent_thana", profile.permanent_thana)) count++;
  }
  if (await fillText(page, "#permanent_post_code", profile.permanent_post_code)) count++;

  // SSC Details
  if (profile.ssc) {
    if (await selectFuzzy(page, "#ssc_exam", profile.ssc.examination)) count++;
    if (await selectFuzzy(page, "#ssc_board", profile.ssc.board)) count++;
    if (await fillText(page, "#ssc_roll", profile.ssc.roll)) count++;
    if (await selectFuzzy(page, "#ssc_result_type", "GPA")) {
      await page.waitForTimeout(200);
      await fillText(page, "#ssc_result", profile.ssc.gpa);
    } else {
      await fillText(page, "#ssc_result", profile.ssc.gpa);
    }
    if (await selectFuzzy(page, "#ssc_group", profile.ssc.group)) count++;
    if (await selectFuzzy(page, "#ssc_year", profile.ssc.year)) count++;
  }

  // HSC Details
  if (profile.hsc) {
    if (await selectFuzzy(page, "#hsc_exam", profile.hsc.examination)) count++;
    if (await selectFuzzy(page, "#hsc_board", profile.hsc.board)) count++;
    if (await fillText(page, "#hsc_roll", profile.hsc.roll)) count++;
    if (await selectFuzzy(page, "#hsc_result_type", "GPA")) {
      await page.waitForTimeout(200);
      await fillText(page, "#hsc_result", profile.hsc.gpa);
    } else {
      await fillText(page, "#hsc_result", profile.hsc.gpa);
    }
    if (await selectFuzzy(page, "#hsc_group", profile.hsc.group)) count++;
    if (await selectFuzzy(page, "#hsc_year", profile.hsc.year)) count++;
  }

  // Graduation / Honours Details
  if (profile.graduation) {
    // Enable applicable checkbox if exists
    const graCb = page.locator("#gra_applicable, input[name*='gra_app']").first();
    if (await graCb.count().catch(() => 0)) {
      await graCb.check({ force: true }).catch(() => {});
      await page.waitForTimeout(300);
    }

    if (await selectFuzzy(page, "#gra_exam", profile.graduation.examination)) count++;
    if (await selectFuzzy(page, "#gra_institute", profile.graduation.university || profile.graduation.institute)) {
      count++;
      await waitForOptions(page, "#gra_subject", 2, 3000);
    }
    if (await selectFuzzy(page, "#gra_subject", profile.graduation.subject)) count++;
    if (await fillText(page, "#gra_roll", profile.graduation.roll)) count++;
    if (await selectFuzzy(page, "#gra_result_type", "CGPA")) {
      await page.waitForTimeout(200);
      await fillText(page, "#gra_result", profile.graduation.cgpa);
    } else {
      await fillText(page, "#gra_result", profile.graduation.cgpa);
    }
    if (await selectFuzzy(page, "#gra_year", profile.graduation.passing_year || profile.graduation.year)) count++;
  }

  return count;
}

export async function fillOtherQualifications(page) {
  // Answer "Yes" to computer typing / literacy questions
  try {
    await page.evaluate(() => {
      const selects = Array.from(document.querySelectorAll("select"));
      selects.forEach((sel) => {
        const text = (sel.closest("tr, td, div")?.textContent || "").toLowerCase();
        if (text.includes("computer") || text.includes("typing") || text.includes("literacy")) {
          for (let i = 0; i < sel.options.length; i++) {
            if (sel.options[i].text.toLowerCase().includes("yes")) {
              sel.selectedIndex = i;
              sel.dispatchEvent(new Event("change", { bubbles: true }));
              sel.style.backgroundColor = "#dcfce7";
              break;
            }
          }
        }
      });
    });
  } catch (_) {}
}

export async function tickDeclarationCheckbox(page) {
  try {
    const chk = page.locator("#agree, #declaration, input[type='checkbox']").last();
    if (await chk.count().catch(() => 0)) {
      await chk.check({ force: true }).catch(() => {});
      await page.waitForTimeout(200);
      return true;
    }
  } catch (_) {}
  return false;
}

export async function findAndClickSubmit(page, { timeoutMs = 8000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const btn = page.locator(STRICT_SUBMIT_SEL).first();
    if (await btn.count().catch(() => 0) && (await btn.isVisible().catch(() => false))) {
      await btn.scrollIntoViewIfNeeded().catch(() => {});
      await btn.evaluate((el) => { el.disabled = false; }).catch(() => {});
      await btn.click({ force: true }).catch(() => {});
      await page.waitForTimeout(1500);
      return true;
    }
    await page.waitForTimeout(400);
  }
  return false;
}

// ── 3. High-level Universal Autofill Pipeline ─────────────────────────────────

export async function runAutofillPipeline({ page, context, profile, postTitle, startUrl }) {
  console.log(`[AutofillEngine] 🚀 Starting autofill pipeline for ${postTitle || "Job"}...`);

  if (startUrl) {
    await page.goto(startUrl, { timeout: 25000, waitUntil: "domcontentloaded" }).catch(() => {});
    await page.waitForTimeout(1500);
  }

  // 1. Wait for application form or navigate
  let formPage = page;
  const isFormPresent = (await formPage.locator("#name, input[name='name']").count().catch(() => 0)) > 0;

  if (!isFormPresent && postTitle) {
    // Look for post selection radio
    const radios = await formPage.locator("input[type=radio]").all().catch(() => []);
    if (radios.length > 0) {
      for (const r of radios) {
        const text = await r.evaluate((el) => el.closest("tr, label, div")?.innerText || "").catch(() => "");
        if (text.toLowerCase().includes(postTitle.toLowerCase())) {
          await r.check({ force: true }).catch(() => {});
          break;
        }
      }
      // Click Next
      const nextBtn = formPage.locator("input[type=submit], button[type=submit], input[value*='Next']").first();
      if (await nextBtn.count().catch(() => 0)) {
        await nextBtn.click({ force: true }).catch(() => {});
        await formPage.waitForTimeout(2000);
      }
    }
  }

  // 2. Fill the main form fields
  const fieldsCount = await fillMainForm(formPage, profile);
  console.log(`[AutofillEngine] ✅ Filled ${fieldsCount} fields!`);

  // 3. Fill computer literacy & extra questions
  await fillOtherQualifications(formPage);

  // 4. Tick declaration checkbox
  await tickDeclarationCheckbox(formPage);

  return {
    success: true,
    fieldsCount,
    formPage,
  };
}
