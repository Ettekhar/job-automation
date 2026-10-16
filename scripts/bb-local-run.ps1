# ============================================================================
#  Bangladesh Bank portal local runner
# ============================================================================
#  Why this exists:
#    erecruitment.bb.org.bd (and www.bb.org.bd) are protected by an F5
#    anti-bot layer that shows a CAPTCHA challenge to cloud/datacenter IPs -
#    including GitHub Actions runners and even Cloudflare. Only real
#    Bangladeshi residential IPs get the actual job list. This PC is such an
#    IP, so this script runs the BB-only scan locally and syncs the results
#    (data files) back to GitHub so the dashboard and the GitHub cron stay in
#    sync and don't send duplicate alerts.
#
#  Installed as a Windows Scheduled Task ("BB Portal Job Scan") that runs
#  every 6 hours. Logs to:  data/bb-local-run.log
#
#  NOTE: keep this file pure ASCII. Windows PowerShell 5.1 reads BOM-less
#  files as ANSI, and non-ASCII bytes (e.g. an em-dash) can be interpreted
#  as quote characters, breaking the parser.
# ============================================================================

$ErrorActionPreference = "Continue"
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

# Scheduled tasks get a minimal PATH - add what we need.
$env:Path = "$env:ProgramFiles\nodejs;$env:ProgramFiles\Git\cmd;" + $env:Path
# Never pop up credential prompts in a background run - fail cleanly instead.
$env:GIT_TERMINAL_PROMPT = "0"
$env:GCM_INTERACTIVE = "never"

$log = Join-Path $repoRoot "data\bb-local-run.log"
if (-not (Test-Path (Split-Path $log))) { New-Item -ItemType Directory -Path (Split-Path $log) -Force | Out-Null }

# Keep the log from growing forever (trim to last ~200 lines over 1 MB).
if ((Test-Path $log) -and ((Get-Item $log).Length -gt 1MB)) {
    Get-Content $log -Tail 200 | Set-Content $log
}

function Log([string]$msg) {
    $line = "{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
    Add-Content -Path $log -Value $line
    Write-Host $line
}

function Run([string]$exe, [string[]]$arguments) {
    & $exe @arguments 2>&1 | ForEach-Object { Add-Content -Path $log -Value "    $_" }
    return $LASTEXITCODE
}

Log "=== BB local run start (pid $PID) in $repoRoot ==="

# 1. Latest state from GitHub (seen-jobs etc. updated by the GH cron).
Run "git" @("pull", "--rebase", "--autostash")

# 2. Make sure dependencies exist / are current.
if (-not (Test-Path (Join-Path $repoRoot "node_modules"))) {
    Run "npm" @("install", "--no-audit", "--no-fund")
}

# 3. The actual BB-only scrape (Teletalk is skipped - GitHub handles that).
#    This autonomously sends email alerts for new keyword matches via SMTP.
Run "node" @("scripts/scrape.mjs", "--bb-only")

# 4. Rebuild static dashboard data.
Run "npm" @("run", "build")

# 5. Push updated data back to GitHub (only if something changed).
Run "git" @("add", "data", "public/data", "public/api")
& git diff --staged --quiet
if ($LASTEXITCODE -ne 0) {
    Run "git" @("-c", "user.name=bb-local-runner", "-c", "user.email=bb-local-runner@users.noreply.github.com", "commit", "-m", "chore(data): local Bangladesh Bank portal scan")
    $pushed = $false
    for ($i = 1; $i -le 3; $i++) {
        Run "git" @("pull", "--rebase", "--autostash")
        $code = Run "git" @("push")
        if ($code -eq 0) { Log "push ok (attempt $i)"; $pushed = $true; break }
        Log "push attempt $i failed - retrying in 10s"
        Start-Sleep -Seconds 10
    }
    if (-not $pushed) { Log "WARNING: could not push data to GitHub after 3 attempts (next run will retry)" }
} else {
    Log "no data changes to commit"
}

Log "=== BB local run done ==="
