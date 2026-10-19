# Updating the home server (Docker deployment)

The home server runs the **dashboard / apply-station** from the `server-live`
branch in Docker. That branch is now kept in sync with the latest `main`.

## Every update (run these ON THE HOME SERVER)

Open a terminal in the project folder on the home server and run:

```bash
# 1) Back up the current runtime data (jobs, history, seen list, settings)
cp -r data "../data-backup-$(date +%Y%m%d-%H%M%S)"

# 2) Get the latest code + data (keeps .env and data/settings.json,
#    which are not tracked by git)
git fetch origin
git checkout -f -B server-live origin/server-live

# 3) Rebuild and restart the container
docker compose up -d --build
# (older Docker: docker-compose up -d --build)
```

Open the dashboard afterwards and confirm:
- total jobs is 500+ (was ~190 before the update)
- searching "Petrobangla" shows Sub Assistant Engineer(Computer/IT) and
  Assistant Manager(CSE/IT)

## Important: avoid duplicate emails

This app has its **own** background scanner (dashboard -> Settings ->
auto-scrape) and its **own** "already sent" list, separate from the
GitHub + PC systems.

If it also runs scans, the same job can be emailed twice.

=> Keep **auto-scrape OFF** on this server. It is the view/apply station:
   GitHub + the PC's scheduled task are the only things that send email.

## Notes

- `.env` and `data/settings.json` are git-ignored: the commands above never
  touch them.
- The old runtime data is preserved in `../data-backup-<timestamp>/` in case
  you ever need something from it.
