import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathExists } from "./fs.js";

export type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

const RUNTIME_PACKAGES = ["@useamplio/amplio", "zod"] as const;
const CLI_PACKAGE = "@useamplio/cli";

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

function missingPackages(pkg: PackageJson, names: readonly string[]): string[] {
  const installed = {
    ...pkg.dependencies,
    ...pkg.devDependencies,
  };
  return names.filter((name) => installed[name] === undefined);
}

export function installCommand(pm: PackageManager, packages: string[], dev = false): string {
  return [pm, ...installArgs(pm, packages, dev)].join(" ");
}

// npm gets --no-audit --no-fund so the inner install doesn't dump audit noise
// into the middle of amplio's own checklist output.
function installArgs(pm: PackageManager, packages: string[], dev = false): string[] {
  switch (pm) {
    case "npm":
      return ["install", ...(dev ? ["-D"] : []), ...packages, "--no-audit", "--no-fund"];
    case "yarn":
      return ["add", ...(dev ? ["-D"] : []), ...packages];
    case "bun":
      return ["add", ...(dev ? ["-d"] : []), ...packages];
    case "pnpm":
    default:
      return ["add", ...(dev ? ["-D"] : []), ...packages];
  }
}

function runInstall(
  pm: PackageManager,
  cwd: string,
  packages: string[],
  dev: boolean,
): boolean {
  const result = spawnSync(pm, installArgs(pm, packages, dev), {
    cwd,
    stdio: "inherit",
    env: process.env,
  });
  return !result.error && result.status === 0;
}

export async function ensureRuntimeDependencies(options: {
  cwd: string;
  packageManager: PackageManager;
  skipInstall?: boolean;
  /** Also install @useamplio/cli as a devDependency (init does this so the "amplio" npm script works out of the box). */
  withCliDevDependency?: boolean;
}): Promise<"installed" | "present" | "skipped" | "manual"> {
  const pm = options.packageManager;
  const pkg = await readPackageJson(options.cwd);

  if (!pkg) {
    console.log("\nInstall runtime deps (no package.json found):");
    console.log(`  ${installCommand(pm, [...RUNTIME_PACKAGES])}`);
    return "manual";
  }

  const missing = missingPackages(pkg, RUNTIME_PACKAGES);
  const missingCli = options.withCliDevDependency
    ? missingPackages(pkg, [CLI_PACKAGE])
    : [];

  if (missing.length === 0 && missingCli.length === 0) {
    console.log(
      `\n  · ${RUNTIME_PACKAGES.join(" and ")}${options.withCliDevDependency ? ` (and ${CLI_PACKAGE})` : ""} already in package.json`,
    );
    return "present";
  }

  if (options.skipInstall) {
    console.log("\nInstall runtime deps:");
    if (missing.length > 0) {
      console.log(`  ${installCommand(pm, missing)}`);
    }
    if (missingCli.length > 0) {
      console.log(`  ${installCommand(pm, missingCli, true)}`);
    }
    return "skipped";
  }

  const parts = [
    ...missing,
    ...missingCli.map((name) => `${name} (dev)`),
  ];
  console.log(`\nInstalling ${parts.join(", ")} with ${pm}…`);

  let ok = missing.length === 0 || runInstall(pm, options.cwd, missing, false);
  if (ok && missingCli.length > 0) {
    ok = runInstall(pm, options.cwd, missingCli, true);
  }

  if (!ok) {
    console.log("\nAutomatic install failed. Run:");
    if (missing.length > 0) {
      console.log(`  ${installCommand(pm, missing)}`);
    }
    if (missingCli.length > 0) {
      console.log(`  ${installCommand(pm, missingCli, true)}`);
    }
    return "manual";
  }

  console.log(`  ✓ installed ${parts.join(", ")}`);
  return "installed";
}
