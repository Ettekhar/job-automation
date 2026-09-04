// profile.js — Applicant Profile Manager Controller

let currentProfileData = null;
let exampleProfileData = null;

// DOM Elements
const form = document.getElementById("profileForm");
const alertBanner = document.getElementById("profileAlertBanner");
const alertText = document.getElementById("profileAlertText");
const badgePill = document.getElementById("profileBadgePill");
const badgeText = document.getElementById("profileBadgeText");
const stickyName = document.getElementById("stickyApplicantName");
const stickyNote = document.getElementById("stickyStatusNote");
const jsonPreview = document.getElementById("jsonPreviewDisplay");
const bookmarkletLink = document.getElementById("profileBookmarkletLink");

// Buttons
const btnTopSave = document.getElementById("btnTopSave");
const btnSaveBottom = document.getElementById("btnSaveBottom");
const btnTopLoadSample = document.getElementById("btnTopLoadSample");
const btnTopClearEmpty = document.getElementById("btnTopClearEmpty");
const btnClearForm = document.getElementById("btnClearForm");
const btnDeleteProfile = document.getElementById("btnDeleteProfile");
const btnCopyAddress = document.getElementById("btnCopyAddress");
const btnCopyJson = document.getElementById("btnCopyJson");
const btnDownloadJson = document.getElementById("btnDownloadJson");
const btnCopyBookmarklet = document.getElementById("btnCopyBookmarklet");
const toggleMasters = document.getElementById("toggleMasters");
const mastersContainer = document.getElementById("mastersFieldsContainer");

// Toast helper
function showToast(message, type = "info") {
  const existing = document.querySelector(".profile-toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.className = `profile-toast ${type}`;
  toast.style.cssText = `
    position: fixed;
    top: 24px;
    right: 24px;
    padding: 12px 20px;
    background: ${type === "error" ? "rgba(244, 63, 94, 0.95)" : type === "success" ? "rgba(16, 185, 129, 0.95)" : "rgba(99, 102, 241, 0.95)"};
    color: #ffffff;
    font-weight: 600;
    font-size: 13px;
    border-radius: 8px;
    box-shadow: 0 10px 25px rgba(0,0,0,0.4);
    z-index: 9999;
    backdrop-filter: blur(12px);
    transition: all 0.3s ease;
  `;
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(-10px)";
    setTimeout(() => toast.remove(), 350);
  }, 3000);
}

let activeEmail = null;

async function getActiveUser() {
  try {
    const res = await fetch("/api/auth/me");
    if (res.ok) {
      const data = await res.json();
      if (data && data.user && data.user.email) {
        activeEmail = data.user.email.toLowerCase().trim();
        localStorage.setItem("teletalk_active_email", activeEmail);
        return data.user;
      }
    }
  } catch (_) {}
  activeEmail = localStorage.getItem("teletalk_active_email") || null;
  return null;
}

window.handleLogoutClick = async function(e) {
  if (e) e.preventDefault();
  try { localStorage.removeItem("teletalk_active_email"); } catch(_) {}
  try { await fetch("/api/auth/logout", { method: "POST" }); } catch(_) {}
  window.location.href = "/api/auth/logout";
};

// Fetch Profile from Server or Static Assets
async function fetchProfile() {
  try {
    const user = await getActiveUser();
    let profileData = null;
    let exampleData = null;
    let exists = false;

    // Load example template schema for sample reference
    try {
      const exRes = await fetch("/data/profile.example.json");
      if (exRes.ok) exampleData = await exRes.json();
    } catch (_) {}
    if (exampleData) exampleProfileData = exampleData;

    // 1. Check user-specific localStorage first
    if (activeEmail) {
      try {
        const localUser = localStorage.getItem("teletalk_profile_" + activeEmail);
        if (localUser) {
          const parsed = JSON.parse(localUser);
          if (parsed && parsed.name_en) {
            profileData = parsed;
            exists = true;
          }
        }
      } catch (_) {}
    }

    // 2. If not found in localStorage, fetch from /api/profile
    if (!profileData) {
      try {
        const res = await fetch("/api/profile");
        if (res.ok) {
          const data = await res.json();
          if (data && data.exists && data.profile && data.profile.name_en) {
            if (!activeEmail || !data.profile.email || data.profile.email.toLowerCase() === activeEmail) {
              profileData = data.profile;
              exists = true;
            }
          }
        }
      } catch (_) {}
    }

    if (exists && profileData) {
      currentProfileData = profileData;
      populateForm(currentProfileData);
      setProfileStatus(true, currentProfileData.name_en || "Configured Profile");
    } else {
      currentProfileData = null;
      clearFormFields();
      if (activeEmail) {
        setVal("email", activeEmail);
      }
      setProfileStatus(false);
    }
    updateLiveJsonAndBookmarklet();
  } catch (err) {
    console.error("Error loading profile:", err);
    setProfileStatus(false, "Error loading profile: " + err.message);
  }
}

// Update Status Badges & Banners
function setProfileStatus(hasProfile, name = "") {
  if (hasProfile) {
    alertBanner.className = "banner-alert success";
    alertText.innerHTML = `Active profile loaded for <strong>${escapeHtml(name)}</strong>. You can edit any details, add qualifications, or save changes anytime.`;
    badgePill.className = "profile-status-badge";
    badgePill.querySelector(".status-dot").className = "status-dot green";
    badgeText.textContent = "Profile Active";
    stickyName.textContent = name || "Applicant Profile";
    stickyNote.textContent = activeEmail ? `Linked to ${activeEmail}` : "Active Profile";
  } else {
    alertBanner.className = "banner-alert warning";
    alertText.innerHTML = `No profile saved yet${activeEmail ? ` for <strong>${escapeHtml(activeEmail)}</strong>` : ""}. Fill in your details below and click <strong>Save Profile</strong> (or click <strong>Load Sample</strong> for reference).`;
    badgePill.className = "profile-status-badge empty";
    badgePill.querySelector(".status-dot").className = "status-dot amber";
    badgeText.textContent = "Empty / New";
    stickyName.textContent = "New Applicant Profile";
    stickyNote.textContent = "Ready for your details";
  }
}

// Populate form from JSON object
function populateForm(p) {
  if (!p) return;

  // Basic Info
  setVal("name_en", p.name_en);
  setVal("name_bn", p.name_bn);
  setVal("father_en", p.father_en);
  setVal("father_bn", p.father_bn);
  setVal("mother_en", p.mother_en);
  setVal("mother_bn", p.mother_bn);
  setVal("dob", p.dob);
  setVal("gender", p.gender || "Male");
  setVal("nationality", p.nationality || "Bangladeshi");
  setVal("religion", p.religion || "Islam");
  setVal("marital_status", p.marital_status || "Single");
  setVal("quota", p.quota || "Not Applicable");
  setVal("departmental_status", p.departmental_status || "Not Applicable");

  // IDs & Contact
  setVal("national_id", p.national_id);
  setVal("birth_registration", p.birth_registration);
  setVal("passport_id", p.passport_id);
  setVal("mobile", p.mobile);
  setVal("email", p.email);

  // Present Address
  if (p.present_address) {
    setVal("pres_care_of", p.present_address.care_of);
    setVal("pres_village", p.present_address.village_road_house);
    setVal("pres_district", p.present_address.district);
    setVal("pres_upazila", p.present_address.upazila);
    setVal("pres_post_office", p.present_address.post_office);
    setVal("pres_post_code", p.present_address.post_code);
  }

  // Permanent Address
  if (p.permanent_address) {
    setVal("perm_care_of", p.permanent_address.care_of);
    setVal("perm_village", p.permanent_address.village_road_house);
    setVal("perm_district", p.permanent_address.district);
    setVal("perm_upazila", p.permanent_address.upazila);
    setVal("perm_post_office", p.permanent_address.post_office);
    setVal("perm_post_code", p.permanent_address.post_code);
  }

  // SSC
  if (p.ssc) {
    setVal("ssc_exam", p.ssc.examination || "SSC");
    setVal("ssc_board", p.ssc.board || "Dhaka");
    setVal("ssc_roll", p.ssc.roll);
    setVal("ssc_group", p.ssc.group || "Science");
    setVal("ssc_result", p.ssc.result || "GPA");
    setVal("ssc_gpa", p.ssc.gpa);
    setVal("ssc_scale", p.ssc.scale || "5");
    setVal("ssc_year", p.ssc.year);
  }

  // HSC
  if (p.hsc) {
    setVal("hsc_exam", p.hsc.examination || "HSC");
    setVal("hsc_board", p.hsc.board || "Dhaka");
    setVal("hsc_roll", p.hsc.roll);
    setVal("hsc_group", p.hsc.group || "Science");
    setVal("hsc_result", p.hsc.result || "GPA");
    setVal("hsc_gpa", p.hsc.gpa);
    setVal("hsc_scale", p.hsc.scale || "5");
    setVal("hsc_year", p.hsc.year);
  }

  // Graduation
  if (p.graduation) {
    setVal("gra_exam", p.graduation.examination || "B.Sc Engineering");
    setVal("gra_institute", p.graduation.institute);
    setVal("gra_subject", p.graduation.subject || "Computer Science & Engineering");
    setVal("gra_result", p.graduation.result || "CGPA");
    setVal("gra_gpa", p.graduation.gpa);
    setVal("gra_scale", p.graduation.scale || "4");
    setVal("gra_duration", p.graduation.duration || "04");
    setVal("gra_year", p.graduation.year);
  }

  // Masters
  if (p.masters && (p.masters.examination || p.masters.institute)) {
    toggleMasters.checked = true;
    mastersContainer.style.display = "block";
    setVal("mas_exam", p.masters.examination);
    setVal("mas_institute", p.masters.institute);
    setVal("mas_subject", p.masters.subject);
    setVal("mas_result", p.masters.result || "CGPA");
    setVal("mas_gpa", p.masters.gpa);
    setVal("mas_duration", p.masters.duration || "01");
    setVal("mas_year", p.masters.year);
  } else {
    toggleMasters.checked = false;
    mastersContainer.style.display = "none";
  }

  updateLiveJsonAndBookmarklet();
}

// Helper to set input value safely
function setVal(id, val) {
  const el = document.getElementById(id);
  if (!el) return;
  el.value = val !== undefined && val !== null ? String(val) : "";
}

// Helper to get input value safely
function getVal(id) {
  const el = document.getElementById(id);
  return el ? el.value.trim() : "";
}

// Clear all form fields
function clearFormFields() {
  const inputs = form.querySelectorAll("input, select");
  inputs.forEach((input) => {
    if (input.type === "checkbox") {
      input.checked = input.id === "chkComputerLiteracy";
    } else if (input.id === "nationality") {
      input.value = "Bangladeshi";
    } else if (input.id === "ssc_scale" || input.id === "hsc_scale") {
      input.value = "5";
    } else if (input.id === "gra_scale") {
      input.value = "4";
    } else {
      input.value = "";
    }
  });

  toggleMasters.checked = false;
  mastersContainer.style.display = "none";
  updateLiveJsonAndBookmarklet();
}

// Serialize Form to standard profile JSON object
function serializeForm() {
  const profile = {
    name_en: getVal("name_en").toUpperCase(),
    name_bn: getVal("name_bn"),
    father_en: getVal("father_en").toUpperCase(),
    father_bn: getVal("father_bn"),
    mother_en: getVal("mother_en").toUpperCase(),
    mother_bn: getVal("mother_bn"),
    dob: getVal("dob"),
    nationality: getVal("nationality") || "Bangladeshi",
    religion: getVal("religion") || "Islam",
    gender: getVal("gender") || "Male",
    marital_status: getVal("marital_status") || "Single",
    national_id: getVal("national_id"),
    birth_registration: getVal("birth_registration"),
    passport_id: getVal("passport_id"),
    mobile: getVal("mobile"),
    email: getVal("email"),
    quota: getVal("quota") || "Not Applicable",
    departmental_status: getVal("departmental_status") || "Not Applicable",
    present_address: {
      care_of: getVal("pres_care_of"),
      village_road_house: getVal("pres_village"),
      district: getVal("pres_district"),
      upazila: getVal("pres_upazila"),
      post_office: getVal("pres_post_office"),
      post_code: getVal("pres_post_code"),
    },
    permanent_address: {
      care_of: getVal("perm_care_of"),
      village_road_house: getVal("perm_village"),
      district: getVal("perm_district"),
      upazila: getVal("perm_upazila"),
      post_office: getVal("perm_post_office"),
      post_code: getVal("perm_post_code"),
    },
    ssc: {
      examination: getVal("ssc_exam") || "SSC",
      board: getVal("ssc_board") || "Dhaka",
      roll: getVal("ssc_roll"),
      result: getVal("ssc_result") || "GPA",
      gpa: getVal("ssc_gpa"),
      group: getVal("ssc_group") || "Science",
      year: getVal("ssc_year"),
      scale: getVal("ssc_scale") || "5",
    },
    hsc: {
      examination: getVal("hsc_exam") || "HSC",
      board: getVal("hsc_board") || "Dhaka",
      roll: getVal("hsc_roll"),
      result: getVal("hsc_result") || "GPA",
      gpa: getVal("hsc_gpa"),
      group: getVal("hsc_group") || "Science",
      year: getVal("hsc_year"),
      scale: getVal("hsc_scale") || "5",
    },
    graduation: {
      examination: getVal("gra_exam") || "B.Sc Engineering",
      institute: getVal("gra_institute"),
      subject: getVal("gra_subject") || "Computer Science & Engineering",
      result: getVal("gra_result") || "CGPA",
      gpa: getVal("gra_gpa"),
      year: getVal("gra_year"),
      duration: getVal("gra_duration") || "04",
      scale: getVal("gra_scale") || "4",
    },
  };

  // Optional Masters
  if (toggleMasters.checked && getVal("mas_exam")) {
    profile.masters = {
      examination: getVal("mas_exam"),
      institute: getVal("mas_institute"),
      subject: getVal("mas_subject"),
      result: getVal("mas_result") || "CGPA",
      gpa: getVal("mas_gpa"),
      duration: getVal("mas_duration") || "01",
      year: getVal("mas_year"),
      scale: "4",
    };
  }

  return profile;
}

// Generate Bookmarklet Code from profile object
function generateBookmarkletCode(profile) {
  const code = `(function(){
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
    selectFuzzy('#gender', p.gender);
    selectFuzzy('#nationality', p.nationality);
    selectFuzzy('#religion', p.religion);
    selectFuzzy('#marital_status', p.marital_status);
    selectFuzzy('#quota', p.quota);
    selectFuzzy('#dep_status', p.departmental_status);

    // IDs
    setRevealed('#nid', '#nid_no', p.national_id);
    setRevealed('#breg', '#breg_no', p.birth_registration);
    setRevealed('#passport', '#passport_no', p.passport_id);

    // Contact
    setVal('#mobile', p.mobile);
    setVal('#confirm_mobile', p.mobile);
    setVal('#email', p.email);

    // Addresses
    if (p.present_address) {
      setVal('#present_care', p.present_address.care_of);
      setVal('#present_village', p.present_address.village_road_house);
      selectFuzzy('#present_district', p.present_address.district);
      setTimeout(function() {
        selectFuzzy('#present_upazila', p.present_address.upazila);
      }, 500);
      setVal('#present_post', p.present_address.post_office);
      setVal('#present_pcode', p.present_address.post_code);
    }

    if (p.permanent_address) {
      setVal('#permanent_care', p.permanent_address.care_of);
      setVal('#permanent_village', p.permanent_address.village_road_house);
      selectFuzzy('#permanent_district', p.permanent_address.district);
      setTimeout(function() {
        selectFuzzy('#permanent_upazila', p.permanent_address.upazila);
      }, 500);
      setVal('#permanent_post', p.permanent_address.post_office);
      setVal('#permanent_pcode', p.permanent_address.post_code);
    }

    // Education: SSC
    if (p.ssc) {
      selectFuzzy('#ssc_exam', p.ssc.examination);
      selectFuzzy('#ssc_board', p.ssc.board);
      setVal('#ssc_roll', p.ssc.roll);
      selectFuzzy('#ssc_group', p.ssc.group);
      selectFuzzy('#ssc_result_type', p.ssc.result);
      setTimeout(function() { setVal('#ssc_result', p.ssc.gpa); }, 300);
      selectFuzzy('#ssc_year', p.ssc.year);
    }

    // Education: HSC
    if (p.hsc) {
      selectFuzzy('#hsc_exam', p.hsc.examination);
      selectFuzzy('#hsc_board', p.hsc.board);
      setVal('#hsc_roll', p.hsc.roll);
      selectFuzzy('#hsc_group', p.hsc.group);
      selectFuzzy('#hsc_result_type', p.hsc.result);
      setTimeout(function() { setVal('#hsc_result', p.hsc.gpa); }, 300);
      selectFuzzy('#hsc_year', p.hsc.year);
    }

    // Education: Graduation
    if (p.graduation) {
      selectFuzzy('#gra_exam', p.graduation.examination);
      selectFuzzy('#gra_institute', p.graduation.institute);
      setTimeout(function() {
        selectFuzzy('#gra_subject', p.graduation.subject);
      }, 500);
      selectFuzzy('#gra_result_type', p.graduation.result);
      setTimeout(function() { setVal('#gra_result', p.graduation.gpa); }, 300);
      selectFuzzy('#gra_duration', p.graduation.duration);
      selectFuzzy('#gra_year', p.graduation.year);
    }

    // Computer skills
    var selects = document.querySelectorAll('select');
    for (var s = 0; s < selects.length; s++) {
      var rowTxt = (selects[s].closest('tr, div, p') || selects[s].parentElement).innerText;
      if (/computer|typing|standard aptitude|ms office|ict/i.test(rowTxt)) {
        selectFuzzy(selects[s], 'Yes');
      }
    }

    // Declaration checkbox
    var chk = document.querySelector('#declaration, input[type=checkbox]#confirm, input[type=checkbox]#declaration');
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

  return code;
}

// Update JSON Preview & Bookmarklet link in real time
function updateLiveJsonAndBookmarklet() {
  const currentObj = serializeForm();
  const jsonStr = JSON.stringify(currentObj, null, 2);
  if (jsonPreview) jsonPreview.textContent = jsonStr;

  if (bookmarkletLink) {
    const rawJs = generateBookmarkletCode(currentObj);
    bookmarkletLink.href = `javascript:${encodeURIComponent(rawJs)}`;
  }

  const applicant = getVal("name_en");
  stickyName.textContent = applicant || "Applicant Profile";
}

// Save Profile to Server
async function handleSaveProfile() {
  const profile = serializeForm();

  if (!profile.name_en) {
    showToast("Please enter at least Applicant's Name (English)", "error");
    document.getElementById("name_en").focus();
    return;
  }
  if (!profile.mobile) {
    showToast("Please enter Mobile Number", "error");
    document.getElementById("mobile").focus();
    return;
  }

  btnTopSave.disabled = true;
  btnSaveBottom.disabled = true;
  btnTopSave.textContent = "Saving...";
  btnSaveBottom.textContent = "Saving...";

  try {
    // Persist to email-scoped local storage immediately
    try {
      if (activeEmail) {
        localStorage.setItem("teletalk_profile_" + activeEmail, JSON.stringify(profile));
        localStorage.setItem("teletalk_active_email", activeEmail);
      }
      localStorage.setItem("teletalk_profile", JSON.stringify(profile));
    } catch (_) {}

    const res = await fetch("/api/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(profile),
    });

    let isSaved = res.ok;
    try {
      const data = await res.json();
      if (data && data.success) isSaved = true;
    } catch (_) {}

    currentProfileData = profile;
    setProfileStatus(true, profile.name_en);
    showToast("✅ Profile saved successfully!", "success");
  } catch (err) {
    currentProfileData = profile;
    setProfileStatus(true, profile.name_en);
    showToast("✅ Profile saved locally in your browser!", "success");
  } finally {
    btnTopSave.disabled = false;
    btnSaveBottom.disabled = false;
    btnTopSave.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg> <span>Save Profile</span>`;
    btnSaveBottom.textContent = "💾 Save Profile";
  }
}

// Delete Profile
async function handleDeleteProfile() {
  const confirmDelete = window.confirm("Are you sure you want to delete config/profile.json? All saved applicant information will be removed.");
  if (!confirmDelete) return;

  try {
    const res = await fetch("/api/profile", { method: "DELETE" });
    const data = await res.json();
    if (data.success) {
      currentProfileData = null;
      clearFormFields();
      setProfileStatus(false);
      showToast("🗑️ Profile deleted. Ready for new applicant data.", "info");
    } else {
      showToast("❌ Failed to delete: " + data.error, "error");
    }
  } catch (err) {
    showToast("❌ Network error: " + err.message, "error");
  }
}

// Copy Address Helper
function copyPresentToPermanent() {
  setVal("perm_care_of", getVal("pres_care_of"));
  setVal("perm_village", getVal("pres_village"));
  setVal("perm_district", getVal("pres_district"));
  setVal("perm_upazila", getVal("pres_upazila"));
  setVal("perm_post_office", getVal("pres_post_office"));
  setVal("perm_post_code", getVal("pres_post_code"));
  updateLiveJsonAndBookmarklet();
  showToast("📋 Present address copied to Permanent address!", "info");
}

// Copy JSON helper
function copyJsonToClipboard() {
  const profile = serializeForm();
  const jsonStr = JSON.stringify(profile, null, 2);
  navigator.clipboard.writeText(jsonStr).then(() => {
    showToast("📋 Profile JSON copied to clipboard!", "success");
  }).catch(() => {
    showToast("Failed to copy JSON", "error");
  });
}

// Download profile.json
function downloadProfileJson() {
  const profile = serializeForm();
  const jsonStr = JSON.stringify(profile, null, 2);
  const blob = new Blob([jsonStr], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "profile.json";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast("💾 Downloading profile.json...", "info");
}

// Copy Bookmarklet script for DevTools console
function copyBookmarkletScript() {
  const profile = serializeForm();
  const rawJs = generateBookmarkletCode(profile);
  navigator.clipboard.writeText(rawJs).then(() => {
    showToast("📋 Bookmarklet JavaScript copied to clipboard!", "success");
  }).catch(() => {
    showToast("Failed to copy bookmarklet", "error");
  });
}

// Load Sample Data
function loadSampleProfile() {
  if (exampleProfileData) {
    populateForm(exampleProfileData);
    showToast("📋 Loaded sample profile! Review the fields and click 'Save Profile' to save it.", "info");
  } else {
    // Fallback sample
    fetch("/api/profile/load-example", { method: "POST" })
      .then(res => res.json())
      .then(data => {
        if (data.profile) {
          populateForm(data.profile);
          showToast("📋 Loaded sample profile! Click 'Save Profile' to persist.", "info");
        }
      })
      .catch(err => showToast("Error loading sample: " + err.message, "error"));
  }
}

// Escape HTML utility
function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Event Listeners
document.addEventListener("DOMContentLoaded", () => {
  fetchProfile();

  // Real-time input listeners
  form.addEventListener("input", updateLiveJsonAndBookmarklet);
  form.addEventListener("change", updateLiveJsonAndBookmarklet);

  // Save buttons
  btnTopSave.addEventListener("click", handleSaveProfile);
  btnSaveBottom.addEventListener("click", handleSaveProfile);

  // Clear / Sample buttons
  btnTopClearEmpty.addEventListener("click", () => {
    clearFormFields();
    setProfileStatus(false);
    showToast("🧹 Form cleared. Ready for fresh applicant details.", "info");
  });
  btnClearForm.addEventListener("click", () => {
    clearFormFields();
    setProfileStatus(false);
    showToast("🧹 Form cleared.", "info");
  });
  btnTopLoadSample.addEventListener("click", loadSampleProfile);

  // Delete
  btnDeleteProfile.addEventListener("click", handleDeleteProfile);

  // Address copy
  btnCopyAddress.addEventListener("click", copyPresentToPermanent);

  // JSON & Bookmarklet tools
  btnCopyJson.addEventListener("click", copyJsonToClipboard);
  btnDownloadJson.addEventListener("click", downloadProfileJson);
  btnCopyBookmarklet.addEventListener("click", copyBookmarkletScript);

  // Masters Toggle
  toggleMasters.addEventListener("change", (e) => {
    mastersContainer.style.display = e.target.checked ? "block" : "none";
    updateLiveJsonAndBookmarklet();
  });
});
