import "dotenv/config";
import nodemailer from "nodemailer";

// Sends a notification about a matched job via SMTP (Nodemailer), Resend, and/or Telegram.
// Whichever env vars are present get used.

export function createSmtpTransporter(customConfig = null) {
  const host = customConfig?.host || process.env.SMTP_HOST;
  const port = parseInt(customConfig?.port || process.env.SMTP_PORT || "587", 10);
  const user = customConfig?.user || process.env.SMTP_USER;
  const pass = customConfig?.pass || process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    return null;
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465, // true for 465, false for 587 or others
    auth: {
      user,
      pass,
    },
    tls: {
      rejectUnauthorized: false,
    },
  });
}

export async function testSmtpConnection(customConfig = null, recipientEmail = null) {
  const transporter = createSmtpTransporter(customConfig);
  if (!transporter) {
    return { success: false, message: "SMTP configuration is incomplete (Host, User, or Password missing)." };
  }

  try {
    await transporter.verify();
    
    // If recipient is provided, send a test email
    const to = recipientEmail || customConfig?.to || process.env.NOTIFY_EMAIL || process.env.SMTP_USER;
    if (to) {
      const from = customConfig?.from || process.env.SMTP_FROM || `"Teletalk Job Alert" <${customConfig?.user || process.env.SMTP_USER}>`;
      const info = await transporter.sendMail({
        from,
        to,
        subject: "🔔 Teletalk Job Notifier - SMTP Test Message",
        html: `
          <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #0f172a; color: #f8fafc; border-radius: 12px; overflow: hidden; border: 1px solid #334155; box-shadow: 0 10px 25px rgba(0,0,0,0.5);">
            <div style="background: linear-gradient(135deg, #6366f1, #8b5cf6); padding: 24px; text-align: center;">
              <h2 style="margin: 0; color: #ffffff; font-size: 22px; font-weight: 700;">✅ SMTP Connected Successfully!</h2>
              <p style="margin: 6px 0 0 0; color: #e0e7ff; font-size: 14px;">Teletalk Job Notifier Email Delivery System</p>
            </div>
            <div style="padding: 28px;">
              <p style="font-size: 15px; line-height: 1.6; color: #cbd5e1; margin-top: 0;">
                Your SMTP configuration with <strong>${customConfig?.host || process.env.SMTP_HOST}</strong> is working properly.
              </p>
              <div style="background: #1e293b; border-left: 4px solid #10b981; padding: 16px; border-radius: 6px; margin: 20px 0;">
                <p style="margin: 0 0 8px 0; font-weight: 600; color: #10b981;">SMTP Diagnostics:</p>
                <ul style="margin: 0; padding-left: 20px; color: #94a3b8; font-size: 13px; line-height: 1.8;">
                  <li>Host: <strong>${customConfig?.host || process.env.SMTP_HOST}</strong></li>
                  <li>Port: <strong>${customConfig?.port || process.env.SMTP_PORT || "587"}</strong></li>
                  <li>User: <strong>${customConfig?.user || process.env.SMTP_USER}</strong></li>
                  <li>Recipient: <strong>${to}</strong></li>
                  <li>Timestamp: <strong>${new Date().toLocaleString()}</strong></li>
                </ul>
              </div>
              <p style="font-size: 14px; color: #94a3b8; margin-bottom: 0;">
                Whenever a new matching circular or post is discovered on Teletalk, you will receive an alert like this immediately.
              </p>
            </div>
            <div style="background: #090d16; padding: 16px 28px; text-align: center; font-size: 12px; color: #64748b; border-top: 1px solid #1e293b;">
              Teletalk Job Notifier &bull; Automated Bangladeshi Government Job Radar
            </div>
          </div>
        `,
      });
      return { success: true, message: `SMTP verified & test email sent to ${to}! Message ID: ${info.messageId}`, messageId: info.messageId };
    }

    return { success: true, message: "SMTP connection verified successfully!" };
  } catch (err) {
    console.error("SMTP verification error:", err);
    return { success: false, message: err.message || "Failed to verify SMTP connection." };
  }
}

export async function notifyJob(job, customEmailTo = null) {
  const results = [];
  const errors = [];

  // 1. SMTP Email (Titan Email or custom)
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    try {
      const res = await sendEmailSmtp(job, customEmailTo);
      results.push({ channel: "smtp", success: res.success, info: res.info });
      if (!res.success) errors.push(`SMTP error: ${res.error}`);
    } catch (err) {
      errors.push(`SMTP failed: ${err.message}`);
    }
  }

  // 2. Resend API Email (if configured)
  if (process.env.RESEND_API_KEY && (customEmailTo || process.env.NOTIFY_EMAIL)) {
    try {
      const res = await sendEmailResend(job, customEmailTo);
      results.push({ channel: "resend", success: res });
    } catch (err) {
      errors.push(`Resend failed: ${err.message}`);
    }
  }

  // 3. Telegram (if configured)
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    try {
      const res = await sendTelegram(job);
      results.push({ channel: "telegram", success: res });
    } catch (err) {
      errors.push(`Telegram failed: ${err.message}`);
    }
  }

  if (results.length === 0 && errors.length === 0) {
    console.warn(
      "No notification channel configured (set SMTP credentials, RESEND_API_KEY+NOTIFY_EMAIL, or TELEGRAM_BOT_TOKEN+TELEGRAM_CHAT_ID)."
    );
  }

  return { results, errors };
}

async function sendEmailSmtp(job, customEmailTo = null) {
  const transporter = createSmtpTransporter();
  if (!transporter) return { success: false, error: "SMTP transporter could not be created" };

  const to = customEmailTo || process.env.NOTIFY_EMAIL || process.env.SMTP_USER;
  const from = process.env.SMTP_FROM || `"Teletalk Job Alert" <${process.env.SMTP_USER}>`;

  const html = `
    <div style="font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 620px; margin: 0 auto; background: #0f172a; color: #f8fafc; border-radius: 16px; overflow: hidden; border: 1px solid #334155; box-shadow: 0 20px 40px rgba(0,0,0,0.6);">
      <!-- Header -->
      <div style="background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%); padding: 28px 24px; text-align: center;">
        <div style="display: inline-block; background: rgba(255, 255, 255, 0.2); padding: 4px 14px; border-radius: 20px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; color: #ffffff; margin-bottom: 12px;">
          🎯 New Matching Job Found
        </div>
        <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 700; line-height: 1.3;">
          ${job.title}
        </h1>
        <p style="margin: 8px 0 0 0; color: #e0e7ff; font-size: 16px; font-weight: 500;">
          ${job.category || "Teletalk Government Portal"}
        </p>
      </div>

      <!-- Content Details -->
      <div style="padding: 28px 24px;">
        <div style="background: #1e293b; border-radius: 12px; padding: 20px; border: 1px solid #334155; margin-bottom: 24px;">
          <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
            <tr>
              <td style="padding: 8px 0; color: #94a3b8; width: 120px; font-weight: 500;">Job ID:</td>
              <td style="padding: 8px 0; color: #f8fafc; font-weight: 600;"><code>${job.id || "N/A"}</code></td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #94a3b8; font-weight: 500;">Organization:</td>
              <td style="padding: 8px 0; color: #38bdf8; font-weight: 600;">${job.category || "Government Organization"}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #94a3b8; font-weight: 500;">Deadline:</td>
              <td style="padding: 8px 0; color: #f43f5e; font-weight: 700;">${job.deadline || "Check circular"}</td>
            </tr>
            ${job.matchedKeywords ? `
            <tr>
              <td style="padding: 8px 0; color: #94a3b8; font-weight: 500;">Matched Terms:</td>
              <td style="padding: 8px 0; color: #a78bfa; font-weight: 600;">${Array.isArray(job.matchedKeywords) ? job.matchedKeywords.join(", ") : job.matchedKeywords}</td>
            </tr>` : ""}
          </table>
        </div>

        <!-- Call to Actions -->
        <div style="text-align: center; margin: 30px 0 10px 0;">
          <a href="${job.applyUrl}" style="display: inline-block; background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: #ffffff; text-decoration: none; font-weight: 700; font-size: 16px; padding: 14px 32px; border-radius: 10px; box-shadow: 0 4px 14px rgba(16, 185, 129, 0.4); margin: 0 8px 12px 8px;">
            🚀 Apply Online Now
          </a>
          ${job.pdfUrl ? `
          <a href="${job.pdfUrl}" style="display: inline-block; background: #334155; color: #f1f5f9; text-decoration: none; font-weight: 600; font-size: 15px; padding: 14px 24px; border-radius: 10px; border: 1px solid #475569; margin: 0 8px 12px 8px;">
            📄 View Circular PDF
          </a>` : ""}
        </div>
      </div>

      <!-- Footer -->
      <div style="background: #090d16; padding: 18px 24px; text-align: center; font-size: 12px; color: #64748b; border-top: 1px solid #1e293b;">
        <p style="margin: 0 0 4px 0;">Automated alert generated by Teletalk Job Notifier</p>
        <p style="margin: 0;">Portal Link: <a href="${job.applyUrl}" style="color: #6366f1; text-decoration: none;">${job.applyUrl}</a></p>
      </div>
    </div>
  `;

  try {
    const info = await transporter.sendMail({
      from,
      to,
      subject: `🚨 New Teletalk Job: ${job.title} (${job.category || "Govt"})`,
      html,
    });
    console.log(`[SMTP] Notification sent to ${to} for job "${job.title}". Message ID: ${info.messageId}`);
    return { success: true, info };
  } catch (err) {
    console.error("[SMTP] Send failed:", err);
    return { success: false, error: err.message };
  }
}

async function sendEmailResend(job, customEmailTo = null) {
  const to = customEmailTo || process.env.NOTIFY_EMAIL;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "Teletalk Job Alert <onboarding@resend.dev>",
      to: [to],
      subject: `New job match: ${job.title}`,
      html: `
        <p><strong>${job.title}</strong></p>
        <p>Organization: ${job.category || "N/A"}</p>
        ${job.deadline ? `<p>Deadline: ${job.deadline}</p>` : ""}
        <p><a href="${job.applyUrl}">Apply online</a></p>
        ${job.pdfUrl ? `<p><a href="${job.pdfUrl}">Circular PDF</a></p>` : ""}
      `,
    }),
  });

  if (!res.ok) {
    console.error("Resend send failed:", res.status, await res.text());
  }
  return res.ok;
}

async function sendTelegram(job) {
  const text = [
    `*New job match:* ${escapeMd(job.title)}`,
    job.category ? `Organization: ${escapeMd(job.category)}` : null,
    job.deadline ? escapeMd(job.deadline) : null,
    `Apply: ${job.applyUrl}`,
    job.pdfUrl ? `PDF: ${job.pdfUrl}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const res = await fetch(
    `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: process.env.TELEGRAM_CHAT_ID,
        text,
        parse_mode: "Markdown",
        disable_web_page_preview: false,
      }),
    }
  );

  if (!res.ok) {
    console.error("Telegram send failed:", res.status, await res.text());
  }
  return res.ok;
}

function escapeMd(str) {
  return String(str).replace(/([_*[\]()~`>#+\-=|{}.!])/g, "\\$1");
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

/**
 * Send an alert email specifically for an official Bangladesh Bank notice matching an applied job!
 * Matches on Job ID code or position title.
 */
export async function notifyBankNotice(notice, appliedJob, customEmailTo = null) {
  const transporter = createSmtpTransporter();
  if (!transporter) return { success: false, error: "SMTP transporter could not be created" };

  const to = customEmailTo || process.env.NOTIFY_EMAIL || process.env.SMTP_USER;
  const from = process.env.SMTP_FROM || `"Bangladesh Bank Job Alert" <${process.env.SMTP_USER}>`;

  const jobIdCode = appliedJob?.jobId || notice.jobId || "N/A";
  const postTitle = appliedJob?.title || notice.title || "Applied Bank Post";
  const orgName = appliedJob?.organization || notice.circularFor || "Bangladesh Bank / BSCS";

  const html = `
    <div style="font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 620px; margin: 0 auto; background: #0f172a; color: #f8fafc; border-radius: 16px; overflow: hidden; border: 1px solid #f59e0b; box-shadow: 0 20px 40px rgba(0,0,0,0.6);">
      <!-- Header -->
      <div style="background: linear-gradient(135deg, #b45309 0%, #d97706 50%, #f59e0b 100%); padding: 28px 24px; text-align: center;">
        <div style="display: inline-block; background: rgba(0, 0, 0, 0.3); padding: 5px 16px; border-radius: 20px; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: #fef3c7; margin-bottom: 12px; border: 1px solid rgba(255,255,255,0.2);">
          ⭐ URGENT: APPLIED BANK JOB NOTICE
        </div>
        <h1 style="margin: 0; color: #ffffff; font-size: 22px; font-weight: 800; line-height: 1.3;">
          ${escapeHtml(notice.title)}
        </h1>
        <p style="margin: 8px 0 0 0; color: #fef3c7; font-size: 15px; font-weight: 600;">
          Job ID: ${jobIdCode} &bull; ${escapeHtml(orgName)}
        </p>
      </div>

      <!-- Content Details -->
      <div style="padding: 26px 24px;">
        <div style="background: #1e293b; border-radius: 12px; padding: 20px; border: 1px solid #334155; margin-bottom: 22px;">
          <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
            <tr>
              <td style="padding: 8px 0; color: #94a3b8; width: 140px; font-weight: 500;">Matched Job ID:</td>
              <td style="padding: 8px 0; color: #fbbf24; font-weight: 700; font-size: 16px;"><code>${jobIdCode}</code></td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #94a3b8; font-weight: 500;">Your Applied Post:</td>
              <td style="padding: 8px 0; color: #f8fafc; font-weight: 600;">${escapeHtml(postTitle)}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #94a3b8; font-weight: 500;">Organization:</td>
              <td style="padding: 8px 0; color: #38bdf8; font-weight: 600;">${escapeHtml(orgName)}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #94a3b8; font-weight: 500;">Notice Publish Date:</td>
              <td style="padding: 8px 0; color: #10b981; font-weight: 700;">${escapeHtml(notice.publishDate || "Recent")}</td>
            </tr>
            ${notice.closeDate ? `
            <tr>
              <td style="padding: 8px 0; color: #94a3b8; font-weight: 500;">Exam / Deadline:</td>
              <td style="padding: 8px 0; color: #f43f5e; font-weight: 700;">${escapeHtml(notice.closeDate)}</td>
            </tr>` : ""}
            ${appliedJob?.rollNo ? `
            <tr>
              <td style="padding: 8px 0; color: #94a3b8; font-weight: 500;">Your Roll No:</td>
              <td style="padding: 8px 0; color: #a78bfa; font-weight: 600;">${escapeHtml(appliedJob.rollNo)}</td>
            </tr>` : ""}
            ${appliedJob?.trackingNo ? `
            <tr>
              <td style="padding: 8px 0; color: #94a3b8; font-weight: 500;">Tracking No:</td>
              <td style="padding: 8px 0; color: #a78bfa; font-weight: 600;">${escapeHtml(appliedJob.trackingNo)}</td>
            </tr>` : ""}
          </table>
        </div>

        <p style="font-size: 14px; color: #cbd5e1; line-height: 1.5; margin: 0 0 20px 0;">
          This official notice was published on the Bangladesh Bank e-recruitment portal matching your applied <strong>Job ID Code: ${jobIdCode}</strong>. Check the official PDF notice immediately for your exam schedule, admit card instructions, seat plan, or result status.
        </p>

        <!-- Call to Action Buttons -->
        <div style="text-align: center; margin: 10px 0;">
          ${notice.pdfUrl ? `
          <a href="${notice.pdfUrl}" style="display: inline-block; background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); color: #000000; text-decoration: none; font-weight: 800; font-size: 15px; padding: 14px 28px; border-radius: 10px; box-shadow: 0 4px 14px rgba(245, 158, 11, 0.4); margin: 0 6px 10px 6px;">
            📄 View Official Notice PDF
          </a>` : ""}
          <a href="https://erecruitment.bb.org.bd/career/jobopportunity_bscs.php" style="display: inline-block; background: #1e293b; color: #e2e8f0; text-decoration: none; font-weight: 600; font-size: 14px; padding: 14px 22px; border-radius: 10px; border: 1px solid #475569; margin: 0 6px 10px 6px;">
            🏦 BB Notice Board
          </a>
        </div>
      </div>

      <!-- Footer -->
      <div style="background: #090d16; padding: 16px 24px; text-align: center; font-size: 12px; color: #64748b; border-top: 1px solid #1e293b;">
        <p style="margin: 0 0 4px 0;">Bangladesh Bank BSCS Applied Job Alert System</p>
        <p style="margin: 0;">Recipient: <strong>${to}</strong></p>
      </div>
    </div>
  `;

  try {
    const info = await transporter.sendMail({
      from,
      to,
      subject: `🚨 [BB Notice Alert] Urgent Notice for Applied Job (${jobIdCode}): ${notice.title}`,
      html,
    });
    console.log(`[SMTP] Applied Bank Job Notice email sent to ${to} for Job ID "${jobIdCode}". Message ID: ${info.messageId}`);
    return { success: true, info };
  } catch (err) {
    console.error("[SMTP] Applied Bank Job Notice email failed:", err);
    return { success: false, error: err.message };
  }
}

