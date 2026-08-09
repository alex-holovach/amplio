#!/usr/bin/env node
import { access, cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const wwwRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const monorepoRoot = path.resolve(wwwRoot, "../..");
const targetDir = path.join(wwwRoot, "public", "r");
const registryMarker = path.join(targetDir, "registry.json");

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function runNodeScript(scriptPath, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${scriptPath} exited with code ${code}`));
    });
  });
}

async function main() {
  const monorepoSync = path.join(monorepoRoot, "scripts", "sync-registry.mjs");
  const monorepoBuild = path.join(monorepoRoot, "scripts", "build-registry.mjs");

  if (await exists(monorepoSync)) {
    await runNodeScript(monorepoSync, monorepoRoot);
    return;
  }

  if (await exists(monorepoBuild)) {
    await runNodeScript(monorepoBuild, monorepoRoot);
    const sourceDir = path.join(monorepoRoot, "public", "r");
    await rm(targetDir, { recursive: true, force: true });
    await mkdir(path.dirname(targetDir), { recursive: true });
    await cp(sourceDir, targetDir, { recursive: true });
    console.log("Synced registry → apps/www/public/r");
    return;
  }

  if (await exists(registryMarker)) {
    console.log("Registry already present in public/r — skipping sync");
    return;
  }

  throw new Error(
    "Cannot sync registry: run from monorepo root or ensure public/r/registry.json exists",
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
