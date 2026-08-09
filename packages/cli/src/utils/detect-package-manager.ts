import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "./fs.js";

export type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

const LOCKFILE_PM: Array<[string, PackageManager]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["package-lock.json", "npm"],
  ["yarn.lock", "yarn"],
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
];

function parsePackageManagerField(value: string): PackageManager | null {
  const prefix = value.split("@")[0]?.trim().toLowerCase();
  if (prefix === "pnpm" || prefix === "npm" || prefix === "yarn" || prefix === "bun") {
    return prefix;
  }
  return null;
}

export async function detectPackageManager(cwd: string): Promise<PackageManager> {
  const pkgPath = path.join(cwd, "package.json");
  if (await pathExists(pkgPath)) {
    try {
      const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as {
        packageManager?: string;
      };
      if (pkg.packageManager) {
        const fromField = parsePackageManagerField(pkg.packageManager);
        if (fromField) {
          return fromField;
        }
      }
    } catch {
      // fall through to lockfiles
    }
  }

  for (const [lockfile, pm] of LOCKFILE_PM) {
    if (await pathExists(path.join(cwd, lockfile))) {
      return pm;
    }
  }

  return "pnpm";
}
