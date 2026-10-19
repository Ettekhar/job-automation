# Updating the home server (Docker deployment)

The home server runs the **dashboard / apply-station** from the `server-live`
branch in Docker. That branch is kept in sync with the latest `main`.

## Every update (run these ON THE HOME SERVER)

Open a terminal in the project folder on the home server:

```bash
# 1) Back up the current runtime data (jobs, history, seen list, settings)
cp -r data "../data-backup-$(date +%Y%m%d-%H%M%S)"

# 2) Get the latest code + data. .env and data/settings.json are not tracked
#    by git, so they are kept as they are.
git fetch origin
git checkout -f -B server-live origin/server-live

# 3) Keep the app's OWN scanner off (duplicate-email protection).
#    Linux / macOS / WSL:
grep -n autoScrapeEnabled data/settings.json 2>/dev/null || echo "no settings.json -> scanner is off by default"
sed -i 's/"autoScrapeEnabled": *true/"autoScrapeEnabled": false/' data/settings.json 2>/dev/null || true

# 4) Rebuild and restart
docker compose up -d --build        # older Docker: docker-compose up -d --build
```

On Windows PowerShell, step 3 is instead:

```powershell
(Get-Content data\settings.json) -replace '"autoScrapeEnabled": *true','"autoScrapeEnabled": false' | Set-Content data\settings.json
```

(or simply open the dashboard -> Settings and switch auto-scrape off).

## Verify after the update

Open the dashboard and check:

- total jobs is 500+ (it was ~190 before the update)
- searching "Petrobangla" lists `Sub Assistant Engineer(Computer/IT)` and
  `Assistant Manager(CSE/IT)`

## Why keep its scanner off

This app has its **own** background scanner (dashboard -> Settings ->
auto-scrape) and its **own** "already sent" list, separate from the
GitHub + PC systems. If it also runs scans, the same job can be emailed
twice. GitHub + the PC's scheduled task are the only senders.

## Notes

- `.env` and `data/settings.json` are git-ignored: the commands never touch them.
- The old runtime data is kept in `../data-backup-<timestamp>/`.
