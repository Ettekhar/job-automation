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
#  Resilient by design: if a GitHub data push and this PC's data push
#  collide, git stops the rebase on a conflict. The script then auto-resolves
#  it (keep local content; union-merge seen-jobs/history), and if it still
#  cannot finish it aborts the rebase so the repo can never stay wedged.
#
#  NOTE: keep this file pure ASCII. Windows PowerShell 5.1 reads BOM-less
#  files as ANSI, and non-ASCII bytes (e.g. an em-dash) can be interpreted
#  as quote characters, breaking the parser.
# ============================================================================

$ErrorActionPreference = "Continue"
# Decode child-process (node/git) UTF-8 output correctly so emoji don't turn
# into mojibake in the log.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

# Scheduled tasks get a minimal PATH - add what we need.
$env:Path = "$env:ProgramFiles\nodejs;$env:ProgramFiles\Git\cmd;" + $env:Path
# Never pop up credential prompts in a background run - fail cleanly instead.
$env:GIT_TERMINAL_PROMPT = "0"
$env:GCM_INTERACTIVE = "never"
# rebase --continue must never try to open an editor in a background run.
$env:GIT_EDITOR = "true"
# Git identity for every commit this runner creates (data commits, rebase
# replays, conflict-resolved continues). Without it, a rebase --continue
# fails with "Committer identity unknown" on a machine with no git config.
$env:GIT_AUTHOR_NAME = "bb-local-runner"
$env:GIT_AUTHOR_EMAIL = "bb-local-runner@users.noreply.github.com"
$env:GIT_COMMITTER_NAME = "bb-local-runner"
$env:GIT_COMMITTER_EMAIL = "bb-local-runner@users.noreply.github.com"

$log = Join-Path $repoRoot "data\bb-local-run.log"
if (-not (Test-Path (Split-Path $log))) { New-Item -ItemType Directory -Path (Split-Path $log) -Force | Out-Null }

# Keep the log from growing forever (trim to last ~200 lines over 1 MB).
if ((Test-Path $log) -and ((Get-Item $log).Length -gt 1MB)) {
    Get-Content $log -Tail 200 | Set-Content $log
}

function Log([string]$msg) {
    $line = "{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
    Add-Content -Path $log -Value $line -Encoding UTF8
    Write-Host $line
}

function Run([string]$exe, [string[]]$arguments) {
    & $exe @arguments 2>&1 | ForEach-Object { Add-Content -Path $log -Value "    $_" -Encoding UTF8 }
    return $LASTEXITCODE
}

function Test-RebaseOrMergeInProgress {
    return ((Test-Path (Join-Path $repoRoot ".git\rebase-merge")) -or
            (Test-Path (Join-Path $repoRoot ".git\rebase-apply")) -or
            (Test-Path (Join-Path $repoRoot ".git\MERGE_HEAD")))
}

# Resolve a rebase that stopped on a conflict: keep this PC's freshly scraped
# data for regular files, union-merge the dedupe/history lists (so no alert is
# ever re-sent and no scan record is lost), then continue the rebase. If the
# rebase cannot be completed, abort it so the repo never stays wedged.
function Resolve-RebaseIfNeeded([string]$context) {
    if (-not (Test-RebaseOrMergeInProgress)) { return }
    Log "git conflict detected ($context) - resolving automatically"
    for ($r = 1; $r -le 8; $r++) {
        node (Join-Path $repoRoot "scripts\lib\resolveDataConflict.mjs") 2>&1 |
            ForEach-Object { Add-Content -Path $log -Value "    $_" -Encoding UTF8 }
        Run "git" @("add", "-A") | Out-Null
        Run "git" @("-c", "core.editor=true", "-c", "user.name=bb-local-runner", "-c", "user.email=bb-local-runner@users.noreply.github.com", "rebase", "--continue") | Out-Null
        if (-not (Test-RebaseOrMergeInProgress)) { Log "conflicts resolved ($context)"; return }
    }
    Log "could not finish the rebase - aborting it so the repo stays usable ($context)"
    if (Test-Path (Join-Path $repoRoot ".git\MERGE_HEAD")) { Run "git" @("merge", "--abort") | Out-Null }
    if ((Test-Path (Join-Path $repoRoot ".git\rebase-merge")) -or (Test-Path (Join-Path $repoRoot ".git\rebase-apply"))) {
        Run "git" @("rebase", "--abort") | Out-Null
    }
}

Log "=== BB local run start (pid $PID) in $repoRoot ==="

# 0. Recover from any wedged git state left by an interrupted earlier run.
if ((Test-Path (Join-Path $repoRoot ".git\rebase-merge")) -or (Test-Path (Join-Path $repoRoot ".git\rebase-apply"))) {
    Log "recovering: aborting a stale rebase left by an earlier run"
    Run "git" @("rebase", "--abort") | Out-Null
}
if (Test-Path (Join-Path $repoRoot ".git\MERGE_HEAD")) {
    Log "recovering: aborting a stale merge"
    Run "git" @("merge", "--abort") | Out-Null
}
# Drop an orphaned autostash (created only by this script; timestamp churn).
for ($s = 0; $s -lt 5; $s++) {
    $first = git stash list 2>$null | Select-Object -First 1
    if ($first -and ($first -match "autostash")) {
        Log "recovering: dropping an orphaned autostash"
        Run "git" @("stash", "drop", "stash@{0}") | Out-Null
    } else { break }
}
$branchName = git rev-parse --abbrev-ref HEAD 2>$null
if ($branchName -and ($branchName -ne "main")) {
    Log "recovering: was on '$branchName', switching back to main"
    Run "git" @("checkout", "main") | Out-Null
}

# 1. Latest state from GitHub (seen-jobs etc. updated by the GH cron).
$pullCode = Run "git" @("pull", "--rebase", "--autostash")
if ($pullCode -ne 0) { Resolve-RebaseIfNeeded "startup pull" }

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
        $pullCode = Run "git" @("pull", "--rebase", "--autostash")
        if ($pullCode -ne 0) {
            Resolve-RebaseIfNeeded "push attempt $i"
            # A conflict-merge can leave the derived dashboard files stale;
            # rebuild them from the merged data before pushing.
            Run "npm" @("run", "build")
            Run "git" @("add", "data", "public") | Out-Null
            & git diff --staged --quiet
            if ($LASTEXITCODE -ne 0) {
                Run "git" @("commit", "--amend", "--no-edit") | Out-Null
            }
        }
        $code = Run "git" @("push")
        if ($code -eq 0) { Log "push ok (attempt $i)"; $pushed = $true; break }
        Log "push attempt $i failed - retrying in 10s"
        Start-Sleep -Seconds 10
    }
    # Final safety: never leave the repo mid-rebase or mid-merge.
    if (Test-RebaseOrMergeInProgress) {
        Log "final safety: aborting leftover rebase/merge"
        if (Test-Path (Join-Path $repoRoot ".git\MERGE_HEAD")) { Run "git" @("merge", "--abort") | Out-Null }
        if ((Test-Path (Join-Path $repoRoot ".git\rebase-merge")) -or (Test-Path (Join-Path $repoRoot ".git\rebase-apply"))) {
            Run "git" @("rebase", "--abort") | Out-Null
        }
    }
    if (-not $pushed) { Log "WARNING: could not push data to GitHub after 3 attempts (next run will retry)" }
} else {
    Log "no data changes to commit"
}

Log "=== BB local run done ==="
