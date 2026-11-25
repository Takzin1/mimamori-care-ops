/**
 * Builds the public static Framework demo into dist/framework-demo and verifies it:
 *  - compiles the real engine + field UI (tsconfig.demo.json) to browser ES modules
 *  - writes styles.css and copies index.html / README.md
 *  - refuses unexpected file types, network APIs, and secret-like strings
 * Usage: node scripts/build-framework-demo.ts
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { FRAMEWORK_UI_CSS } from "../src/framework/ui/styles.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist", "framework-demo");
const demo = join(root, "demo", "mimamori-framework");

const ALLOWED_EXTENSIONS = new Set([".html", ".js", ".css", ".md"]);
const FORBIDDEN_CONTENT: Array<[string, RegExp]> = [
  ["network API", /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|\bsendBeacon\b|\bimportScripts\b/],
  ["service_role reference", /service_role/i],
  ["JWT-like token", /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./],
  ["Hugging Face token", /\bhf_[A-Za-z0-9]{20,}/],
  ["API key", /\bsk-[A-Za-z0-9_-]{20,}|\bAKIA[0-9A-Z]{16}\b|\bghp_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["Supabase project URL", /[a-z0-9]{20}\.supabase\.co/],
  ["LINE secret name", /LINE_CHANNEL_(SECRET|ACCESS_TOKEN)/],
  ["environment access", /process\.env/],
];
const REQUIRED_HTML = [
  "Synthetic demo only",
  "本番運用不可",
  "connect-src 'none'",
  "script-src 'self'",
  "実際の事故・災害・医療の判断や対応には使用できません",
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

export function verifyDemo(directory: string): { files: string[]; bytes: number } {
  const files = walk(directory);
  const problems: string[] = [];
  let bytes = 0;
  for (const file of files) {
    const rel = relative(directory, file);
    if (!ALLOWED_EXTENSIONS.has(extname(file))) problems.push(`${rel}: file type not allowed`);
    const text = readFileSync(file, "utf8");
    bytes += Buffer.byteLength(text);
    for (const [label, pattern] of FORBIDDEN_CONTENT) {
      if (pattern.test(text)) problems.push(`${rel}: contains ${label}`);
    }
  }
  const html = readFileSync(join(directory, "index.html"), "utf8");
  for (const needle of REQUIRED_HTML) {
    if (!html.includes(needle)) problems.push(`index.html: missing "${needle}"`);
  }
  if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(html) || /\sstyle=|<style/i.test(html)) problems.push("index.html: inline script/style");
  const entry = join(directory, "engine", "framework", "ui", "demo-entry.js");
  if (!files.includes(entry)) problems.push("engine entry missing");
  const readme = readFileSync(join(directory, "README.md"), "utf8");
  const front = readme.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  const meta = Object.fromEntries(front.split("\n").map((line) => line.split(/:\s*/, 2) as [string, string]));
  const colors = new Set(["red", "yellow", "green", "blue", "indigo", "purple", "pink", "gray"]);
  if (meta.sdk !== "static" || meta.app_file !== "index.html") problems.push("README.md: must be a static Space with app_file index.html");
  if (!colors.has(meta.colorFrom ?? "") || !colors.has(meta.colorTo ?? "")) problems.push("README.md: colorFrom/colorTo must be a Hub colour");
  if ((meta.short_description ?? "").length > 60) problems.push("README.md: short_description must be at most 60 characters");
  if (problems.length) throw new Error(`Demo verification failed:\n - ${problems.join("\n - ")}`);
  return { files: files.map((f) => relative(directory, f)).sort(), bytes };
}

export function buildDemo(target: string = out): { files: string[]; bytes: number } {
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  execFileSync(
    process.execPath,
    [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", join(root, "tsconfig.demo.json"), "--outDir", join(target, "engine")],
    { stdio: "inherit" },
  );
  writeFileSync(join(target, "styles.css"), FRAMEWORK_UI_CSS.trimStart());
  copyFileSync(join(demo, "index.html"), join(target, "index.html"));
  copyFileSync(join(demo, "README.md"), join(target, "README.md"));
  return verifyDemo(target);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = buildDemo();
  console.log(`Framework demo built: ${result.files.length} files, ${(result.bytes / 1024).toFixed(0)} KiB → ${relative(root, out)}`);
}
