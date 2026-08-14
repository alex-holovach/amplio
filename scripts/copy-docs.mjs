import { cp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageDir = process.argv[2];

if (!packageDir) {
  console.error("Usage: node scripts/copy-docs.mjs <package-dir>");
  process.exit(1);
}

const dest = path.resolve(packageDir);
const docsSrc = path.join(repoRoot, "docs");
const docsDest = path.join(dest, "docs");

await rm(docsDest, { recursive: true, force: true });
await cp(docsSrc, docsDest, { recursive: true });
console.log(`Copied docs/ → ${path.relative(repoRoot, dest)}/`);
