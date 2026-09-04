import "dotenv/config";
import { runScraper } from "./lib/scraperCore.mjs";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run") || process.env.DRY_RUN === "1";
const IGNORE_SEEN = args.includes("--ignore-seen") || process.env.IGNORE_SEEN === "1";
const VERBOSE = args.includes("--verbose") || process.env.VERBOSE === "1";

runScraper({
  dryRun: DRY_RUN,
  ignoreSeen: IGNORE_SEEN,
  verbose: VERBOSE,
}).catch((err) => {
  console.error("Scraper terminated with error:", err);
  process.exit(1);
});
