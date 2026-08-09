import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathExists } from "./fs.js";

export type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

const RUNTIME_PACKAGES = ["@useamplio/amplio", "zod"] as const;

type PackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

async function readPackageJson(cwd: string): Promise<PackageJson | null> {
  const pkgPath = path.join(cwd, "package.json");
  if (!(await pathExists(pkgPath))) {
    return null;
  }
  return JSON.parse(await fs.readFile(pkgPath, "utf8")) as PackageJson;
}

function missingPackages(pkg: PackageJson): string[] {
  const installed = {
    ...pkg.dependencies,
    ...pkg.devDependencies,
  };
  return RUNTIME_PACKAGES.filter((name) => installed[name] === undefined);
}

function installArgs(pm: PackageManager, packages: string[]): string[] {
  switch (pm) {
    case "npm":
      return ["install", ...packages];
    case "yarn":
      return ["add", ...packages];
    case "bun":
      return ["add", ...packages];
    case "pnpm":
    default:
      return ["add", ...packages];
  }
}

export async function ensureRuntimeDependencies(options: {
  cwd: string;
  packageManager: PackageManager;
  skipInstall?: boolean;
}): Promise<"installed" | "present" | "skipped" | "manual"> {
  const pm = options.packageManager;
  const pkg = await readPackageJson(options.cwd);

  if (!pkg) {
    console.log("\nInstall runtime deps (no package.json found):");
    console.log(`  ${pm} add ${RUNTIME_PACKAGES.join(" ")}`);
    return "manual";
  }

  const missing = missingPackages(pkg);
  if (missing.length === 0) {
    console.log("\n  · @useamplio/amplio and zod already in package.json");
    return "present";
  }

  if (options.skipInstall) {
    console.log("\nInstall runtime deps:");
    console.log(`  ${pm} add ${missing.join(" ")}`);
    return "skipped";
  }

  console.log(`\nInstalling ${missing.join(", ")} with ${pm}…`);
  const result = spawnSync(pm, installArgs(pm, missing), {
    cwd: options.cwd,
    stdio: "inherit",
    env: process.env,
  });

  if (result.error || result.status !== 0) {
    console.log("\nAutomatic install failed. Run:");
    console.log(`  ${pm} add ${missing.join(" ")}`);
    return "manual";
  }

  console.log(`  ✓ installed ${missing.join(", ")}`);
  return "installed";
}
