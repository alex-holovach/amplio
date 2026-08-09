import fs from "node:fs/promises";
import path from "node:path";
import type { RegistryItem } from "./types.js";
import { readRegistryFileContent } from "./resolve.js";
import { readAmplioConfig } from "../utils/config.js";
import { getCliVersion } from "../utils/cli-version.js";
import {
  detectPackageManager,
  type PackageManager,
} from "../utils/detect-package-manager.js";
import { ensureDir, pathExists, writeFileOrSkip } from "../utils/fs.js";
import { resolveProjectPaths } from "../utils/paths.js";

export interface InstallOptions {
  cwd: string;
  registryPath: string;
  telemetryDir?: string;
  force?: boolean;
}

export interface InstallResult {
  created: string[];
  updated: string[];
  skipped: string[];
}

function resolveTargetPath(
  cwd: string,
  telemetryDir: string,
  target: string,
): string {
  if (target.startsWith("~/")) {
    return path.join(path.resolve(cwd, telemetryDir), target.slice(2));
  }
  if (target.startsWith("telemetry/")) {
    return path.join(cwd, target);
  }
  return path.join(path.resolve(cwd, telemetryDir), target);
}

export async function installRegistryItem(
  item: RegistryItem,
  options: InstallOptions,
): Promise<InstallResult> {
  const telemetryDir = options.telemetryDir ?? "telemetry";
  const result: InstallResult = { created: [], updated: [], skipped: [] };

  for (const file of item.files) {
    if (!file.target) {
      continue;
    }

    const content = await readRegistryFileContent(
      options.registryPath,
      file.path,
      file.content,
    );

    const targetPath = resolveTargetPath(options.cwd, telemetryDir, file.target);
    await ensureDir(path.dirname(targetPath));

    const status = await writeFileOrSkip(targetPath, content, options.force ?? false);
    if (status === "created") {
      result.created.push(targetPath);
    } else if (status === "updated") {
      result.updated.push(targetPath);
    } else {
      result.skipped.push(targetPath);
    }
  }

  return result;
}

function splitDep(dep: string): { name: string; version: string | null } {
  const atIndex = dep.lastIndexOf("@");
  if (atIndex <= 0) {
    return { name: dep, version: null };
  }
  return { name: dep.slice(0, atIndex), version: dep.slice(atIndex + 1) };
}

function resolveDefaultVersion(name: string): string {
  if (name === "@useamplio/amplio") {
    return `^${getCliVersion()}`;
  }
  if (name === "zod") {
    return "^3.24.0 || ^4.0.0";
  }
  console.log(
    `note: registry dependency "${name}" has no pinned version — using "*". Consider pinning in the registry item.`,
  );
  return "*";
}

async function resolvePackageManager(cwd: string): Promise<PackageManager> {
  const config = await readAmplioConfig(cwd);
  return config?.packageManager ?? (await detectPackageManager(cwd));
}

export async function mergePackageDependencies(
  cwd: string,
  dependencies: string[] = [],
  devDependencies: string[] = [],
): Promise<boolean> {
  const pkgPath = path.join(cwd, "package.json");
  if (!(await pathExists(pkgPath))) {
    return false;
  }

  const pkgRaw = await fs.readFile(pkgPath, "utf8");
  const pkg = JSON.parse(pkgRaw) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  pkg.dependencies ??= {};
  pkg.devDependencies ??= {};

  const existing = new Set([
    ...Object.keys(pkg.dependencies),
    ...Object.keys(pkg.devDependencies),
  ]);

  let changed = false;

  for (const dep of dependencies) {
    const { name, version } = splitDep(dep);
    if (existing.has(name)) {
      continue;
    }
    const resolved = version ?? resolveDefaultVersion(name);
    pkg.dependencies[name] = resolved;
    existing.add(name);
    changed = true;
  }

  for (const dep of devDependencies) {
    const { name, version } = splitDep(dep);
    if (existing.has(name)) {
      continue;
    }
    const resolved = version ?? resolveDefaultVersion(name);
    pkg.devDependencies[name] = resolved;
    existing.add(name);
    changed = true;
  }

  if (!changed) {
    return false;
  }

  await fs.writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");

  const pm = await resolvePackageManager(cwd);
  console.log(`\nRun: ${pm} install`);
  return true;
}

export function projectPathsFromOptions(cwd: string, telemetryDir?: string) {
  return resolveProjectPaths(cwd, telemetryDir);
}
