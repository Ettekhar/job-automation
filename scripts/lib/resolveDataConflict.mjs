// Auto-resolves git rebase conflicts for the generated data files.
//
// Used by scripts/bb-local-run.ps1 when a local data push collides with a
// GitHub Actions data push. During a rebase:
//   stage 2 ("ours")   = the new base       = the GitHub side
//   stage 3 ("theirs") = the replayed commit = this PC's freshly scraped data
//
// Resolution rules:
//   - *seen-jobs.json      : UNION of both sides. This list decides which jobs
//                            were already alerted, so losing either side could
//                            re-send an email for an old job.
//   - *scrape-history.json : UNION by id, newest first, capped at 100 entries
//                            (matches the scraper's own cap).
//   - everything else      : keep this PC's side ("theirs"); fall back to the
//                            GitHub side if this PC's side deleted the file.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const git = (args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function readStage(stage, file) {
  try {
    return git(["show", `:${stage}:${file}`]);
  } catch {
    return null;
  }
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

let conflicted = [];
try {
  conflicted = git(["diff", "--name-only", "--diff-filter=U"])
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
} catch {
  conflicted = [];
}

if (conflicted.length === 0) {
  console.log("no conflicted files");
  process.exit(0);
}

for (const file of conflicted) {
  const name = file.replace(/\\/g, "/");

  if (name.endsWith("seen-jobs.json")) {
    const ours = parseJson(readStage(2, file)) || [];
    const theirs = parseJson(readStage(3, file)) || [];
    const union = [...new Set([...ours, ...theirs])];
    writeFileSync(file, JSON.stringify(union, null, 2) + "\n");
    git(["add", "--", file]);
    console.log(`union-merged ${name} (${ours.length} + ${theirs.length} -> ${union.length})`);
    continue;
  }

  if (name.endsWith("scrape-history.json")) {
    const ours = parseJson(readStage(2, file)) || [];
    const theirs = parseJson(readStage(3, file)) || [];
    const byId = new Map();
    for (const entry of [...ours, ...theirs]) {
      if (entry && entry.id) byId.set(entry.id, entry);
    }
    const union = [...byId.values()]
      .sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")))
      .slice(0, 100);
    writeFileSync(file, JSON.stringify(union, null, 2) + "\n");
    git(["add", "--", file]);
    console.log(`union-merged ${name} (${ours.length} + ${theirs.length} -> ${union.length})`);
    continue;
  }

  // Keep this PC's freshly scraped content; fall back to the GitHub side.
  let kept = null;
  try {
    git(["checkout", "--theirs", "--", file]);
    kept = "theirs";
  } catch {
    try {
      git(["checkout", "--ours", "--", file]);
      kept = "ours";
    } catch {
      kept = null;
    }
  }
  try {
    git(["add", "--", file]);
  } catch {
    // leave as-is; the caller falls back to aborting the rebase if it can't finish
  }
  console.log(`${kept ? "kept " + kept : "staged as-is"} for ${name}`);
}

console.log("conflicts resolved");
