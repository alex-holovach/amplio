import fs from "node:fs/promises";
import path from "node:path";
import type { RegistryItem } from "./types.js";
import { readRegistryFileContent } from "./resolve.js";
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

export async function mergePackageDependencies(
  cwd: string,
  dependencies: string[] = [],
  devDependencies: string[] = [],
): Promise<void> {
  const pkgPath = path.join(cwd, "package.json");
  if (!(await pathExists(pkgPath))) {
    return;
  }

  const pkgRaw = await fs.readFile(pkgPath, "utf8");
  const pkg = JSON.parse(pkgRaw) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  pkg.dependencies ??= {};
  pkg.devDependencies ??= {};

  for (const dep of dependencies) {
    const atIndex = dep.lastIndexOf("@");
    const name = atIndex > 0 ? dep.slice(0, atIndex) : dep;
    const version = atIndex > 0 ? dep.slice(atIndex + 1) : "*";
    pkg.dependencies[name] = version;
  }

  for (const dep of devDependencies) {
    const atIndex = dep.lastIndexOf("@");
    const name = atIndex > 0 ? dep.slice(0, atIndex) : dep;
    const version = atIndex > 0 ? dep.slice(atIndex + 1) : "*";
    pkg.devDependencies[name] = version;
  }

  await fs.writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
}

export function projectPathsFromOptions(cwd: string, telemetryDir?: string) {
  return resolveProjectPaths(cwd, telemetryDir);
}
