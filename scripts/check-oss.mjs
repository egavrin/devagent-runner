import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const requiredFiles = [
  "README.md",
  "LICENSE",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "SECURITY.md",
  "SUPPORT.md",
  "AGENTS.md",
  "REVIEW.md",
  "WORKFLOW.md",
  ".github/ISSUE_TEMPLATE/bug_report.md",
  ".github/ISSUE_TEMPLATE/feature_request.md",
  ".github/pull_request_template.md",
];

const docsToScan = [
  "README.md",
  "CONTRIBUTING.md",
  "AGENTS.md",
  "REVIEW.md",
  "WORKFLOW.md",
  "SECURITY.md",
  "SUPPORT.md",
];

const forbidden = ["/Users/", "devagent workflow run", "workflow run --phase", "devagent-hub ui", "devagent-hub tui"];

const missing = requiredFiles.filter((file) => !existsSync(join(root, file)));
if (missing.length > 0) {
  console.error(`Missing required OSS files:\n- ${missing.join("\n- ")}`);
  process.exit(1);
}

for (const file of docsToScan) {
  const body = readFileSync(join(root, file), "utf8");
  for (const pattern of forbidden) {
    if (body.includes(pattern)) {
      console.error(`Forbidden public-docs reference "${pattern}" found in ${file}`);
      process.exit(1);
    }
  }
}

console.log("OSS readiness checks passed.");
