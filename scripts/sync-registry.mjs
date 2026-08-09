#!/usr/bin/env node
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(root, "public", "r");
const targetDir = path.join(root, "apps", "www", "public", "r");

function runBuildRegistry() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/build-registry.mjs"], {
      cwd: root,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`build-registry.mjs exited with code ${code}`));
      }
    });
  });
}

async function main() {
  await runBuildRegistry();
  await rm(targetDir, { recursive: true, force: true });
  await mkdir(path.dirname(targetDir), { recursive: true });
  await cp(sourceDir, targetDir, { recursive: true });
  console.log(`Synced registry → apps/www/public/r`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
