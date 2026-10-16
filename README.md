# Teletalk Job Notifier & Control Dashboard

Automated Bangladeshi Government CSE/IT Job Radar that monitors [alljobs.teletalk.com.bd](https://alljobs.teletalk.com.bd/jobs/government) for new matching circulars, sends email alerts via **Titan SMTP** (or Resend/Telegram), and provides an interactive web dashboard for real-time monitoring and 1-click form autofill.

---

## 🚀 Quick Start (Web Dashboard)

Start the local control center:

```bash
npm run dashboard
```

Open your browser at:
👉 **[http://localhost:3000](http://localhost:3000)**

### Dashboard Features:
- 📊 **Real-time Overview & Stats**: Total jobs discovered, active CSE/IT keyword matches, last scrape duration, and seen job count.
- ⚡ **Live Scraper Control**: Trigger Live Scrapes or Dry Runs on-demand with real-time streaming Playwright terminal output.
- ⏱️ **Background Scheduler**: Configure automated recurring scans (every 15m, 30m, 1h, 6h, etc.).
- 📧 **Titan SMTP Email Delivery**: Configured with `smtp.titan.email:587` and live test email tool to verify inbox delivery.
- 🔍 **All Jobs Explorer**: Search by title, organization, or job ID (`GJOB#####`), filter by matched/unmatched, open official application links, and view PDF circulars.
- 🤖 **1-Click Autofill Integration**: Launch the headed Playwright browser directly from any job card to auto-fill your application form!
- 🎯 **Dynamic Keywords Manager**: Add or remove target CSE/IT job titles with Bangla and English keyword matching.

---

## 📧 Email Notification Setup (SMTP)

Configure in `.env`:

```env
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=your_email@example.com
SMTP_PASS=your_email_password
SMTP_FROM="Teletalk Job Alert" <your_email@example.com>
NOTIFY_EMAIL=your_email@example.com
```

You can test your SMTP connection and send a sample email directly from the **SMTP & Settings** modal in the web dashboard.

---

## 🛠️ CLI Commands

```bash
# Start the web dashboard (recommended)
npm run dashboard

# Run a live scrape in CLI
npm run check

# Run a dry-run test (prints matches without updating seen-jobs or sending alerts)
npm run check:dry

# Launch the Playwright form autofill tool
npm run autofill -- --url "https://bhtpa.teletalk.com.bd/" --post "Assistant Programmer"
```

---

## Bangladesh Bank portal (erecruitment.bb.org.bd)

The BB e-recruitment portal sits behind an F5 anti-bot layer that answers
requests from cloud/datacenter IP ranges (GitHub Actions runners, Cloudflare,
AWS, ...) with an image CAPTCHA instead of the job list — even when the request
comes from Bangladesh. Only real Bangladeshi residential connections receive
the actual content, so the GitHub cron alone cannot reliably scan this portal
(it records a clear "CAPTCHA challenge" note in scrape history when blocked).

That is why BB scanning runs **from your own PC** (a Bangladeshi connection):

```bash
# BB portal only (Teletalk keeps running on the GitHub cron).
# Sends the same email alerts for new keyword matches and updates data files.
npm run check:bb
```

On Windows this is wired up as the Scheduled Task **"BB Portal Job Scan"**,
which runs `scripts/bb-local-run.ps1` every 6 hours, logs to
`data/bb-local-run.log`, and pushes the updated data files back to GitHub so
the dashboard stays current and the GitHub cron won't double-alert.

Recreate or move the task (adjust the repo path):

```powershell
$repo = "C:\Users\toufi_qicjadj\job-automation"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$repo\scripts\bb-local-run.ps1`""
$trigger = New-ScheduledTaskTrigger -Once -At "05:45" -RepetitionInterval (New-TimeSpan -Hours 6)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
Register-ScheduledTask -TaskName "BB Portal Job Scan" -Action $action -Trigger $trigger -Settings $settings
```

Remove it with: `Unregister-ScheduledTask -TaskName "BB Portal Job Scan" -Confirm:$false`

Optional (advanced): if you ever get a Bangladeshi residential proxy, set
`BB_PROXY_URL=http://user:pass@host:port` in `.env` (and/or as the
`BB_PROXY_URL` GitHub secret) and the GitHub cron will scan BB directly too.
