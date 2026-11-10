import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

/**
 * Zero-dependency repository lint for CareOps safety rules.
 * Deliberately small and explicit instead of adding a lint toolchain
 * (the repository keeps dependencies minimal and integrity-pinned).
 */

export interface LintFinding {
  file: string;
  line: number;
  rule: string;
  message: string;
}

interface Rule {
  id: string;
  message: string;
  appliesTo: (file: string) => boolean;
  pattern: RegExp;
}

const isSource = (file: string) => /\.(ts|js|mjs|cjs)$/.test(file);
const notLint = (file: string) => !file.startsWith("scripts/careops-lint.ts") && !file.startsWith("tests/careops-lint.test.ts");

export const RULES: readonly Rule[] = [
  {
    id: "runtime-neutral-src",
    message: "src/ must stay runtime-neutral (no node: imports); put Node-only code in server/",
    appliesTo: (file) => file.startsWith("src/") && file.endsWith(".ts"),
    pattern: /from\s+["']node:/,
  },
  {
    id: "no-html-injection",
    message: "Build DOM with textContent; HTML string sinks are forbidden",
    // demo/responder-console renders only hard-coded synthetic data and is
    // a documented exception (docs/careops-staging.md); live UIs are checked.
    appliesTo: (file) => (file.startsWith("web/") || file.startsWith("src/console-web/")) && isSource(file),
    pattern: /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML\s*\(|document\.write\s*\(/,
  },
  {
    id: "no-dynamic-code",
    message: "eval / new Function are forbidden",
    appliesTo: (file) => isSource(file) && notLint(file),
    pattern: /\beval\s*\(|new\s+Function\s*\(/,
  },
  {
    id: "no-browser-token-storage",
    message: "Do not persist tokens or care data in browser storage",
    appliesTo: (file) => file.startsWith("web/") && isSource(file),
    pattern: /\b(localStorage|sessionStorage|indexedDB)\b|document\.cookie/,
  },
  {
    id: "no-console-in-runtime",
    message: "Runtime code must not use console.* (risk of logging care data); use the structured logger",
    appliesTo: (file) => (file.startsWith("src/") || file.startsWith("server/")) && isSource(file),
    pattern: /\bconsole\.(log|info|debug|warn|error|dir|table)\s*\(/,
  },
  {
    id: "no-focused-tests",
    message: "Focused or skipped-by-mistake tests (.only) are not allowed",
    appliesTo: (file) => file.startsWith("tests/") && isSource(file) && notLint(file),
    pattern: /\btest\.only\s*\(|\bdescribe\.only\s*\(|\bit\.only\s*\(/,
  },
];

export const SECRET_PATTERNS: ReadonlyArray<{ id: string; pattern: RegExp }> = [
  { id: "private-key", pattern: /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { id: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { id: "supabase-secret-key", pattern: /\bsb_secret_[A-Za-z0-9_-]{16,}/ },
  { id: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { id: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { id: "postgres-url-with-password", pattern: /postgres(ql)?:\/\/[^:\s/]+:[^@\s$]{6,}@(?!localhost|127\.0\.0\.1)/ },
];

const SECRET_EXEMPT = (file: string) =>
  file === "package-lock.json" || file.endsWith(".png") || file.endsWith(".jpg") || !notLint(file);

export function lintText(file: string, text: string): LintFinding[] {
  const findings: LintFinding[] = [];
  const lines = text.split("\n");
  for (const rule of RULES) {
    if (!rule.appliesTo(file)) continue;
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
      if (rule.pattern.test(line)) findings.push({ file, line: index + 1, rule: rule.id, message: rule.message });
    });
  }
  if (!SECRET_EXEMPT(file)) {
    lines.forEach((line, index) => {
      for (const secret of SECRET_PATTERNS) {
        if (secret.pattern.test(line)) {
          // Never print the matched value.
          findings.push({ file, line: index + 1, rule: `secret:${secret.id}`, message: "Possible secret committed" });
        }
      }
    });
  }
  return findings;
}

export async function lintRepository(): Promise<LintFinding[]> {
  const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    .split("\u0000")
    .filter(Boolean);
  const findings: LintFinding[] = [];
  for (const file of files) {
    if (/\.(png|jpg|jpeg|gif|ico|woff2?)$/.test(file)) continue;
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    findings.push(...lintText(file, text));
  }
  return findings;
}

if (process.argv[1]?.endsWith("careops-lint.ts")) {
  const findings = await lintRepository();
  for (const finding of findings) {
    process.stderr.write(`${finding.file}:${finding.line} [${finding.rule}] ${finding.message}\n`);
  }
  process.stdout.write(`careops-lint: ${findings.length} finding(s)\n`);
  if (findings.length > 0) process.exitCode = 1;
}
