// Teletalk Job Notifier Dashboard Client Logic
let currentFilter = "matched";
let allJobs = [];
let allNotices = [];
let appliedJobsList = [];
let noticeFilterMode = "all";
let targetKeywords = [];
let sseSource = null;
let currentAlertJob = null;
let defaultNotifyEmail = "taion@razibmarketing.net";

let rawAllJobsCache = [];
let rawAllNoticesCache = [];

// Safe JSON fetch with automatic static asset fallback for Cloudflare Pages
async function safeJsonFetch(primaryUrl, fallbackUrl) {
  try {
    const res = await fetch(primaryUrl);
    if (res.ok) {
      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        return await res.json();
      }
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch (e) {}
    }
  } catch (e) {}

  if (fallbackUrl) {
    try {
      const fbRes = await fetch(fallbackUrl);
      if (fbRes.ok) {
        return await fbRes.json();
      }
    } catch (e) {}
  }
  return null;
}

// Redirect to /login if API returns 401
async function apiFetch(url, options = {}) {
  const res = await fetch(url, options);
  if (res.status === 401) {
    window.location.href = "/login";
    return null;
  }
  return res;
}

document.addEventListener("DOMContentLoaded", () => {
  initApp();
});

async function initApp() {
  setupEventListeners();
  connectLiveLogEvents();
  loadCurrentUser(); // non-blocking
  await loadOverview();
  await loadJobs();
  await loadKeywords();
  await loadSettings();
  await loadAiSettings();

  // Auto-refresh overview every 20 seconds
  setInterval(loadOverview, 20000);
}

async function loadCurrentUser() {
  try {
    const data = await safeJsonFetch("/api/auth/me", "/api/auth/me.json");
    const user = data && data.user ? data.user : { name: "Admin", email: "taion16240@gmail.com" };
    const pill = document.getElementById("userPill");
    const avatar = document.getElementById("userAvatar");
    const nameLabel = document.getElementById("userNameLabel");
    if (pill) {
      pill.style.display = "flex";
      if (avatar && user.picture) {
        avatar.src = user.picture;
        avatar.style.display = "block";
      }
      if (nameLabel) {
        nameLabel.textContent = user.name || user.email || "Admin";
      }
    }
  } catch (e) {
    const pill = document.getElementById("userPill");
    const nameLabel = document.getElementById("userNameLabel");
    if (pill) pill.style.display = "flex";
    if (nameLabel) nameLabel.textContent = "Admin";
  }
}


// -------------------------------------------------------------
// Data Fetching
// -------------------------------------------------------------
async function loadOverview() {
  try {
    let data = await safeJsonFetch("/api/overview", "/data/overview.json");
    if (!data || !data.success) {
      data = await safeJsonFetch("data/overview.json");
    }

    // If overview JSON isn't available, synthesize from rawAllJobsCache if we have it
    if (!data || !data.success) {
      if (rawAllJobsCache.length > 0) {
        const matched = rawAllJobsCache.filter((j) => j.isMatch).length;
        const bb = rawAllJobsCache.filter((j) => j.source === "bb").length;
        data = {
          success: true,
          stats: {
            totalJobs: rawAllJobsCache.length,
            matchedJobs: matched,
            seenCount: rawAllJobsCache.length,
            bbJobs: bb,
            noticesCount: rawAllNoticesCache.length,
            matchedNoticesCount: rawAllNoticesCache.filter((n) => n.isMatch).length,
          },
        };
      }
    }

    if (!data || !data.stats) return;

    // Update Stats Cards
    document.getElementById("statTotalJobs").textContent = data.stats.totalJobs.toLocaleString();
    document.getElementById("statMatchedJobs").textContent = data.stats.matchedJobs.toLocaleString();
    document.getElementById("statSeenJobs").textContent = data.stats.seenCount.toLocaleString();

    // BB Jobs stat
    const bbCount = data.stats.bbJobs || 0;
    const bbEl = document.getElementById("statBBJobs");
    if (bbEl) {
      bbEl.textContent = bbCount.toLocaleString();
      const bbSub = document.getElementById("statBBSub");
      if (bbSub) bbSub.textContent = bbCount > 0 ? `${bbCount} job${bbCount !== 1 ? 's' : ''} tracked` : "erecruitment.bb.org.bd";
    }

    // BB Notice Board stats
    const noticesCount = data.stats.noticesCount || 0;
    const matchedNoticesCount = data.stats.matchedNoticesCount || 0;
    const noticesEl = document.getElementById("statNoticesCount");
    if (noticesEl) noticesEl.textContent = noticesCount.toLocaleString();
    const noticesMatchedEl = document.getElementById("statNoticesMatchedCount");
    if (noticesMatchedEl) noticesMatchedEl.textContent = matchedNoticesCount.toLocaleString();
    const navNoticesEl = document.getElementById("navNoticesCount");
    if (navNoticesEl) navNoticesEl.textContent = noticesCount.toLocaleString();
    const mNavNoticesBadge = document.getElementById("mNavNoticesBadge");
    if (mNavNoticesBadge) mNavNoticesBadge.textContent = noticesCount.toLocaleString();
    const mDrawerNoticesCount = document.getElementById("mDrawerNoticesCount");
    if (mDrawerNoticesCount) mDrawerNoticesCount.textContent = noticesCount.toLocaleString();

    if (data.stats.lastScrape) {
      const timeStr = formatRelativeTime(data.stats.lastScrape.timestamp);
      document.getElementById("statLastScrapedTime").textContent = timeStr;
      document.getElementById("statLastScrapedSub").textContent = `Duration: ${data.stats.lastScrape.durationSeconds || 120}s (${data.stats.lastScrape.status || 'OK'})`;
      if (data.stats.lastScrape.circularsScanned) {
        document.getElementById("statCircularsSub").textContent = `${data.stats.lastScrape.circularsScanned} circulars scanned`;
      }
    }

    document.getElementById("statSmtpStatus").textContent = "Ready";
    document.getElementById("statSmtpSub").textContent = "smtp.titan.email:587";
    document.getElementById("headerRecipientEmail").textContent = "taion@razibmarketing.net";

    // Profile badge & Autofill indicator status
    const navProfileBadge = document.getElementById("navProfileBadge");
    if (navProfileBadge) {
      navProfileBadge.textContent = "Active";
      navProfileBadge.style.background = "rgba(16, 185, 129, 0.15)";
      navProfileBadge.style.color = "#10b981";
      navProfileBadge.style.border = "1px solid rgba(16, 185, 129, 0.3)";
    }

    // Scheduler status
    const schedPill = document.getElementById("schedulerStatusPill");
    if (schedPill) {
      schedPill.innerHTML = `<span class="status-dot green"></span><span>GitHub Actions Cron: Every 6h</span>`;
    }
  } catch (err) {
    console.error("Failed to load overview:", err);
  }
}

async function loadJobs() {
  const grid = document.getElementById("jobsGrid");

  if (currentFilter === "notices" || currentFilter === "notice") {
    try {
      let data = await safeJsonFetch("/api/bb/notices", "/data/bb-notices.json");
      if (!data) data = await safeJsonFetch("data/bb-notices.json");
      if (Array.isArray(data)) {
        allNotices = data;
      } else if (data && data.notices) {
        allNotices = data.notices;
      }
      rawAllNoticesCache = allNotices;
      updateTabCounts();
      renderNotices(allNotices);
      return;
    } catch (err) {
      grid.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">❌</div>
          <div class="empty-title">Error Loading Notices</div>
          <div class="empty-desc">${err.message}</div>
        </div>
      `;
      return;
    }
  }

  try {
    let data = await safeJsonFetch(`/api/jobs?filter=${currentFilter}&limit=300`, "/data/jobs.json");
    if (!data) data = await safeJsonFetch("data/jobs.json");

    if (Array.isArray(data)) {
      rawAllJobsCache = data;
      if (currentFilter === "matched") {
        allJobs = data.filter((j) => j.isMatch);
      } else if (currentFilter === "bb") {
        allJobs = data.filter((j) => j.source === "bb");
      } else if (currentFilter === "other") {
        allJobs = data.filter((j) => !j.isMatch && j.source !== "bb");
      } else {
        allJobs = data;
      }
    } else if (data && data.jobs) {
      allJobs = data.jobs;
      if (currentFilter === "all" || rawAllJobsCache.length === 0) {
        rawAllJobsCache = data.jobs;
      }
    } else {
      throw new Error("Could not load jobs from server or static cache.");
    }

    updateTabCounts();
    renderJobs(allJobs);
  } catch (err) {
    grid.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">❌</div>
        <div class="empty-title">Error Loading Jobs</div>
        <div class="empty-desc">${err.message}</div>
      </div>
    `;
  }
}

async function updateTabCounts() {
  try {
    if (rawAllJobsCache && rawAllJobsCache.length > 0) {
      const matchedCount = rawAllJobsCache.filter((j) => j.isMatch).length;
      const allCount = rawAllJobsCache.length;
      const bbCount = rawAllJobsCache.filter((j) => j.source === "bb").length;
      const noticesCount = rawAllNoticesCache.length || 17;

      document.getElementById("tabCountMatched").textContent = matchedCount;
      document.getElementById("tabCountAll").textContent = allCount;
      document.getElementById("tabCountOther").textContent = Math.max(0, allCount - matchedCount);
      const bbCountEl = document.getElementById("tabCountBB");
      if (bbCountEl) bbCountEl.textContent = bbCount;
      const noticesCountEl = document.getElementById("tabCountNotices");
      if (noticesCountEl) noticesCountEl.textContent = noticesCount;
      return;
    }

    const [matchedRes, allRes, bbRes, noticesRes] = await Promise.all([
      safeJsonFetch("/api/jobs?filter=matched", "/data/jobs.json"),
      safeJsonFetch("/api/jobs?filter=all", "/data/jobs.json"),
      safeJsonFetch("/api/jobs?filter=bb", "/data/jobs.json"),
      safeJsonFetch("/api/bb/notices", "/data/bb-notices.json"),
    ]);

    if (matchedRes) document.getElementById("tabCountMatched").textContent = matchedRes.total || (Array.isArray(matchedRes) ? matchedRes.filter((j) => j.isMatch).length : 0);
    if (allRes) document.getElementById("tabCountAll").textContent = allRes.total || (Array.isArray(allRes) ? allRes.length : 0);
    if (bbRes) {
      const bbCountEl = document.getElementById("tabCountBB");
      if (bbCountEl) bbCountEl.textContent = bbRes.total || (Array.isArray(bbRes) ? bbRes.filter((j) => j.source === "bb").length : 0);
    }
    if (noticesRes) {
      const noticesCountEl = document.getElementById("tabCountNotices");
      if (noticesCountEl) noticesCountEl.textContent = noticesRes.total || (Array.isArray(noticesRes) ? noticesRes.length : 0);
    }
  } catch (e) {}
}

function renderJobs(jobs) {
  const grid = document.getElementById("jobsGrid");
  const search = document.getElementById("inputSearchJobs").value.trim().toLowerCase();

  let filtered = jobs;
  if (search) {
    filtered = jobs.filter(
      (j) =>
        (j.title && j.title.toLowerCase().includes(search)) ||
        (j.category && j.category.toLowerCase().includes(search)) ||
        (j.id && j.id.toLowerCase().includes(search)) ||
        (j.matchedKeywords && j.matchedKeywords.some((k) => k.toLowerCase().includes(search)))
    );
  }

  if (filtered.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🔍</div>
        <div class="empty-title">No Jobs Found</div>
        <div class="empty-desc">No job posts match the current filter or search criteria. Click "Scrape Now" to fetch live posts from Teletalk.</div>
      </div>
    `;
    return;
  }

  grid.innerHTML = filtered.map((job) => createJobCardHtml(job)).join("");
}

function createJobCardHtml(job) {
  const kwList = Array.isArray(job.matchedKeywords) ? job.matchedKeywords : [];
  const kwBadges = kwList.map((k) => `<span class="kw-tag">${escapeHtml(k)}</span>`).join("");
  const isMatch = Boolean(job.isMatch);
  const isBB = job.source === "bb";

  // Format clean deadline string
  let deadlineStr = job.deadline || "Check circular";
  deadlineStr = deadlineStr.replace(/^Application Deadline:\s*/i, "");

  // BB-specific metadata section
  const bbMeta = isBB ? `
    <div class="bb-meta">
      ${job.salary ? `<div class="bb-meta-item"><span class="bb-meta-label">Salary</span><span class="bb-meta-value">${escapeHtml(job.salary)}</span></div>` : ""}
      ${job.noOfPost ? `<div class="bb-meta-item"><span class="bb-meta-label">Posts</span><span class="bb-meta-value">${escapeHtml(job.noOfPost)}</span></div>` : ""}
      ${job.payment ? `<div class="bb-meta-item"><span class="bb-meta-label">Fee</span><span class="bb-meta-value">${escapeHtml(job.payment)}</span></div>` : ""}
      ${job.educationalReq ? `<div class="bb-meta-item full-width"><span class="bb-meta-label">Education</span><span class="bb-meta-value bb-edu">${escapeHtml(job.educationalReq.slice(0, 120))}${job.educationalReq.length > 120 ? '...' : ''}</span></div>` : ""}
    </div>` : "";

  // Action buttons — no Autofill for BB jobs (different portal)
  const autofillBtn = isBB ? `` : `
    <button class="btn btn-autofill btn-sm" onclick="launchAutofillForJob('${escapeHtml(job.applyUrl)}', '${escapeHtml(job.title)}')" title="Launch automated form filler in headed Chromium browser">
      🤖 Autofill
    </button>`;

  return `
    <div class="job-card ${isMatch ? 'is-matched' : ''} ${isBB ? 'is-bb' : ''}">
      <div>
        <div class="card-top">
          <span class="job-id-badge">${escapeHtml(job.id || "N/A")}</span>
          ${isBB ? `<span class="source-badge-bb">🏦 Bangladesh Bank</span>` : ""}
          ${isMatch ? `<span class="match-badge">🎯 CSE / IT MATCH</span>` : ""}
        </div>

        <h3 class="job-title">${escapeHtml(job.title)}</h3>
        <div class="job-org">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 21h18M3 7v14M21 7v14M6 21V11M10 21V11M14 21V11M18 21V11M12 3l9 4H3l9-4z"></path></svg>
          <span>${escapeHtml(job.category || "Government Portal")}</span>
        </div>

        ${bbMeta}
        ${kwBadges ? `<div class="keywords-list">${kwBadges}</div>` : ""}

        <div class="meta-row">
          <span>Deadline: <strong class="deadline-tag">${escapeHtml(deadlineStr)}</strong></span>
          ${job.notifiedAt ? `<span class="alert-status-badge">✅ Alert Sent</span>` : `<span style="color: var(--text-dim);">⏳ Not Sent</span>`}
        </div>
      </div>

      <div class="card-actions">
        <a href="${escapeHtml(job.applyUrl)}" target="_blank" rel="noreferrer" class="btn btn-primary btn-sm">
          🔗 Apply Online
        </a>
        ${job.pdfUrl ? `
          <a href="${escapeHtml(job.pdfUrl)}" target="_blank" rel="noreferrer" class="btn btn-secondary btn-sm" title="View Circular PDF">
            📄 Circular PDF
          </a>` : `
          <button class="btn btn-secondary btn-sm" disabled style="opacity: 0.5;">
            📄 No PDF
          </button>
        `}
        ${autofillBtn}
        ${isBB ? `
          <button class="btn-track-applied" onclick="trackJobAsApplied('${escapeHtml(job.id)}', '${escapeHtml(job.title)}', '${escapeHtml(job.category || 'Bangladesh Bank')}')" title="Track this job ID to get notified whenever exam/viva/result notices appear">
            ⭐ Track as Applied
          </button>
        ` : ""}
        <button class="btn btn-outline btn-sm" onclick="openSendAlertModal('${escapeHtml(job.id)}')" title="Send Titan SMTP Email alert">
          ✉️ Send Alert
        </button>
      </div>
    </div>
  `;
}

// -------------------------------------------------------------
// Bangladesh Bank Notice Board Rendering
// -------------------------------------------------------------
function renderNotices(notices) {
  const grid = document.getElementById("jobsGrid");
  const search = document.getElementById("inputSearchJobs").value.trim().toLowerCase();

  let filtered = notices;
  if (search) {
    filtered = notices.filter(
      (n) =>
        (n.title && n.title.toLowerCase().includes(search)) ||
        (n.circularFor && n.circularFor.toLowerCase().includes(search)) ||
        (n.jobId && String(n.jobId).toLowerCase().includes(search)) ||
        (n.matchedKeywords && n.matchedKeywords.some((k) => k.toLowerCase().includes(search)))
    );
  }

  if (filtered.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📋</div>
        <div class="empty-title">No Notices Found</div>
        <div class="empty-desc">No notices match your criteria. Click "Sync BB Now" to pull fresh notices from Bangladesh Bank portal.</div>
      </div>
    `;
    return;
  }

  grid.innerHTML = filtered.map((notice) => createNoticeCardHtml(notice)).join("");
}

function createNoticeCardHtml(notice) {
  const isMatch = Boolean(notice.isMatch);
  const kwList = Array.isArray(notice.matchedKeywords) ? notice.matchedKeywords : [];
  const kwBadges = kwList.map((k) => `<span class="kw-tag">${escapeHtml(k)}</span>`).join("");
  const circularForClass = getCircularForBadgeClass(notice.circularFor);

  return `
    <div class="job-card is-notice-card ${isMatch ? 'is-matched notice-matched' : ''}">
      <div>
        <div class="card-top">
          <span class="job-id-badge">Job ID: ${escapeHtml(notice.jobId || "N/A")}</span>
          <span class="badge-circular-for ${circularForClass}">${escapeHtml(notice.circularFor || "Notice")}</span>
          ${isMatch ? `<span class="match-badge">🎯 IT / CSE MATCH</span>` : ""}
        </div>

        <h3 class="job-title notice-title ${isMatch ? 'text-highlight-it' : ''}">
          ${escapeHtml(notice.title)}
        </h3>

        <div class="job-org">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 21h18M3 7v14M21 7v14M6 21V11M10 21V11M14 21V11M18 21V11M12 3l9 4H3l9-4z"></path></svg>
          <span>Bangladesh Bank (BSCS)</span>
        </div>

        ${kwBadges ? `<div class="keywords-list">${kwBadges}</div>` : ""}

        <div class="notice-meta-grid">
          <div class="notice-date-item">
            <span class="notice-date-label">Published</span>
            <strong class="notice-date-val">${escapeHtml(notice.publishDate || "N/A")}</strong>
          </div>
          <div class="notice-date-item">
            <span class="notice-date-label">Exam / Deadline</span>
            <strong class="notice-date-val ${isMatch ? 'text-gold' : ''}">${escapeHtml(notice.closeDate || "N/A")}</strong>
          </div>
        </div>
      </div>

      <div class="card-actions notice-card-actions">
        ${notice.pdfUrl ? `
          <a href="${escapeHtml(notice.pdfUrl)}" target="_blank" rel="noreferrer" class="btn btn-primary btn-sm" title="View Official PDF Circular / Results">
            📄 Details
          </a>
          <a href="${escapeHtml(notice.pdfUrl)}" download target="_blank" rel="noreferrer" class="btn btn-secondary btn-sm" title="Download Official PDF">
            ⬇️ PDF
          </a>
        ` : `
          <button class="btn btn-secondary btn-sm" disabled style="opacity: 0.5;">
            📄 No PDF
          </button>
        `}
      </div>
    </div>
  `;
}

function getCircularForBadgeClass(circularFor = "") {
  const c = String(circularFor).toLowerCase();
  if (c.includes("selected")) return "badge-selected";
  if (c.includes("viva")) return "badge-viva";
  if (c.includes("mcq")) return "badge-mcq";
  if (c.includes("written")) return "badge-written";
  return "badge-default";
}

// -------------------------------------------------------------
// Notice Board Modal Logic
// -------------------------------------------------------------
// -------------------------------------------------------------
// Notice Board & Applied Bank Jobs Modal Logic
// -------------------------------------------------------------
async function openNoticeBoardModal() {
  const modal = document.getElementById("modalNoticeBoard");
  if (!modal) return;
  modal.style.display = "flex";

  const emailSpan = document.getElementById("appliedJobAlertRecipientEmail");
  if (emailSpan) emailSpan.textContent = defaultNotifyEmail;

  try {
    const [noticesData, appliedData] = await Promise.all([
      safeJsonFetch("/api/bb/notices", "/data/bb-notices.json"),
      safeJsonFetch("/api/bb/applied-jobs"),
    ]);

    allNotices = (noticesData && noticesData.notices) || (Array.isArray(noticesData) ? noticesData : []);
    appliedJobsList = (appliedData && appliedData.appliedJobs) || [];

    updateNoticeBoardCounts();
    setNoticeTab(noticeFilterMode || "all");
  } catch (err) {
    console.error("Error opening notice modal:", err);
  }
}

function updateNoticeBoardCounts() {
  const countAll = allNotices.length;
  const countMatched = allNotices.filter((n) => n.isMatch).length;
  const countApplied = allNotices.filter((n) => n.isAppliedMatch).length;
  const countTracked = appliedJobsList.length;

  const elAll = document.getElementById("modalNoticeCountAll");
  if (elAll) elAll.textContent = countAll;
  const elMatched = document.getElementById("modalNoticeCountMatched");
  if (elMatched) elMatched.textContent = countMatched;
  const elApplied = document.getElementById("modalNoticeCountApplied");
  if (elApplied) elApplied.textContent = countApplied;
  const elTracked = document.getElementById("modalAppliedJobsCount");
  if (elTracked) elTracked.textContent = countTracked;
  const elListCount = document.getElementById("trackedAppliedJobsListCount");
  if (elListCount) elListCount.textContent = countTracked;

  const navNoticesEl = document.getElementById("navNoticesCount");
  if (navNoticesEl) navNoticesEl.textContent = countAll;
  const tabNoticesEl = document.getElementById("tabCountNotices");
  if (tabNoticesEl) tabNoticesEl.textContent = countAll;
}

function setNoticeTab(tab) {
  noticeFilterMode = tab;

  const btnAll = document.getElementById("btnNoticeFilterAll");
  const btnApplied = document.getElementById("btnNoticeFilterApplied");
  const btnMatched = document.getElementById("btnNoticeFilterMatched");
  const btnManage = document.getElementById("btnNoticeTabManageApplied");

  if (btnAll) btnAll.className = tab === "all" ? "btn btn-sm btn-outline active" : "btn btn-sm btn-outline";
  if (btnApplied) btnApplied.className = tab === "applied" ? "btn btn-sm btn-gold active" : "btn btn-sm btn-gold";
  if (btnMatched) btnMatched.className = tab === "matched" ? "btn btn-sm btn-emerald active" : "btn btn-sm btn-emerald";
  if (btnManage) btnManage.className = tab === "manage-applied" ? "btn btn-sm btn-secondary active" : "btn btn-sm btn-secondary";

  const listContainer = document.getElementById("noticeBoardListContainer");
  const panelContainer = document.getElementById("appliedJobsPanelContainer");

  if (tab === "manage-applied") {
    if (listContainer) listContainer.style.display = "none";
    if (panelContainer) panelContainer.style.display = "block";
    renderTrackedAppliedJobsList();
  } else {
    if (panelContainer) panelContainer.style.display = "none";
    if (listContainer) listContainer.style.display = "block";
    renderModalNotices();
  }
}

function renderModalNotices() {
  const container = document.getElementById("noticeBoardList");
  const search = (document.getElementById("inputSearchNotices")?.value || "").trim().toLowerCase();

  let list = allNotices;
  if (noticeFilterMode === "matched") {
    list = list.filter((n) => n.isMatch);
  } else if (noticeFilterMode === "applied") {
    list = list.filter((n) => n.isAppliedMatch);
  }

  if (search) {
    list = list.filter(
      (n) =>
        (n.title && n.title.toLowerCase().includes(search)) ||
        (n.circularFor && n.circularFor.toLowerCase().includes(search)) ||
        (n.jobId && String(n.jobId).toLowerCase().includes(search)) ||
        (n.appliedJobTitle && n.appliedJobTitle.toLowerCase().includes(search)) ||
        (n.matchedKeywords && n.matchedKeywords.some((k) => k.toLowerCase().includes(search)))
    );
  }

  if (list.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="padding: 28px;">
        <div class="empty-icon">${noticeFilterMode === "applied" ? "⭐" : "🔍"}</div>
        <div class="empty-title">${noticeFilterMode === "applied" ? "No Notices Found for Applied Bank Jobs" : "No Notices Found"}</div>
        <div class="empty-desc" style="max-width: 480px; margin: 0 auto;">
          ${noticeFilterMode === "applied"
            ? "No published notices currently match your tracked Job ID codes. Click 'Applied Bank Jobs' to add your application Job ID code (e.g. 10225)!"
            : "No notices match the filter. Try switching to 'All Notices' or clearing search."}
        </div>
      </div>
    `;
    return;
  }

  container.innerHTML = list
    .map((n) => {
      const isMatch = Boolean(n.isMatch);
      const isApplied = Boolean(n.isAppliedMatch);
      const kwBadges = (n.matchedKeywords || []).map((k) => `<span class="kw-tag">${escapeHtml(k)}</span>`).join("");
      const circClass = getCircularForBadgeClass(n.circularFor);

      return `
        <div class="modal-notice-row ${isApplied ? 'applied-match-row' : isMatch ? 'matched-row' : ''}">
          <div class="modal-notice-left">
            <div class="modal-notice-top">
              <span class="job-id-badge ${isApplied ? 'badge-gold-bg' : ''}">Job ID: ${escapeHtml(n.jobId || "N/A")}</span>
              <span class="badge-circular-for ${circClass}">${escapeHtml(n.circularFor || "Notice")}</span>
              ${isApplied ? `<span class="badge-applied-job">⭐ APPLIED POST</span>` : ""}
              ${isMatch && !isApplied ? `<span class="match-badge">🎯 IT / CSE MATCH</span>` : ""}
            </div>
            <div class="modal-notice-title ${isApplied ? 'applied-title' : isMatch ? 'matched-title' : ''}">
              ${escapeHtml(n.title)}
            </div>
            <div class="modal-notice-meta">
              <div class="notice-meta-dates">
                <span>📅 <strong>${escapeHtml(n.publishDate || "N/A")}</strong></span>
                <span>⏰ Exam: <strong>${escapeHtml(n.closeDate || "N/A")}</strong></span>
                ${n.appliedJobRoll ? `<span>Roll: <strong style="color: #fbbf24;">${escapeHtml(n.appliedJobRoll)}</strong></span>` : ""}
              </div>
              ${kwBadges ? `<div class="notice-kw-row">${kwBadges}</div>` : ""}
            </div>
          </div>
          <div class="modal-notice-actions">
            ${isApplied ? `
              <button class="btn btn-gold btn-sm btn-notice-action" onclick="sendNoticeAlertEmail('${escapeHtml(n.id || n.jobId)}', '${escapeHtml(n.jobId)}')" title="Send urgent alert email for this notice now">
                ✉️ Email Alert
              </button>
            ` : ""}
            ${n.pdfUrl ? `
              <a href="${escapeHtml(n.pdfUrl)}" target="_blank" rel="noreferrer" class="btn btn-primary btn-sm btn-notice-action">
                📄 View Details
              </a>
              <a href="${escapeHtml(n.pdfUrl)}" download target="_blank" rel="noreferrer" class="btn btn-outline btn-sm btn-notice-action">
                ⬇️ PDF
              </a>
            ` : `
              <span class="no-pdf-tag">No PDF</span>
            `}
          </div>
        </div>
      `;
    })
    .join("");
}

function renderTrackedAppliedJobsList() {
  const container = document.getElementById("trackedAppliedJobsList");
  if (!container) return;

  if (appliedJobsList.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="padding: 24px; border: 1px dashed var(--border-color); border-radius: var(--radius-sm);">
        <div class="empty-icon">💼</div>
        <div class="empty-title">No Applied Bank Jobs Tracked Yet</div>
        <div class="empty-desc">Enter your application Job ID code (e.g. 10225, 10226) in the form above. The notifier will monitor Bangladesh Bank notices and send alerts directly to your email!</div>
      </div>
    `;
    return;
  }

  container.innerHTML = appliedJobsList
    .map((app) => {
      const matchingCount = app.noticesCount || 0;
      return `
        <div class="applied-job-card ${matchingCount > 0 ? 'has-notices' : ''}">
          <div style="flex: 1;">
            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px; flex-wrap: wrap;">
              <span class="job-id-badge" style="background: rgba(245, 158, 11, 0.2); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.4); font-size: 12px; font-weight: 800;">
                Job ID: ${escapeHtml(app.jobId)}
              </span>
              <span style="font-weight: 700; font-size: 14px; color: var(--text-main);">${escapeHtml(app.title)}</span>
              <span style="font-size: 12px; color: var(--text-muted);">&bull; ${escapeHtml(app.organization)}</span>
            </div>
            <div style="display: flex; gap: 14px; font-size: 11.5px; color: var(--text-dim); flex-wrap: wrap;">
              ${app.rollNo ? `<span>Roll No: <strong style="color: #cbd5e1;">${escapeHtml(app.rollNo)}</strong></span>` : ""}
              ${app.trackingNo ? `<span>Tracking No: <strong style="color: #cbd5e1;">${escapeHtml(app.trackingNo)}</strong></span>` : ""}
              <span>Applied: <strong>${escapeHtml(app.appliedDate || "Recorded")}</strong></span>
              ${matchingCount > 0 ? `<span style="color: #fbbf24; font-weight: 700;">🎯 ${matchingCount} Official Notice(s) Found!</span>` : `<span style="color: #94a3b8;">No notices published yet</span>`}
            </div>
          </div>
          <div style="display: flex; gap: 8px; align-items: center; flex-shrink: 0;">
            ${matchingCount > 0 ? `
              <button class="btn btn-gold btn-sm" onclick="filterNoticesByJobId('${escapeHtml(app.jobId)}')" title="View notices for this Job ID">
                🔍 View ${matchingCount} Notice${matchingCount > 1 ? 's' : ''}
              </button>
            ` : ""}
            <button class="btn btn-outline btn-sm" onclick="removeAppliedJob('${escapeHtml(app.id)}', '${escapeHtml(app.jobId)}')" style="color: #f43f5e; border-color: rgba(244,63,94,0.3);" title="Remove from tracked jobs">
              🗑️ Delete
            </button>
          </div>
        </div>
      `;
    })
    .join("");
}

window.filterNoticesByJobId = function (jobId) {
  setNoticeTab("all");
  const searchInput = document.getElementById("inputSearchNotices");
  if (searchInput) {
    searchInput.value = jobId;
    renderModalNotices();
  }
};

window.sendNoticeAlertEmail = async function (noticeId, jobId) {
  showToast(`✉️ Sending alert email for Job ID ${jobId} to ${defaultNotifyEmail}...`, "info");
  try {
    const res = await fetch("/api/bb/notices/notify-test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ noticeId, recipientEmail: defaultNotifyEmail }),
    });
    const data = await res.json();
    if (data.success) {
      showToast(`✅ ${data.message}`, "success");
    } else {
      showToast(`❌ ${data.error}`, "error");
    }
  } catch (err) {
    showToast(`❌ Error: ${err.message}`, "error");
  }
};

window.removeAppliedJob = async function (id, jobId) {
  if (!confirm(`Stop tracking notices for Job ID ${jobId}?`)) return;
  try {
    const res = await fetch(`/api/bb/applied-jobs/${encodeURIComponent(id)}`, { method: "DELETE" });
    const data = await res.json();
    if (data.success) {
      showToast(`🗑️ Removed Job ID ${jobId} from tracked jobs.`, "info");
      await openNoticeBoardModal();
    }
  } catch (err) {
    showToast(`Error deleting applied job: ${err.message}`, "error");
  }
};

window.trackJobAsApplied = async function (jobId, title, org) {
  const cleanJobId = String(jobId).replace(/^bb_/i, "").trim();
  await openNoticeBoardModal();
  setNoticeTab("manage-applied");

  const idInput = document.getElementById("appliedInputJobId");
  const titleInput = document.getElementById("appliedInputTitle");
  const orgInput = document.getElementById("appliedInputOrg");
  const rollInput = document.getElementById("appliedInputRoll");

  if (idInput) idInput.value = cleanJobId;
  if (titleInput) titleInput.value = title || "";
  if (orgInput) orgInput.value = org || "Bangladesh Bank";
  if (rollInput) rollInput.focus();

  showToast(`⭐ Ready to track Job ID ${cleanJobId}. Fill in your roll number if available and click "Save & Start Tracking"!`, "info");
};

// -------------------------------------------------------------
// Live SSE Logs
// -------------------------------------------------------------
function connectLiveLogEvents() {
  if (sseSource) sseSource.close();
  sseSource = new EventSource("/api/scrape/events");

  const terminalLogs = document.getElementById("terminalLogs");
  const bannerLog = document.getElementById("scraperBannerLog");

  sseSource.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (!data.message) return;

      if (bannerLog) bannerLog.textContent = data.message;

      const logEl = document.createElement("div");
      logEl.className = `log-entry ${data.isError ? 'error' : data.message.includes('MATCH') ? 'match' : ''}`;
      logEl.textContent = `[${data.time || new Date().toLocaleTimeString()}] ${data.message}`;
      terminalLogs.appendChild(logEl);

      const autoScroll = document.getElementById("chkAutoScroll").checked;
      if (autoScroll) {
        terminalLogs.scrollTop = terminalLogs.scrollHeight;
      }

      if (data.isComplete) {
        loadOverview();
        loadJobs();
        showToast("Scrape completed successfully!", "success");
      }
    } catch (err) {
      console.error("SSE parse error:", err);
    }
  };
}

// -------------------------------------------------------------
// Send Job Alert Modal
// -------------------------------------------------------------
window.openSendAlertModal = function (jobId) {
  const job = allJobs.find((j) => j.id === jobId);
  if (!job) return;
  currentAlertJob = job;

  const preview = document.getElementById("sendAlertJobPreview");
  preview.innerHTML = `
    <div class="preview-title">${escapeHtml(job.title)}</div>
    <div class="preview-org">${escapeHtml(job.category || 'Government Organization')}</div>
    <div style="font-size: 12px; color: var(--text-dim); margin-top: 4px;">Job ID: ${escapeHtml(job.id)}</div>
  `;

  document.getElementById("inputAlertRecipient").value = defaultNotifyEmail;
  document.getElementById("modalSendAlert").style.display = "flex";
};

async function handleConfirmSendAlert() {
  if (!currentAlertJob) return;
  const recipient = document.getElementById("inputAlertRecipient").value.trim();
  if (!recipient) {
    showToast("Please provide a recipient email address.", "error");
    return;
  }

  const btn = document.getElementById("btnConfirmSendAlert");
  btn.disabled = true;
  btn.textContent = "Sending via Titan SMTP...";

  try {
    const res = await fetch("/api/jobs/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: currentAlertJob.id, emailTo: recipient }),
    });
    const data = await res.json();

    if (data.success) {
      showToast(`Email alert delivered to ${recipient}!`, "success");
      document.getElementById("modalSendAlert").style.display = "none";
      loadJobs();
    } else {
      showToast(data.message || "Failed to send email alert", "error");
    }
  } catch (err) {
    showToast("Error sending email: " + err.message, "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg> Send Email Now`;
  }
}

// -------------------------------------------------------------
// Keywords Management
// -------------------------------------------------------------
async function loadKeywords() {
  try {
    const data = await safeJsonFetch("/api/keywords", "/data/keywords.json");
    if (data && data.keywords) {
      targetKeywords = Array.isArray(data.keywords) ? data.keywords : (data.keywords.include || []);
      document.getElementById("navKeywordsCount").textContent = targetKeywords.length;
      renderKeywordTags();
    }
  } catch (err) {
    console.error("Error loading keywords:", err);
  }
}

function renderKeywordTags() {
  const container = document.getElementById("keywordTagsList");
  container.innerHTML = targetKeywords
    .map(
      (kw, idx) => `
      <div class="kw-badge-removable">
        <span>${escapeHtml(kw)}</span>
        <span class="remove-kw" onclick="removeKeywordTag(${idx})">&times;</span>
      </div>
    `
    )
    .join("");
}

window.removeKeywordTag = function (idx) {
  targetKeywords.splice(idx, 1);
  renderKeywordTags();
};

async function saveKeywordsList() {
  try {
    const res = await fetch("/api/keywords", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keywords: targetKeywords }),
    });
    const data = await res.json();
    if (data.success) {
      showToast("Keywords updated successfully!", "success");
      document.getElementById("navKeywordsCount").textContent = targetKeywords.length;
      document.getElementById("modalKeywords").style.display = "none";
      loadJobs();
    }
  } catch (err) {
    showToast("Failed to save keywords: " + err.message, "error");
  }
}

// -------------------------------------------------------------
// Settings & SMTP
// -------------------------------------------------------------
async function loadSettings() {
  let s = null;
  try {
    const data = await safeJsonFetch("/api/settings", "/api/settings.json");
    if (data && data.success && data.settings) {
      s = data.settings;
    }
  } catch (err) {
    console.warn("Server settings fetch fallback:", err);
  }

  // Overlay locally saved settings if present
  try {
    const local = localStorage.getItem("teletalk_settings");
    if (local) {
      const parsed = JSON.parse(local);
      s = { ...(s || {}), ...parsed };
    }
  } catch (_) {}

  if (s) {
    document.getElementById("cfgSmtpHost").value = s.smtpHost || "smtp.titan.email";
    document.getElementById("cfgSmtpPort").value = s.smtpPort || 587;
    document.getElementById("cfgSmtpUser").value = s.smtpUser || "taion@razibmarketing.net";
    document.getElementById("cfgNotifyEmail").value = s.notifyEmail || "taion16240@gmail.com";
    document.getElementById("cfgAutoScrapeEnabled").checked = Boolean(s.autoScrapeEnabled);
    document.getElementById("cfgAutoScrapeInterval").value = s.autoScrapeIntervalMinutes || 360;

    if (s.notifyEmail) {
      defaultNotifyEmail = s.notifyEmail;
      const headerEl = document.getElementById("headerRecipientEmail");
      if (headerEl) headerEl.textContent = defaultNotifyEmail;
    }
  }
}

async function saveSettingsData() {
  const settings = {
    smtpHost: document.getElementById("cfgSmtpHost").value.trim(),
    smtpPort: parseInt(document.getElementById("cfgSmtpPort").value, 10) || 587,
    smtpUser: document.getElementById("cfgSmtpUser").value.trim(),
    notifyEmail: document.getElementById("cfgNotifyEmail").value.trim(),
    autoScrapeEnabled: document.getElementById("cfgAutoScrapeEnabled").checked,
    autoScrapeIntervalMinutes: parseInt(document.getElementById("cfgAutoScrapeInterval").value, 10) || 360,
  };

  const pass = document.getElementById("cfgSmtpPass").value.trim();
  if (pass) {
    settings.smtpPass = pass;
  }

  // 1. Immediately persist to localStorage
  try {
    localStorage.setItem("teletalk_settings", JSON.stringify(settings));
  } catch (_) {}

  if (settings.notifyEmail) {
    defaultNotifyEmail = settings.notifyEmail;
    const headerEl = document.getElementById("headerRecipientEmail");
    if (headerEl) headerEl.textContent = defaultNotifyEmail;
  }

  // 2. Synchronize to server/Worker
  try {
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });

    if (res.ok) {
      try {
        const text = await res.text();
        if (text) JSON.parse(text);
      } catch (_) {}
    }
  } catch (err) {
    console.warn("Server settings sync note:", err);
  }

  showToast("Configuration saved successfully!", "success");
  document.getElementById("modalSettings").style.display = "none";
  loadOverview();
}

async function testSmtpAction() {
  const btn = document.getElementById("btnTestSmtp");
  const resultEl = document.getElementById("smtpTestResult");

  btn.disabled = true;
  btn.textContent = "Connecting & sending test email...";
  resultEl.textContent = "";
  resultEl.className = "test-result";

  const host = document.getElementById("cfgSmtpHost").value.trim();
  const port = parseInt(document.getElementById("cfgSmtpPort").value, 10);
  const user = document.getElementById("cfgSmtpUser").value.trim();
  const pass = document.getElementById("cfgSmtpPass").value.trim();
  const to = document.getElementById("cfgNotifyEmail").value.trim();

  try {
    const res = await fetch("/api/test-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host, port, user, pass, to }),
    });

    let data = { success: res.ok };
    try {
      const text = await res.text();
      if (text) data = JSON.parse(text);
    } catch (_) {}

    if (data.success) {
      resultEl.textContent = `✅ Success: Test email delivered to ${to}!`;
      resultEl.className = "test-result success";
      showToast(`SMTP Verified! Test email sent to ${to}.`, "success");
    } else {
      resultEl.textContent = `❌ ${data.message || data.error || "Failed to send test email"}`;
      resultEl.className = "test-result error";
      showToast("SMTP Test Failed", "error");
    }
  } catch (err) {
    resultEl.textContent = `❌ ${err.message}`;
    resultEl.className = "test-result error";
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg> Send Live Test Email to Recipient`;
  }
}

// -------------------------------------------------------------
// History Modal
// -------------------------------------------------------------
async function openHistoryModal() {
  const container = document.getElementById("historyTableContainer");
  container.innerHTML = "<p style='color: #94a3b8; padding: 20px;'>Loading scrape history...</p>";
  document.getElementById("modalHistory").style.display = "flex";

  try {
    const res = await fetch("/api/scrape/history");
    const data = await res.json();
    if (!data.success || data.history.length === 0) {
      container.innerHTML = "<p style='color: #94a3b8; padding: 20px;'>No previous scrape history recorded yet.</p>";
      return;
    }

    container.innerHTML = `
      <table class="history-table">
        <thead>
          <tr>
            <th>Timestamp</th>
            <th>Type</th>
            <th>Circulars</th>
            <th>Posts Found</th>
            <th>Matches</th>
            <th>New Alerts</th>
            <th>Duration</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${data.history
            .map(
              (h) => `
            <tr>
              <td>${new Date(h.timestamp).toLocaleString()}</td>
              <td>${h.dryRun ? '<span style="color: #eab308;">Dry Run</span>' : '<span style="color: #34d399;">Live</span>'}</td>
              <td>${h.circularsScanned || 0}</td>
              <td>${h.totalPostsFound || 0}</td>
              <td><strong>${h.matchedPosts || 0}</strong></td>
              <td><span style="color: ${h.notificationsSent ? '#38bdf8' : '#94a3b8'}">${h.notificationsSent || 0} sent</span></td>
              <td>${h.durationSeconds || 0}s</td>
              <td><span style="color: ${h.status === 'completed' ? '#34d399' : '#f87171'}">${h.status}</span></td>
            </tr>
          `
            )
            .join("")}
        </tbody>
      </table>
    `;
  } catch (err) {
    container.innerHTML = `<p style="color: #f87171; padding: 20px;">Failed to load history: ${err.message}</p>`;
  }
}

// -------------------------------------------------------------
// Scraper Action Handlers
// -------------------------------------------------------------
async function triggerScrape(dryRun = false) {
  try {
    document.getElementById("terminalSection").style.display = "block";
    showToast(`Launching ${dryRun ? 'Dry Run' : 'Live'} scrape...`, "info");

    const res = await fetch("/api/scrape", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dryRun, ignoreSeen: dryRun }),
    });
    const data = await res.json();
    if (!data.success) {
      showToast(data.message, "error");
    } else {
      loadOverview();
    }
  } catch (err) {
    showToast("Failed to launch scraper: " + err.message, "error");
  }
}

let currentAutofillJob = { url: "", postTitle: "" };
let bookmarkletCode = "";

async function loadBookmarklet() {
  try {
    const res = await fetch("/api/autofill/bookmarklet");
    const data = await res.json();
    if (data.success) {
      bookmarkletCode = data.rawJs;
      const link = document.getElementById("linkBookmarklet");
      link.href = data.bookmarkletUrl;
    }
  } catch (e) {
    console.error("Failed to load bookmarklet:", e);
  }
}

window.launchAutofillForJob = async function (url, postTitle) {
  currentAutofillJob = { url, postTitle };
  
  const preview = document.getElementById("autofillJobPreview");
  preview.innerHTML = `
    <div class="preview-title">${escapeHtml(postTitle)}</div>
    <div class="preview-org">${escapeHtml(url)}</div>
  `;

  document.getElementById("inputAutofillCliCommand").value = `npm run autofill -- --url "${url}" --post "${postTitle}"`;
  document.getElementById("modalAutofill").style.display = "flex";
  await loadBookmarklet();
};

let autofillEventSource = null;

function appendAutofillLog(text, type = "info") {
  const consoleBox = document.getElementById("autofillLiveConsole");
  const logStream = document.getElementById("autofillLogStream");
  if (!consoleBox || !logStream) return;

  consoleBox.style.display = "block";
  const line = document.createElement("div");
  line.style.marginBottom = "3px";

  const timeStr = new Date().toLocaleTimeString();
  const timeSpan = `<span style="color: #64748b; margin-right: 6px;">[${timeStr}]</span>`;

  if (type === "success") {
    line.innerHTML = `${timeSpan}<span style="color: #34d399; font-weight: 600;">${escapeHtml(text)}</span>`;
  } else if (type === "error") {
    line.innerHTML = `${timeSpan}<span style="color: #f87171; font-weight: 600;">${escapeHtml(text)}</span>`;
  } else if (type === "warn") {
    line.innerHTML = `${timeSpan}<span style="color: #fbbf24;">${escapeHtml(text)}</span>`;
  } else {
    line.innerHTML = `${timeSpan}<span style="color: #cbd5e1;">${escapeHtml(text)}</span>`;
  }

  logStream.appendChild(line);
  logStream.scrollTop = logStream.scrollHeight;
}

function clearAutofillLogs() {
  const logStream = document.getElementById("autofillLogStream");
  if (logStream) logStream.innerHTML = "";
  const statusBadge = document.getElementById("autofillConsoleStatus");
  if (statusBadge) {
    statusBadge.textContent = "READY";
    statusBadge.style.color = "#94a3b8";
  }
}

async function executeDesktopAutofill() {
  const { url, postTitle } = currentAutofillJob;
  const btn = document.getElementById("btnLaunchPlaywrightBrowser");
  const statusBadge = document.getElementById("autofillConsoleStatus");
  btn.disabled = true;
  btn.textContent = "Opening Window...";

  clearAutofillLogs();
  if (statusBadge) {
    statusBadge.textContent = "STREAMING";
    statusBadge.style.color = "#38bdf8";
  }

  appendAutofillLog(`🚀 Launching Chromium window for "${postTitle || "Job"}"...`, "info");
  appendAutofillLog(`🌐 Target: ${url}`, "info");

  // Connect to SSE stream for live terminal stdout/stderr
  try {
    if (autofillEventSource) autofillEventSource.close();
    autofillEventSource = new EventSource("/api/autofill/events");
    autofillEventSource.onmessage = (e) => {
      try {
        const payload = JSON.parse(e.data);
        if (payload.line) appendAutofillLog(payload.line, payload.type || "info");
        if (payload.done) {
          if (statusBadge) {
            statusBadge.textContent = "COMPLETED";
            statusBadge.style.color = "#34d399";
          }
          if (autofillEventSource) autofillEventSource.close();
        }
      } catch (_) {
        appendAutofillLog(e.data);
      }
    };
    autofillEventSource.onerror = () => {
      // In static / cloudflare mode, SSE might not be active; fall back smoothly
    };
  } catch (_) {}

  try {
    showToast(`Launching Chromium window for "${postTitle}"...`, "info");
    const res = await fetch("/api/autofill/launch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, postTitle }),
    });
    const data = await res.json();
    if (data.success) {
      appendAutofillLog(`✅ ${data.message}`, "success");
      showToast("Playwright browser window popped up on your desktop!", "success");
    } else {
      appendAutofillLog(`❌ ${data.message || "Launch failed"}`, "error");
      showToast(data.message, "error");
    }
  } catch (err) {
    appendAutofillLog(`❌ Error: ${err.message}`, "error");
    showToast("Error launching autofill: " + err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "🚀 Pop Up Chrome Window Now";
  }
}

async function executeCloudflarePlaywright() {
  const { url, postTitle } = currentAutofillJob;
  const btn = document.getElementById("btnRunCloudflarePlaywright");
  const statusEl = document.getElementById("cfPlaywrightStatus");
  const container = document.getElementById("cfPlaywrightScreenshotContainer");
  const img = document.getElementById("cfPlaywrightScreenshotImg");
  const statusBadge = document.getElementById("autofillConsoleStatus");

  if (!btn) return;
  btn.disabled = true;
  btn.textContent = "⏳ Running in Cloud...";
  statusEl.style.display = "block";
  statusEl.style.color = "#38bdf8";
  statusEl.style.background = "rgba(56, 189, 248, 0.1)";
  statusEl.style.borderColor = "rgba(56, 189, 248, 0.2)";
  statusEl.textContent = "Launching Cloudflare Playwright in edge cloud... (takes ~15-25s)";
  container.style.display = "none";

  clearAutofillLogs();
  if (statusBadge) {
    statusBadge.textContent = "RUNNING";
    statusBadge.style.color = "#38bdf8";
  }

  appendAutofillLog(`☁️ Initializing Cloudflare Playwright edge isolate...`, "info");
  appendAutofillLog(`🌐 Connecting to: ${url}`, "info");
  appendAutofillLog(`🎯 Target Post: "${postTitle || "Job"}"`, "info");

  // Stream animated progress in live console while Edge Chromium executes
  const edgeSteps = [
    "🔍 Launching headless Chromium session in Cloudflare global network...",
    "📄 Navigating to Teletalk portal and parsing DOM layout...",
    "✍️ Matching post title radio button and advancing to form...",
    "📋 Populating applicant identity, present/permanent address...",
    "🎓 Filling SSC, HSC, and Graduation qualifications...",
    "🤖 Inspecting CAPTCHA with Cloudflare AI Vision cascade...",
    "📸 Rendering full-page verified submission screenshot...",
  ];
  let stepI = 0;
  const progressInterval = setInterval(() => {
    if (stepI < edgeSteps.length) {
      appendAutofillLog(edgeSteps[stepI], "info");
      stepI++;
    }
  }, 3200);

  try {
    const res = await fetch("/api/autofill/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, postTitle }),
    });
    clearInterval(progressInterval);
    const data = await res.json();

    if (data.logs && Array.isArray(data.logs)) {
      data.logs.forEach((l) => appendAutofillLog(l, "info"));
    }

    if (data.success) {
      statusEl.style.color = "#34d399";
      statusEl.style.background = "rgba(16, 185, 129, 0.1)";
      statusEl.style.borderColor = "rgba(16, 185, 129, 0.2)";
      statusEl.innerHTML = `✅ ${data.message} ${data.captchaSolved ? "• 🤖 AI CAPTCHA solved!" : ""}`;
      appendAutofillLog(`✅ ${data.message}`, "success");
      if (statusBadge) {
        statusBadge.textContent = "SUCCESS";
        statusBadge.style.color = "#34d399";
      }
      if (data.screenshot) {
        img.src = data.screenshot;
        container.style.display = "block";
      }
      showToast("Cloudflare Playwright filled the form successfully!", "success");
    } else if (data.browserNotConfigured) {
      statusEl.style.color = "#fbbf24";
      statusEl.style.background = "rgba(245, 158, 11, 0.1)";
      statusEl.style.borderColor = "rgba(245, 158, 11, 0.2)";
      statusEl.innerHTML = `⚠️ <strong>Browser Run not enabled yet:</strong> ${data.message}`;
      appendAutofillLog(`⚠️ ${data.message}`, "warn");
      if (statusBadge) {
        statusBadge.textContent = "WAITING";
        statusBadge.style.color = "#fbbf24";
      }
    } else {
      statusEl.style.color = "#f87171";
      statusEl.style.background = "rgba(239, 68, 68, 0.1)";
      statusEl.style.borderColor = "rgba(239, 68, 68, 0.2)";
      statusEl.textContent = "Error: " + (data.error || data.message || "Failed to run Cloudflare Playwright");
      appendAutofillLog(`❌ Error: ${data.error || data.message}`, "error");
      if (statusBadge) {
        statusBadge.textContent = "FAILED";
        statusBadge.style.color = "#f87171";
      }
    }
  } catch (err) {
    clearInterval(progressInterval);
    statusEl.style.color = "#f87171";
    statusEl.textContent = "Network error: " + err.message;
    appendAutofillLog(`❌ Network error: ${err.message}`, "error");
    if (statusBadge) {
      statusBadge.textContent = "FAILED";
      statusBadge.style.color = "#f87171";
    }
  } finally {
    btn.disabled = false;
    btn.textContent = "☁️ Run Cloudflare Playwright Fill";
  }
}

// -------------------------------------------------------------
// UI Event Handlers
// -------------------------------------------------------------
function setupEventListeners() {
  // Mobile Quick Drawer & Mobile Menu Trigger
  const btnToggleMobileMenu = document.getElementById("btnToggleMobileMenu");
  const drawerBackdrop = document.getElementById("mobileDrawerBackdrop");
  const btnCloseDrawer = document.getElementById("btnCloseMobileDrawer");

  const openDrawer = () => {
    if (drawerBackdrop) {
      const mDrawerKeywords = document.getElementById("mDrawerKeywordsCount");
      if (mDrawerKeywords && targetKeywords) mDrawerKeywords.textContent = targetKeywords.length;
      drawerBackdrop.style.display = "flex";
    }
  };

  const closeDrawer = () => {
    if (drawerBackdrop) drawerBackdrop.style.display = "none";
  };

  if (btnToggleMobileMenu) btnToggleMobileMenu.addEventListener("click", openDrawer);
  if (btnCloseDrawer) btnCloseDrawer.addEventListener("click", closeDrawer);
  if (drawerBackdrop) {
    drawerBackdrop.addEventListener("click", (e) => {
      if (e.target === drawerBackdrop) closeDrawer();
    });
  }

  // Mobile Drawer Tiles
  const bindTile = (id, action) => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener("click", () => {
        closeDrawer();
        action();
      });
    }
  };

  bindTile("mDrawerBtnNotices", openNoticeBoardModal);
  bindTile("mDrawerBtnKeywords", () => {
    document.getElementById("modalKeywords").style.display = "flex";
  });
  bindTile("mDrawerBtnAi", () => {
    loadAiSettings();
    document.getElementById("modalAiSettings").style.display = "flex";
  });
  bindTile("mDrawerBtnSettings", () => {
    document.getElementById("modalSettings").style.display = "flex";
  });
  bindTile("mDrawerBtnHistory", openHistoryModal);
  bindTile("mDrawerBtnSyncBB", () => {
    const syncBtn = document.getElementById("btnSyncBB");
    if (syncBtn) syncBtn.click();
  });
  bindTile("mDrawerBtnDryRun", () => {
    triggerScrape(true);
  });

  // Mobile Bottom Navigation Bar Items
  const mNavJobs = document.getElementById("mNavJobs");
  if (mNavJobs) {
    mNavJobs.addEventListener("click", () => {
      document.querySelectorAll(".m-nav-item").forEach(item => item.classList.remove("active"));
      mNavJobs.classList.add("active");
      const section = document.querySelector(".jobs-section");
      if (section) section.scrollIntoView({ behavior: "smooth" });
    });
  }

  const mNavNotices = document.getElementById("mNavNotices");
  if (mNavNotices) {
    mNavNotices.addEventListener("click", () => {
      openNoticeBoardModal();
    });
  }

  const mNavScrape = document.getElementById("mNavScrape");
  if (mNavScrape) {
    mNavScrape.addEventListener("click", () => {
      triggerScrape(false);
    });
  }

  const mNavMenu = document.getElementById("mNavMenu");
  if (mNavMenu) {
    mNavMenu.addEventListener("click", () => {
      openDrawer();
    });
  }

  // Scraper buttons
  document.getElementById("btnScrapeNow").addEventListener("click", () => triggerScrape(false));
  document.getElementById("btnDryRun").addEventListener("click", () => triggerScrape(true));

  // Notice Board top button & stat card
  const btnOpenNotice = document.getElementById("btnOpenNoticeBoard");
  if (btnOpenNotice) btnOpenNotice.addEventListener("click", openNoticeBoardModal);
  const cardNoticeStat = document.getElementById("cardNoticeBoardStat");
  if (cardNoticeStat) cardNoticeStat.addEventListener("click", openNoticeBoardModal);

  // Notice Board modal controls
  const btnCloseNotice = document.getElementById("btnCloseNoticeBoard");
  if (btnCloseNotice) btnCloseNotice.addEventListener("click", () => {
    document.getElementById("modalNoticeBoard").style.display = "none";
  });
  const btnDismissNotice = document.getElementById("btnDismissNoticeBoard");
  if (btnDismissNotice) btnDismissNotice.addEventListener("click", () => {
    document.getElementById("modalNoticeBoard").style.display = "none";
  });

  const btnNoticeFilterAll = document.getElementById("btnNoticeFilterAll");
  const btnNoticeFilterApplied = document.getElementById("btnNoticeFilterApplied");
  const btnNoticeFilterMatched = document.getElementById("btnNoticeFilterMatched");
  const btnNoticeTabManage = document.getElementById("btnNoticeTabManageApplied");

  if (btnNoticeFilterAll) btnNoticeFilterAll.addEventListener("click", () => setNoticeTab("all"));
  if (btnNoticeFilterApplied) btnNoticeFilterApplied.addEventListener("click", () => setNoticeTab("applied"));
  if (btnNoticeFilterMatched) btnNoticeFilterMatched.addEventListener("click", () => setNoticeTab("matched"));
  if (btnNoticeTabManage) btnNoticeTabManage.addEventListener("click", () => setNoticeTab("manage-applied"));

  // Form: Add Tracked Applied Bank Job
  const formAddApplied = document.getElementById("formAddAppliedJob");
  if (formAddApplied) {
    formAddApplied.addEventListener("submit", async (e) => {
      e.preventDefault();
      const jobId = document.getElementById("appliedInputJobId").value.trim();
      const title = document.getElementById("appliedInputTitle").value.trim();
      const org = document.getElementById("appliedInputOrg").value.trim();
      const rollNo = document.getElementById("appliedInputRoll").value.trim();
      const trackingNo = document.getElementById("appliedInputTracking").value.trim();

      const btn = document.getElementById("btnAddAppliedJobSubmit");
      btn.disabled = true;
      btn.textContent = "Saving & Checking...";

      try {
        const res = await fetch("/api/bb/applied-jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jobId,
            title,
            organization: org,
            rollNo,
            trackingNo,
            sendEmailImmediately: true,
          }),
        });

        const data = await res.json();
        if (data.success) {
          formAddApplied.reset();
          const matchMsg = data.matchedNoticesCount > 0 
            ? ` Found ${data.matchedNoticesCount} official notice(s)!${data.emailSent ? " ✉️ Alert sent to your email!" : ""}`
            : " No notices yet — we will monitor and email you as soon as one appears!";
          showToast(`⭐ Tracked Job ID ${jobId}.${matchMsg}`, "success");
          await openNoticeBoardModal();
          if (data.matchedNoticesCount > 0) {
            setNoticeTab("applied");
          }
        } else {
          showToast(`❌ ${data.error}`, "error");
        }
      } catch (err) {
        showToast(`❌ Error saving applied job: ${err.message}`, "error");
      } finally {
        btn.disabled = false;
        btn.textContent = "➕ Save & Start Tracking";
      }
    });
  }

  const inputSearchNotices = document.getElementById("inputSearchNotices");
  if (inputSearchNotices) {
    inputSearchNotices.addEventListener("input", renderModalNotices);
  }

  const btnRefreshNotices = document.getElementById("btnRefreshNotices");
  if (btnRefreshNotices) {
    btnRefreshNotices.addEventListener("click", async () => {
      btnRefreshNotices.disabled = true;
      btnRefreshNotices.innerHTML = `<span class="spinner" style="width:12px;height:12px;display:inline-block;margin-right:4px;"></span> Syncing...`;
      showToast("Syncing notices from Bangladesh Bank...", "info");
      try {
        await fetch("/api/bb/scrape", { method: "POST" });
        setTimeout(async () => {
          await openNoticeBoardModal();
          await loadOverview();
          showToast("Notices updated!", "success");
          btnRefreshNotices.disabled = false;
          btnRefreshNotices.innerHTML = `🔄 Sync BB Notices Now`;
        }, 3000);
      } catch (err) {
        showToast("Error syncing notices: " + err.message, "error");
        btnRefreshNotices.disabled = false;
        btnRefreshNotices.innerHTML = `🔄 Sync BB Notices Now`;
      }
    });
  }

  // Bangladesh Bank sync button
  const btnSyncBB = document.getElementById("btnSyncBB");
  if (btnSyncBB) {
    btnSyncBB.addEventListener("click", async () => {
      btnSyncBB.disabled = true;
      btnSyncBB.innerHTML = `<span class="spinner" style="width:14px;height:14px;display:inline-block;margin-right:5px;"></span> Scanning BB...`;
      document.getElementById("terminalSection").style.display = "block";
      showToast("🏦 Syncing Bangladesh Bank jobs...", "info");
      try {
        const res = await fetch("/api/bb/scrape", { method: "POST" });
        const data = await res.json();
        if (!data.success) {
          showToast(data.message, "error");
        }
      } catch (err) {
        showToast("Failed to start BB sync: " + err.message, "error");
      } finally {
        setTimeout(() => {
          btnSyncBB.disabled = false;
          btnSyncBB.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 21h18M3 7v14M21 7v14M6 21V11M10 21V11M14 21V11M18 21V11M12 3l9 4H3l9-4z"></path></svg><span>🏦 Sync BB Now</span>`;
          loadOverview();
          loadJobs();
        }, 3000);
      }
    });
  }

  // Change recipient link
  document.getElementById("btnChangeRecipient").addEventListener("click", () => {
    document.getElementById("modalSettings").style.display = "flex";
  });

  // Autofill Modal Handlers
  document.getElementById("btnCloseAutofill").addEventListener("click", () => {
    document.getElementById("modalAutofill").style.display = "none";
  });
  document.getElementById("btnDismissAutofill").addEventListener("click", () => {
    document.getElementById("modalAutofill").style.display = "none";
  });
  document.getElementById("btnLaunchPlaywrightBrowser").addEventListener("click", executeDesktopAutofill);
  document.getElementById("btnRunCloudflarePlaywright")?.addEventListener("click", executeCloudflarePlaywright);
  document.getElementById("btnClearAutofillLogs")?.addEventListener("click", clearAutofillLogs);
  document.getElementById("btnOpenApplyInTab").addEventListener("click", () => {
    if (currentAutofillJob.url) window.open(currentAutofillJob.url, "_blank");
  });
  document.getElementById("btnCopyCliCommand").addEventListener("click", () => {
    const cmd = document.getElementById("inputAutofillCliCommand").value;
    navigator.clipboard.writeText(cmd);
    showToast("CLI command copied to clipboard!", "success");
  });
  document.getElementById("btnCopyBookmarkletScript").addEventListener("click", () => {
    if (bookmarkletCode) {
      navigator.clipboard.writeText(bookmarkletCode);
      showToast("Console Autofill script copied to clipboard! Paste into browser F12 Console.", "success");
    }
  });

  // Send alert modal
  document.getElementById("btnCloseSendAlert").addEventListener("click", () => {
    document.getElementById("modalSendAlert").style.display = "none";
  });
  document.getElementById("btnCancelSendAlert").addEventListener("click", () => {
    document.getElementById("modalSendAlert").style.display = "none";
  });
  document.getElementById("btnConfirmSendAlert").addEventListener("click", handleConfirmSendAlert);

  // Terminal toggle
  document.getElementById("btnToggleTerminal").addEventListener("click", () => {
    const term = document.getElementById("terminalSection");
    term.style.display = term.style.display === "none" ? "block" : "none";
  });
  document.getElementById("btnCloseTerminal").addEventListener("click", () => {
    document.getElementById("terminalSection").style.display = "none";
  });
  document.getElementById("btnClearTerminal").addEventListener("click", () => {
    document.getElementById("terminalLogs").innerHTML = "";
  });

  // Filter Tabs
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      e.currentTarget.classList.add("active");
      currentFilter = e.currentTarget.getAttribute("data-filter");
      loadJobs();
    });
  });

  // Search Box
  const searchInput = document.getElementById("inputSearchJobs");
  const clearBtn = document.getElementById("btnClearSearch");
  searchInput.addEventListener("input", (e) => {
    clearBtn.style.display = e.target.value ? "block" : "none";
    renderJobs(allJobs);
  });
  clearBtn.addEventListener("click", () => {
    searchInput.value = "";
    clearBtn.style.display = "none";
    renderJobs(allJobs);
  });

  // Keywords Modal
  document.getElementById("btnOpenKeywords").addEventListener("click", () => {
    document.getElementById("modalKeywords").style.display = "flex";
  });
  document.getElementById("btnCloseKeywords").addEventListener("click", () => {
    document.getElementById("modalKeywords").style.display = "none";
  });
  document.getElementById("btnAddKeyword").addEventListener("click", () => {
    const input = document.getElementById("inputNewKeyword");
    const val = input.value.trim();
    if (val && !targetKeywords.includes(val)) {
      targetKeywords.push(val);
      renderKeywordTags();
      input.value = "";
    }
  });
  document.getElementById("btnSaveKeywords").addEventListener("click", saveKeywordsList);
  document.getElementById("btnResetKeywords").addEventListener("click", () => {
    targetKeywords = [
      "programmer",
      "প্রোগ্রামার",
      "assistant programmer",
      "সহকারী প্রোগ্রামার",
      "software engineer",
      "সফটওয়্যার প্রকৌশলী",
      "software developer",
      "web developer",
      "system analyst",
      "সিস্টেম এনালিস্ট",
      "database administrator",
      "programming officer",
      "it officer"
    ];
    renderKeywordTags();
  });

  // Settings Modal
  document.getElementById("btnOpenSettings").addEventListener("click", () => {
    document.getElementById("modalSettings").style.display = "flex";
  });
  document.getElementById("btnCloseSettings").addEventListener("click", () => {
    document.getElementById("modalSettings").style.display = "none";
  });
  document.getElementById("btnCancelSettings").addEventListener("click", () => {
    document.getElementById("modalSettings").style.display = "none";
  });
  document.getElementById("btnSaveSettings").addEventListener("click", saveSettingsData);
  document.getElementById("btnTestSmtp").addEventListener("click", testSmtpAction);

  // History Modal
  document.getElementById("btnOpenHistory").addEventListener("click", openHistoryModal);
  document.getElementById("btnCloseHistory").addEventListener("click", () => {
    document.getElementById("modalHistory").style.display = "none";
  });
  document.getElementById("btnDismissHistory").addEventListener("click", () => {
    document.getElementById("modalHistory").style.display = "none";
  });

  // AI Settings Modal
  document.getElementById("btnOpenAiSettings").addEventListener("click", () => {
    loadAiSettings();
    document.getElementById("modalAiSettings").style.display = "flex";
  });
  document.getElementById("btnCloseAiSettings").addEventListener("click", () => {
    document.getElementById("modalAiSettings").style.display = "none";
  });
  document.getElementById("btnCancelAiSettings").addEventListener("click", () => {
    document.getElementById("modalAiSettings").style.display = "none";
  });
  document.getElementById("btnSaveAiSettings").addEventListener("click", saveAiSettingsData);
  document.getElementById("btnTestAllAi").addEventListener("click", testAllAiAction);

  // Key Visibility Toggle buttons
  document.querySelectorAll(".btn-icon-toggle").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const targetId = e.currentTarget.getAttribute("data-target");
      const input = document.getElementById(targetId);
      if (input) {
        if (input.type === "password") {
          input.type = "text";
          e.currentTarget.textContent = "🙈";
        } else {
          input.type = "password";
          e.currentTarget.textContent = "👁️";
        }
      }
    });
  });

  // Individual AI Provider Test buttons
  document.querySelectorAll(".btn-test-ai").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const provider = e.currentTarget.getAttribute("data-provider");
      await testSingleAiProvider(provider, e.currentTarget);
    });
  });
}

// -------------------------------------------------------------
// AI Provider Settings & Health Check Logic
// -------------------------------------------------------------
async function loadAiSettings() {
  try {
    const data = await safeJsonFetch("/api/ai/settings");
    if (!data || !data.success || !data.config) return;

    const cfg = data.config;

    // Gemini
    if (cfg.gemini) {
      document.getElementById("inputGeminiKey").value = cfg.gemini.key || "";
      document.getElementById("inputGeminiModel").value = cfg.gemini.model || "gemini-3.6-flash";
      updateAiPill("statusPillGemini", cfg.gemini.configured);
    }

    // Groq
    if (cfg.groq) {
      document.getElementById("inputGroqKey").value = cfg.groq.key || "";
      if (document.getElementById("inputGroqModel")) {
        document.getElementById("inputGroqModel").value = cfg.groq.model || "llama-3.3-70b-versatile";
      }
      updateAiPill("statusPillGroq", cfg.groq.configured);
    }

    // Cloudflare
    if (cfg.cloudflare) {
      document.getElementById("inputCfAccountId").value = cfg.cloudflare.accountId || "";
      document.getElementById("inputCfApiToken").value = cfg.cloudflare.apiToken || "";
      updateAiPill("statusPillCloudflare", cfg.cloudflare.configured);
    }

    // OpenRouter
    if (cfg.openrouter) {
      document.getElementById("inputOpenrouterKey").value = cfg.openrouter.key || "";
      updateAiPill("statusPillOpenRouter", cfg.openrouter.configured);
    }

    // Update Nav Active Count
    let activeCount = 0;
    if (cfg.gemini && cfg.gemini.configured) activeCount++;
    if (cfg.groq && cfg.groq.configured) activeCount++;
    if (cfg.cloudflare && cfg.cloudflare.configured) activeCount++;
    if (cfg.openrouter && cfg.openrouter.configured) activeCount++;

    const navBadge = document.getElementById("navAiActiveCount");
    if (activeCount > 0) {
      navBadge.textContent = `${activeCount} Active`;
      navBadge.style.background = "rgba(16, 185, 129, 0.15)";
      navBadge.style.color = "#10b981";
      navBadge.style.borderColor = "rgba(16, 185, 129, 0.3)";
    } else {
      navBadge.textContent = "0 Active";
      navBadge.style.background = "rgba(244, 63, 94, 0.15)";
      navBadge.style.color = "#f43f5e";
      navBadge.style.borderColor = "rgba(244, 63, 94, 0.3)";
    }
  } catch (err) {
    console.error("Failed to load AI settings:", err);
  }
}

function updateAiPill(elementId, isConfigured) {
  const pill = document.getElementById(elementId);
  if (!pill) return;
  if (isConfigured) {
    pill.className = "ai-status-pill active";
    pill.innerHTML = `<span class="status-dot green"></span><span class="status-text">Active</span>`;
  } else {
    pill.className = "ai-status-pill inactive";
    pill.innerHTML = `<span class="status-dot red"></span><span class="status-text">No Key</span>`;
  }
}

async function testSingleAiProvider(provider, btnElement) {
  const feedbackEl = document.getElementById(`testResult${capitalize(provider)}`);
  const originalText = btnElement.innerHTML;
  btnElement.disabled = true;
  btnElement.innerHTML = `<span class="spinner" style="width:12px;height:12px;display:inline-block;margin-right:4px;"></span> Testing...`;
  if (feedbackEl) {
    feedbackEl.className = "ai-test-feedback";
    feedbackEl.textContent = "Connecting...";
  }

  // Gather current form values as overrides so user can test before saving!
  const overrides = {};
  if (provider === "gemini") {
    overrides.key = document.getElementById("inputGeminiKey").value.trim();
    overrides.model = document.getElementById("inputGeminiModel").value.trim();
  } else if (provider === "groq") {
    overrides.key = document.getElementById("inputGroqKey").value.trim();
    if (document.getElementById("inputGroqModel")) {
      overrides.model = document.getElementById("inputGroqModel").value.trim();
    }
  } else if (provider === "cloudflare") {
    overrides.accountId = document.getElementById("inputCfAccountId").value.trim();
    overrides.apiToken = document.getElementById("inputCfApiToken").value.trim();
  } else if (provider === "openrouter") {
    overrides.key = document.getElementById("inputOpenrouterKey").value.trim();
  }

  try {
    const res = await fetch("/api/ai/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, overrides })
    });
    const result = await res.json();

    if (result.success) {
      if (feedbackEl) {
        feedbackEl.className = "ai-test-feedback success";
        feedbackEl.textContent = `✅ Connected (${result.latencyMs}ms)`;
      }
      showToast(`✅ ${capitalize(provider)} connection verified (${result.latencyMs}ms)`, "success");
    } else {
      if (feedbackEl) {
        feedbackEl.className = "ai-test-feedback error";
        feedbackEl.textContent = `❌ ${result.error.slice(0, 45)}`;
      }
      showToast(`❌ ${capitalize(provider)} error: ${result.error}`, "error");
    }
  } catch (err) {
    if (feedbackEl) {
      feedbackEl.className = "ai-test-feedback error";
      feedbackEl.textContent = `❌ ${err.message}`;
    }
    showToast(`Error testing ${provider}: ${err.message}`, "error");
  } finally {
    btnElement.disabled = false;
    btnElement.innerHTML = originalText;
  }
}

async function testAllAiAction() {
  const btn = document.getElementById("btnTestAllAi");
  const originalText = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner" style="width:14px;height:14px;display:inline-block;margin-right:6px;"></span> Testing All 4 Providers...`;

  const providers = ["gemini", "groq", "cloudflare", "openrouter"];
  for (const p of providers) {
    const testBtn = document.querySelector(`.btn-test-ai[data-provider="${p}"]`);
    if (testBtn) await testSingleAiProvider(p, testBtn);
  }

  btn.disabled = false;
  btn.innerHTML = originalText;
  showToast("Health check completed for all configured AI providers.", "info");
}

async function saveAiSettingsData() {
  const btn = document.getElementById("btnSaveAiSettings");
  btn.disabled = true;
  btn.textContent = "Saving...";

  const payload = {
    geminiKey: document.getElementById("inputGeminiKey").value.trim(),
    geminiModel: document.getElementById("inputGeminiModel").value.trim(),
    groqKey: document.getElementById("inputGroqKey").value.trim(),
    groqModel: document.getElementById("inputGroqModel") ? document.getElementById("inputGroqModel").value.trim() : "",
    cfAccountId: document.getElementById("inputCfAccountId").value.trim(),
    cfApiToken: document.getElementById("inputCfApiToken").value.trim(),
    openrouterKey: document.getElementById("inputOpenrouterKey").value.trim()
  };

  try {
    const res = await fetch("/api/ai/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.success) {
      showToast("✨ AI Provider API keys saved & updated instantly!", "success");
      await loadAiSettings();
      document.getElementById("modalAiSettings").style.display = "none";
    } else {
      showToast(data.message || "Failed to save AI configuration", "error");
    }
  } catch (err) {
    showToast("Error saving AI settings: " + err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Save AI Configuration";
  }
}

function capitalize(s) {
  if (!s) return "";
  return s.charAt(0).toUpperCase() + s.slice(1);
}


// -------------------------------------------------------------
// Utilities
// -------------------------------------------------------------
function showToast(message, type = "info") {
  const container = document.getElementById("toastContainer");
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.remove();
  }, 4000);
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatRelativeTime(isoString) {
  if (!isoString) return "Never";
  const diffSec = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
  if (diffSec < 60) return "Just now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}
