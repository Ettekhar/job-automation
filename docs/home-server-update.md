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

# 3) Rebuild and restart
docker compose up -d --build
```

Step 3 is only needed when `package.json` / `package-lock.json` changed;
otherwise `docker compose up -d` is enough. The app code is bind-mounted, so
code and data updates are visible without a rebuild.

## Verify after the update

Open the dashboard and check:

- total jobs is 500+ (it was ~190 before the update)
- searching "Petrobangla" lists `Sub Assistant Engineer(Computer/IT)` and
  `Assistant Manager(CSE/IT)`

## Email policy on this host (already configured)

The server is the **view/apply station** — it must never send its own
job-alert emails, or a job could reach your inbox twice (GitHub + PC are the
single source of alerts). This is enforced by a small untracked file next to
`docker-compose.yml`:

```yaml
# docker-compose.override.yml
services:
  job-automation:
    environment:
      - JOB_ALERTS_DISABLED=1
```

With this flag the app can still scan and highlight matches ("Scan now"), but
it will never email a job alert. The application-PDF email sent by the
1-click autofill is NOT affected.

Keep auto-scrape OFF anyway (dashboard -> Settings) — GitHub + the PC's
scheduled task are the only senders.

## Automatic freshness (already configured)

`~/scripts/sync-job-automation.sh` runs every 3 hours via cron:

    30 */3 * * * $HOME/scripts/sync-job-automation.sh

It pulls the newest code + data from GitHub (`server-live` branch). It never
scans and never emails. The dashboard reads the data files live, so new jobs
appear without a restart. If a future update changes dependencies, the script
rebuilds the Docker image automatically.

## Notes

- `.env` and `data/settings.json` are git-ignored: the commands never touch them.
- `docker-compose.override.yml` is untracked too — updates keep it.
- The old runtime data is kept in `../data-backup-<timestamp>/`.
