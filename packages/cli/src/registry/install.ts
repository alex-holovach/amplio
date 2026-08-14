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
import {
  normalizeGeneratedLocalImports,
  usesExtensionlessGeneratedImports,
} from "../utils/generated-imports.js";
import {
  isCanonicallyWithin,
  isPathWithin,
  isPortableAbsolute,
} from "../utils/path-containment.js";
import { resolveProjectPaths } from "../utils/paths.js";

export interface InstallOptions {
  cwd: string;
  registryPath: string;
  telemetryDir?: string;
  force?: boolean;
  /** Compute created/updated/skipped without writing anything. */
  dryRun?: boolean;
}

export interface InstallResult {
  created: string[];
  updated: string[];
  skipped: string[];
}

interface PlannedRegistryFile {
  content: string;
  targetPath: string;
}

async function resolveTargetPath(
  cwd: string,
  telemetryDir: string,
  target: string,
): Promise<string> {
  const projectRoot = path.resolve(cwd);
  if (
    target.length === 0 ||
    target.includes("\\") ||
    isPortableAbsolute(target) ||
    path.posix.normalize(target) !== target ||
    target.split("/").some((segment) => segment === ".." || segment === ".")
  ) {
    throw new Error(
      `Registry target "${target}" escapes the project root; no files were changed.`,
    );
  }
  let targetPath: string;
  if (target.startsWith("~/")) {
    targetPath = path.resolve(projectRoot, target.slice(2));
  } else if (target.startsWith("telemetry/")) {
    targetPath = path.resolve(projectRoot, target);
  } else {
    targetPath = path.resolve(projectRoot, telemetryDir, target);
  }
  if (!isPathWithin(projectRoot, targetPath)) {
    throw new Error(
      `Registry target "${target}" escapes the project root; no files were changed.`,
    );
  }

  try {
    if (!(await isCanonicallyWithin(projectRoot, targetPath))) {
      throw new Error(
        `Registry target "${target}" resolves through a symlink outside the project root; no files were changed.`,
      );
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("outside the project root")
    ) {
      throw error;
    }
    throw new Error(
      `Registry target "${target}" resolves through an invalid symlink or unreadable path; no files were changed.`,
      { cause: error },
    );
  }
  return targetPath;
}

async function planRegistryItem(
  item: RegistryItem,
  options: InstallOptions,
  extensionlessLocalImports: boolean,
): Promise<PlannedRegistryFile[]> {
  const telemetryDir = options.telemetryDir ?? "telemetry";
  const plannedTargets: Array<{
    file: RegistryItem["files"][number];
    targetPath: string;
  }> = [];

  for (const file of item.files) {
    if (!file.target) {
      continue;
    }
    plannedTargets.push({
      file,
      targetPath: await resolveTargetPath(
        options.cwd,
        telemetryDir,
        file.target,
      ),
    });
  }

  const plan: PlannedRegistryFile[] = [];
  for (const { file, targetPath } of plannedTargets) {
    const content = normalizeGeneratedLocalImports(
      await readRegistryFileContent(
        options.registryPath,
        file.path,
        file.content,
      ),
      extensionlessLocalImports,
    );
    plan.push({ content, targetPath });
  }
  return plan;
}

export async function installRegistryItems(
  items: RegistryItem[],
  options: InstallOptions,
): Promise<InstallResult> {
  // Resolve every source and destination in the dependency closure before the
  // first write, so a hostile later recipe cannot leave a partial install.
  const extensionlessLocalImports = await usesExtensionlessGeneratedImports(
    options.cwd,
  );
  const plan: PlannedRegistryFile[] = [];
  for (const item of items) {
    plan.push(
      ...(await planRegistryItem(item, options, extensionlessLocalImports)),
    );
  }

  const result: InstallResult = { created: [], updated: [], skipped: [] };
  for (const { content, targetPath } of plan) {
    let status: "created" | "updated" | "skipped";
    if (options.dryRun) {
      // Mirror writeFileOrSkip's decision without touching the filesystem.
      const exists = await pathExists(targetPath);
      status = exists
        ? (options.force ?? false)
          ? "updated"
          : "skipped"
        : "created";
    } else {
      await ensureDir(path.dirname(targetPath));
      status = await writeFileOrSkip(
        targetPath,
        content,
        options.force ?? false,
      );
    }
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

export async function installRegistryItem(
  item: RegistryItem,
  options: InstallOptions,
): Promise<InstallResult> {
  return installRegistryItems([item], options);
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
  dryRun = false,
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

  const addedRuntimeNames: string[] = [];
  const movedRuntimeNames: string[] = [];
  const addedDevelopmentNames: string[] = [];

  for (const dep of dependencies) {
    const { name, version } = splitDep(dep);
    if (pkg.dependencies[name] !== undefined) {
      if (pkg.devDependencies[name] !== undefined) {
        delete pkg.devDependencies[name];
        movedRuntimeNames.push(name);
      }
      continue;
    }
    if (pkg.devDependencies[name] !== undefined) {
      pkg.dependencies[name] = pkg.devDependencies[name];
      delete pkg.devDependencies[name];
      movedRuntimeNames.push(name);
      continue;
    }
    pkg.dependencies[name] = version ?? resolveDefaultVersion(name);
    addedRuntimeNames.push(name);
  }

  for (const dep of devDependencies) {
    const { name, version } = splitDep(dep);
    if (
      pkg.dependencies[name] !== undefined ||
      pkg.devDependencies[name] !== undefined
    ) {
      continue;
    }
    pkg.devDependencies[name] = version ?? resolveDefaultVersion(name);
    addedDevelopmentNames.push(name);
  }

  const addedNames = [...addedRuntimeNames, ...addedDevelopmentNames];
  if (addedNames.length === 0 && movedRuntimeNames.length === 0) {
    return false;
  }

  if (dryRun) {
    if (addedNames.length > 0) {
      console.log(`  ~ package.json (would add: ${addedNames.join(", ")})`);
    }
    if (movedRuntimeNames.length > 0) {
      console.log(
        `  ~ package.json (would move ${movedRuntimeNames.join(", ")} from devDependencies to dependencies)`,
      );
    }
    return false;
  }

  const pm = await resolvePackageManager(cwd);
  await fs.writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
  console.log(`\nRun: ${pm} install`);
  return true;
}

export function projectPathsFromOptions(cwd: string, telemetryDir?: string) {
  return resolveProjectPaths(cwd, telemetryDir);
}
