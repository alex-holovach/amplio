import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { subset, validRange } from "semver";
import type { RegistryItem } from "../registry/types.js";
import { getCliVersion } from "./cli-version.js";
import { assertDependencyCompatibility } from "./dependency-compatibility.js";
import { pathExists } from "./fs.js";
import {
  installCommand,
  runProjectInstall,
  runInstall,
  type PackageManager,
} from "./install-deps.js";
import {
  restorePackageMutationFiles,
  snapshotPackageMutationFiles,
  type PackageMutationSnapshot,
} from "./package-mutation.js";

export type ProviderInstall = (
  packageManager: PackageManager,
  cwd: string,
  packages: string[],
  verbose: boolean,
) => { ok: boolean; output: string } | Promise<{ ok: boolean; output: string }>;

export type ProjectInstall = (
  packageManager: PackageManager,
  cwd: string,
  verbose: boolean,
) => { ok: boolean; output: string } | Promise<{ ok: boolean; output: string }>;

export interface EnsurePluginProviderDependencyOptions {
  cwd: string;
  item: RegistryItem;
  packageManager: PackageManager;
  yes?: boolean;
  dryRun?: boolean;
  verbose?: boolean;
  confirm?: (question: string) => boolean | Promise<boolean>;
  install?: ProviderInstall;
  installProject?: ProjectInstall;
  recipeDependencies?: {
    dependencies?: string[];
    devDependencies?: string[];
  };
}

export type ProviderDependencyStatus = "present" | "preview" | "installed";

export interface ProviderDependencyChange {
  status: ProviderDependencyStatus;
  /** Restores package.json and known lockfiles when a later Plugin step fails. */
  rollback(): Promise<void>;
}

function providerRequirement(item: RegistryItem): {
  packageName: string;
  supportedRange: string;
  installSpec: string;
} {
  const providerPackages = Object.keys(item.providerRanges ?? {});
  const packageName =
    item.provider?.package ??
    (providerPackages.length === 1 ? providerPackages[0] : undefined);
  if (!packageName) {
    throw new Error(
      `Plugin "${item.name.replace(/^plugin-/, "")}" has no unambiguous provider compatibility metadata. No files were changed.`,
    );
  }
  const supportedRange = item.providerRanges?.[packageName];
  if (!supportedRange || validRange(supportedRange) === null) {
    throw new Error(
      `Plugin "${item.name.replace(/^plugin-/, "")}" has invalid provider compatibility metadata for "${packageName}". No files were changed.`,
    );
  }

  const prefix = `${packageName}@`;
  const declaredSpec = item.dependencies?.find(
    (dependency) => dependency === packageName || dependency.startsWith(prefix),
  );
  const declaredRange = declaredSpec?.startsWith(prefix)
    ? declaredSpec.slice(prefix.length)
    : undefined;
  const installSpec =
    declaredRange &&
    validRange(declaredRange) !== null &&
    subset(declaredRange, supportedRange)
      ? declaredSpec!
      : `${packageName}@${supportedRange}`;
  return { packageName, supportedRange, installSpec };
}

async function readPackageJson(
  cwd: string,
): Promise<{ path: string; value: Record<string, unknown> }> {
  const packagePath = path.join(cwd, "package.json");
  if (!(await pathExists(packagePath))) {
    throw new Error(
      "package.json is required before installing a Plugin provider dependency. No files were changed.",
    );
  }
  return {
    path: packagePath,
    value: JSON.parse(await fs.readFile(packagePath, "utf8")) as Record<
      string,
      unknown
    >,
  };
}

function hasDeclaredDependency(
  packageJson: Record<string, unknown>,
  dependencyName: string,
): boolean {
  return ["dependencies", "devDependencies"].some(
    (field) =>
      (packageJson[field] as Record<string, unknown> | undefined)?.[
        dependencyName
      ] !== undefined,
  );
}

function hasRuntimeDependency(
  packageJson: Record<string, unknown>,
  dependencyName: string,
): boolean {
  return (
    (packageJson.dependencies as Record<string, unknown> | undefined)?.[
      dependencyName
    ] !== undefined
  );
}

function splitPackageSpec(spec: string): { name: string; version?: string } {
  const at = spec.lastIndexOf("@");
  if (at <= 0) return { name: spec };
  return { name: spec.slice(0, at), version: spec.slice(at + 1) };
}

function defaultRecipeVersion(name: string): string {
  if (name === "@useamplio/amplio") return `^${getCliVersion()}`;
  if (name === "zod") return "^3.24.0 || ^4.0.0";
  return "*";
}

function missingRecipeSpecs(
  packageJson: Record<string, unknown>,
  specs: string[],
  providerPackage: string,
  placement: "runtime" | "development",
): Array<{ name: string; version: string }> {
  const missing: Array<{ name: string; version: string }> = [];
  for (const spec of specs) {
    const parsed = splitPackageSpec(spec);
    if (
      parsed.name === providerPackage ||
      (placement === "runtime"
        ? hasRuntimeDependency(packageJson, parsed.name)
        : hasDeclaredDependency(packageJson, parsed.name)) ||
      missing.some((entry) => entry.name === parsed.name)
    ) {
      continue;
    }
    missing.push({
      name: parsed.name,
      version: parsed.version ?? defaultRecipeVersion(parsed.name),
    });
  }
  return missing;
}

const PACKAGE_MANAGER_SIDE_EFFECT_NOTICE =
  "package-manager cache, node_modules, and dependency lifecycle scripts are not reversible";

async function defaultConfirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return /^(?:y|yes)$/i.test((await prompt.question(question)).trim());
  } finally {
    prompt.close();
  }
}

function providerChange(
  status: ProviderDependencyStatus,
  snapshots: PackageMutationSnapshot[] = [],
): ProviderDependencyChange {
  let rollbackPending = snapshots.length > 0;
  return {
    status,
    async rollback(): Promise<void> {
      if (!rollbackPending) return;
      rollbackPending = false;
      await restorePackageMutationFiles(snapshots);
    },
  };
}

export async function ensurePluginProviderDependency(
  options: EnsurePluginProviderDependencyOptions,
): Promise<ProviderDependencyChange> {
  const { packageName, supportedRange, installSpec } = providerRequirement(
    options.item,
  );
  const initial = await readPackageJson(options.cwd);
  const coreRange = options.item.coreRange;
  if (!coreRange || validRange(coreRange) === null) {
    throw new Error(
      `Plugin "${options.item.name.replace(/^plugin-/, "")}" has invalid core compatibility metadata. No files were changed.`,
    );
  }
  await assertDependencyCompatibility({
    cwd: options.cwd,
    packageJson: initial.value,
    dependencyName: "@useamplio/amplio",
    supportedRange: coreRange,
    label: "Core",
    allowMissing: false,
  });
  await assertDependencyCompatibility({
    cwd: options.cwd,
    packageJson: initial.value,
    dependencyName: packageName,
    supportedRange,
    label: "Provider",
    allowMissing: true,
  });
  const hasMissingNonProviderRuntimeDependency = (
    options.recipeDependencies?.dependencies ?? []
  ).some((spec) => {
    const parsed = splitPackageSpec(spec);
    return (
      parsed.name !== packageName &&
      !hasRuntimeDependency(initial.value, parsed.name)
    );
  });
  const hasMissingDevelopmentDependency = (
    options.recipeDependencies?.devDependencies ?? []
  ).some((spec) => {
    const parsed = splitPackageSpec(spec);
    return (
      parsed.name !== packageName &&
      !hasDeclaredDependency(initial.value, parsed.name)
    );
  });
  const providerNeedsRuntimePlacement =
    hasDeclaredDependency(initial.value, packageName) &&
    !hasRuntimeDependency(initial.value, packageName);
  if (
    options.recipeDependencies &&
    (hasMissingNonProviderRuntimeDependency ||
      hasMissingDevelopmentDependency ||
      providerNeedsRuntimePlacement)
  ) {
    const runtime = missingRecipeSpecs(
      initial.value,
      options.recipeDependencies.dependencies ?? [],
      packageName,
      "runtime",
    );
    const development = missingRecipeSpecs(
      initial.value,
      options.recipeDependencies.devDependencies ?? [],
      packageName,
      "development",
    ).filter(
      (entry) =>
        !runtime.some((runtimeEntry) => runtimeEntry.name === entry.name),
    );
    const providerMissing = !hasRuntimeDependency(initial.value, packageName);
    if (providerMissing) {
      const parsedProvider = splitPackageSpec(installSpec);
      runtime.push({
        name: parsedProvider.name,
        version: parsedProvider.version ?? supportedRange,
      });
    }
    if (runtime.length === 0 && development.length === 0) {
      return providerChange("present");
    }

    const planned = [
      ...runtime.map((entry) => `${entry.name}@${entry.version}`),
      ...development.map((entry) => `${entry.name}@${entry.version} (dev)`),
    ];
    const command =
      options.packageManager === "npm"
        ? "npm install --no-audit --no-fund"
        : `${options.packageManager} install`;
    const detail = planned.join(", ");
    if (options.dryRun) {
      console.log(`  ~ would install recipe dependencies: ${detail}`);
      console.log(`  ~ ${command}`);
      console.log(`  ~ ${PACKAGE_MANAGER_SIDE_EFFECT_NOTICE}`);
      return providerChange("preview");
    }

    console.log(`\nPlugin recipe dependencies are missing: ${detail}`);
    console.log(`  ${command}`);
    console.log(
      `  ! package.json, lockfiles, Plugin source, and lifecycle state roll back on failure; ${PACKAGE_MANAGER_SIDE_EFFECT_NOTICE}`,
    );
    const approved =
      options.yes === true
        ? true
        : await (options.confirm ?? defaultConfirm)("Install them now? [y/N] ");
    if (!approved) {
      throw new Error(
        "Recipe dependency approval declined. Rerun with --yes to install the complete dependency plan. No files were changed.",
      );
    }

    const snapshots = await snapshotPackageMutationFiles(
      options.cwd,
      options.packageManager,
      "recipe dependency install",
    );
    try {
      const packageJson = initial.value as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      packageJson.dependencies = { ...packageJson.dependencies };
      packageJson.devDependencies = { ...packageJson.devDependencies };
      for (const entry of runtime) {
        packageJson.dependencies[entry.name] = entry.version;
        delete packageJson.devDependencies[entry.name];
      }
      for (const entry of development) {
        packageJson.devDependencies[entry.name] = entry.version;
      }
      await fs.writeFile(
        initial.path,
        `${JSON.stringify(packageJson, null, 2)}\n`,
      );
      const install: ProjectInstall =
        options.installProject ??
        ((packageManager, cwd, verbose) =>
          runProjectInstall(packageManager, cwd, verbose));
      const result = await install(
        options.packageManager,
        options.cwd,
        options.verbose ?? false,
      );
      if (!result.ok) {
        if (result.output.trim()) console.log(`\n${result.output.trimEnd()}`);
        throw new Error(
          `Recipe dependency install failed. Run ${command} manually. package.json and lockfiles were restored; package-manager cache, node_modules, and dependency lifecycle scripts may have changed.`,
        );
      }
      const installed = await readPackageJson(options.cwd);
      await assertDependencyCompatibility({
        cwd: options.cwd,
        packageJson: installed.value,
        dependencyName: packageName,
        supportedRange,
        label: "Provider",
        allowMissing: false,
      });
    } catch (error) {
      await restorePackageMutationFiles(snapshots);
      throw error;
    }
    console.log(
      `  ✓ installed recipe dependencies (${options.packageManager})`,
    );
    return providerChange("installed", snapshots);
  }
  if (hasDeclaredDependency(initial.value, packageName)) {
    return providerChange("present");
  }

  const command = installCommand(options.packageManager, [installSpec]);
  const requirement = `${installSpec} (allowed range "${supportedRange}")`;
  if (options.dryRun) {
    console.log(`  ~ would install provider ${requirement}: ${command}`);
    console.log(`  ~ ${PACKAGE_MANAGER_SIDE_EFFECT_NOTICE}`);
    return providerChange("preview");
  }

  console.log(`\nPlugin provider dependency is missing: ${requirement}`);
  console.log(`  ${command}`);
  console.log(
    `  ! package.json and lockfiles roll back on failure; ${PACKAGE_MANAGER_SIDE_EFFECT_NOTICE}`,
  );
  const approved =
    options.yes === true
      ? true
      : await (options.confirm ?? defaultConfirm)("Install it now? [y/N] ");
  if (!approved) {
    throw new Error(
      `Provider dependency approval declined. Rerun with --yes to install ${installSpec}. No files were changed.`,
    );
  }

  const snapshots = await snapshotPackageMutationFiles(
    options.cwd,
    options.packageManager,
    "provider install",
  );
  const install: ProviderInstall =
    options.install ??
    ((packageManager, cwd, packages, verbose) =>
      runInstall(packageManager, cwd, packages, false, verbose));
  try {
    const result = await install(
      options.packageManager,
      options.cwd,
      [installSpec],
      options.verbose ?? false,
    );
    if (!result.ok) {
      if (result.output.trim()) console.log(`\n${result.output.trimEnd()}`);
      throw new Error(
        `Provider install failed. Run ${command} manually. package.json and lockfiles were restored; package-manager cache, node_modules, and dependency lifecycle scripts may have changed.`,
      );
    }
    const installed = await readPackageJson(options.cwd);
    await assertDependencyCompatibility({
      cwd: options.cwd,
      packageJson: installed.value,
      dependencyName: packageName,
      supportedRange,
      label: "Provider",
      allowMissing: false,
    });
  } catch (error) {
    await restorePackageMutationFiles(snapshots);
    throw error;
  }
  console.log(`  ✓ installed provider ${installSpec}`);
  return providerChange("installed", snapshots);
}
