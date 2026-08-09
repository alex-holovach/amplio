import { readFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const bundlePath = join(root, "../dist/index.js");
const targetBytes = 8 * 1024;

const source = readFileSync(bundlePath);
const gzipped = gzipSync(source);
const raw = statSync(bundlePath).size;

const fmt = (n) => `${(n / 1024).toFixed(2)} KB`;

console.log(`@useamplio/amplio bundle size`);
console.log(`  raw:   ${fmt(raw)} (${raw} bytes)`);
console.log(`  gzip:  ${fmt(gzipped.length)} (${gzipped.length} bytes)`);
console.log(`  target gzip: < ${fmt(targetBytes)}`);

if (gzipped.length >= targetBytes) {
  console.error(`FAIL: gzip size exceeds ${targetBytes} bytes`);
  process.exit(1);
}

console.log("PASS");
