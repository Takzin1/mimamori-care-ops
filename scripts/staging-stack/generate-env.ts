import { appendFile } from "node:fs/promises";

import { generateStackSecrets } from "./stack.ts";

/**
 * Generates per-run secrets for the staging-equivalent stack.
 * In GitHub Actions the values are masked and appended to $GITHUB_ENV;
 * they exist only for the lifetime of the job.
 */
const secrets = generateStackSecrets();
const target = process.env.GITHUB_ENV;
if (!target) {
  process.stderr.write("GITHUB_ENV is not set; refusing to print secrets to stdout\n");
  process.exitCode = 1;
} else {
  for (const value of Object.values(secrets)) process.stdout.write(`::add-mask::${value}\n`);
  await appendFile(target, Object.entries(secrets).map(([key, value]) => `${key}=${value}`).join("\n") + "\n");
  process.stdout.write(`generated ${Object.keys(secrets).length} stack secrets\n`);
}
