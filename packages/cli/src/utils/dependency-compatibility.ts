import fs from "node:fs/promises";
import path from "node:path";
import { satisfies, subset, valid, validRange } from "semver";

const INSTALLED_VERSION_SPECS = /^(?:workspace|file|catalog):/;

async function readInstalledDependencyVersion(
  cwd: string,
  dependencyName: string,
): Promise<{ packagePath: string; version?: string }> {
  const packagePath = path.join(
    cwd,
    "node_modules",
    dependencyName,
    "package.json",
  );
  try {
    const installedPackage = JSON.parse(
      await fs.readFile(packagePath, "utf8"),
    ) as Record<string, unknown>;
    return {
      packagePath,
      ...(typeof installedPackage.version === "string"
        ? { version: installedPackage.version }
        : {}),
    };
  } catch {
    return { packagePath };
  }
}

export async function assertDependencyCompatibility(options: {
  cwd: string;
  packageJson: Record<string, unknown>;
  dependencyName: string;
  supportedRange: string;
  label: string;
  allowMissing: boolean;
  /** Tooling such as @useamplio/cli may be declared in devDependencies. Runtime requirements must leave this false. */
  allowDevDependency?: boolean;
  incompatibleAction?: string;
}): Promise<void> {
  const {
    cwd,
    packageJson,
    dependencyName,
    supportedRange,
    label,
    allowMissing,
    allowDevDependency = false,
    incompatibleAction = "update it explicitly or use a compatible Plugin version",
  } = options;
  const runtimeRange = (
    packageJson.dependencies as Record<string, string> | undefined
  )?.[dependencyName];
  const developmentRange = (
    packageJson.devDependencies as Record<string, string> | undefined
  )?.[dependencyName];
  if (
    runtimeRange === undefined &&
    developmentRange !== undefined &&
    !allowDevDependency
  ) {
    throw new Error(
      `${label} dependency "${dependencyName}" is declared only in devDependencies, but it is required at runtime. Move it to dependencies so production installs such as npm ci --omit=dev include it. No files were changed.`,
    );
  }
  const dependencyRanges = [
    runtimeRange ?? (allowDevDependency ? developmentRange : undefined),
  ].filter((range): range is string => range !== undefined);
  if (dependencyRanges.length === 0) {
    if (allowMissing) return;
    throw new Error(
      `${label} dependency "${dependencyName}" is not installed; no files were changed.`,
    );
  }

  let installedDependency:
    Awaited<ReturnType<typeof readInstalledDependencyVersion>> | undefined;
  for (const dependencyRange of dependencyRanges) {
    const normalizedRange = validRange(dependencyRange);
    if (normalizedRange === null) {
      if (!INSTALLED_VERSION_SPECS.test(dependencyRange)) {
        throw new Error(
          `${label} dependency "${dependencyName}" spec "${dependencyRange}" is neither a semver range nor a workspace:, file:, or catalog: reference; declare compatibility explicitly. No files were changed.`,
        );
      }
      installedDependency ??= await readInstalledDependencyVersion(
        cwd,
        dependencyName,
      );
      const relativePackagePath = path
        .relative(cwd, installedDependency.packagePath)
        .replace(/\\/g, "/");
      if (!installedDependency.version) {
        throw new Error(
          `${label} dependency "${dependencyName}" uses non-semver spec "${dependencyRange}", but Amplio could not resolve an installed version from "${relativePackagePath}". Install dependencies and retry. No files were changed.`,
        );
      }
      if (!satisfies(installedDependency.version, supportedRange)) {
        throw new Error(
          `${label} dependency "${dependencyName}" spec "${dependencyRange}" resolves to installed version "${installedDependency.version}", outside supported range "${supportedRange}"; ${incompatibleAction}. No files were changed.`,
        );
      }
      continue;
    }

    const exactVersion = valid(dependencyRange);
    const compatible = exactVersion
      ? satisfies(exactVersion, supportedRange)
      : subset(normalizedRange, supportedRange);
    if (!compatible) {
      throw new Error(
        `${label} dependency "${dependencyName}" range "${dependencyRange}" is outside supported range "${supportedRange}"; ${incompatibleAction}. No files were changed.`,
      );
    }
  }
}
