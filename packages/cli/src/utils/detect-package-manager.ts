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

const LOCKFILES_BY_PM: Record<PackageManager, readonly string[]> = {
  pnpm: ["pnpm-lock.yaml"],
  npm: ["package-lock.json"],
  yarn: ["yarn.lock"],
  bun: ["bun.lock", "bun.lockb"],
};

function parsePackageManagerField(value: string): PackageManager | null {
  const prefix = value.split("@")[0]?.trim().toLowerCase();
  if (
    prefix === "pnpm" ||
    prefix === "npm" ||
    prefix === "yarn" ||
    prefix === "bun"
  ) {
    return prefix;
  }
  return null;
}

async function readPackageJson(
  directory: string,
): Promise<{ packageManager?: string; workspaces?: unknown } | undefined> {
  const pkgPath = path.join(directory, "package.json");
  if (await pathExists(pkgPath)) {
    try {
      return JSON.parse(await readFile(pkgPath, "utf8")) as {
        packageManager?: string;
        workspaces?: unknown;
      };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function parentDirectory(directory: string): string | undefined {
  const parent = path.dirname(directory);
  return parent === directory ? undefined : parent;
}

export async function detectPackageManager(
  cwd: string,
): Promise<PackageManager> {
  let directory: string | undefined = path.resolve(cwd);
  while (directory) {
    const pkg = await readPackageJson(directory);
    if (pkg?.packageManager) {
      const fromField = parsePackageManagerField(pkg.packageManager);
      if (fromField) return fromField;
    }

    for (const [lockfile, pm] of LOCKFILE_PM) {
      if (await pathExists(path.join(directory, lockfile))) return pm;
    }

    if (await pathExists(path.join(directory, ".git"))) break;
    directory = parentDirectory(directory);
  }

  return "pnpm";
}

/** Finds the nearest ancestor whose metadata makes it the manager's lock root. */
export async function findPackageManagerRoot(
  cwd: string,
  packageManager: PackageManager,
): Promise<string> {
  const lockfiles = packageManagerLockfiles(packageManager);
  const project = path.resolve(cwd);
  let declaredRoot: string | undefined;
  let directory: string | undefined = project;
  while (directory) {
    const pkg = await readPackageJson(directory);
    const declared = pkg?.packageManager
      ? parsePackageManagerField(pkg.packageManager)
      : null;
    if (declared === packageManager && declaredRoot === undefined) {
      declaredRoot = directory;
    }
    if (
      await Promise.all(
        lockfiles.map((lockfile) =>
          pathExists(path.join(directory!, lockfile)),
        ),
      ).then((matches) => matches.some(Boolean))
    ) {
      return directory;
    }
    if (
      (packageManager === "pnpm" &&
        (await pathExists(path.join(directory, "pnpm-workspace.yaml")))) ||
      pkg?.workspaces !== undefined
    ) {
      return directory;
    }

    if (await pathExists(path.join(directory, ".git"))) break;
    directory = parentDirectory(directory);
  }
  return declaredRoot ?? project;
}

export function packageManagerLockfiles(
  packageManager: PackageManager,
): readonly string[] {
  const lockfiles = (
    LOCKFILES_BY_PM as Partial<Record<string, readonly string[]>>
  )[packageManager];
  if (!lockfiles) {
    throw new Error(
      `Dependencies setup aborted before writing files: unsupported package manager "${String(packageManager)}". Expected one of pnpm, npm, yarn, or bun. No files were changed.`,
    );
  }
  return lockfiles;
}
