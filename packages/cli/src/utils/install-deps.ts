import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { getCliVersion } from "./cli-version.js";
import { assertDependencyCompatibility } from "./dependency-compatibility.js";
import { pathExists } from "./fs.js";
import {
  restorePackageMutationFiles,
  snapshotPackageMutationFiles,
} from "./package-mutation.js";

export type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

const CORE_RANGE = `>=${getCliVersion()} <1`;
const ZOD_RANGE = "^3.24.0 || ^4.0.0";
const RUNTIME_REQUIREMENTS = [
  {
    name: "@useamplio/amplio",
    range: CORE_RANGE,
    label: "Core",
    installSpec: `@useamplio/amplio@^${getCliVersion()}`,
  },
  {
    name: "zod",
    range: ZOD_RANGE,
    label: "Zod",
    installSpec: "zod@^3.24.0",
  },
] as const;
const RUNTIME_PACKAGES = RUNTIME_REQUIREMENTS.map(
  (requirement) => requirement.name,
);
const CLI_PACKAGE = "@useamplio/cli";
const CLI_RANGE = `^${getCliVersion()}`;
const CLI_INSTALL_SPEC = `${CLI_PACKAGE}@${getCliVersion()}`;

type PackageJson = Record<string, unknown> & {
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

async function assertRuntimeCompatibility(
  cwd: string,
  pkg: PackageJson,
  options: {
    allowDevDependency?: boolean;
    allowMissing?: boolean;
  } = {},
): Promise<void> {
  for (const requirement of RUNTIME_REQUIREMENTS) {
    await assertDependencyCompatibility({
      cwd,
      packageJson: pkg,
      dependencyName: requirement.name,
      supportedRange: requirement.range,
      label: requirement.label,
      allowMissing: options.allowMissing ?? true,
      allowDevDependency: options.allowDevDependency,
      incompatibleAction: "update it explicitly before running amplio init",
    });
  }
}

function runtimeInstallSpecs(missing: string[]): string[] {
  return missing.map(
    (name) =>
      RUNTIME_REQUIREMENTS.find((requirement) => requirement.name === name)!
        .installSpec,
  );
}

export function installCommand(
  pm: PackageManager,
  packages: string[],
  dev = false,
): string {
  return [pm, ...installArgs(pm, packages, dev)].join(" ");
}

// npm gets --no-audit --no-fund so the inner install doesn't dump audit noise
// into the middle of amplio's own checklist output.
function installArgs(
  pm: PackageManager,
  packages: string[],
  dev = false,
): string[] {
  switch (pm) {
    case "npm":
      return [
        "install",
        ...(dev ? ["-D"] : []),
        ...packages,
        "--no-audit",
        "--no-fund",
      ];
    case "yarn":
      return ["add", ...(dev ? ["-D"] : []), ...packages];
    case "bun":
      return ["add", ...(dev ? ["-d"] : []), ...packages];
    case "pnpm":
    default:
      return ["add", ...(dev ? ["-D"] : []), ...packages];
  }
}

// Default: capture the package manager's output so its progress lines and
// deprecated-subdependency warnings don't interleave with amplio's own
// checklist. --verbose streams it through; failures always dump the capture.
export function runInstall(
  pm: PackageManager,
  cwd: string,
  packages: string[],
  dev: boolean,
  verbose: boolean,
): { ok: boolean; output: string } {
  const result = spawnSync(pm, installArgs(pm, packages, dev), {
    cwd,
    stdio: verbose ? "inherit" : "pipe",
    env: process.env,
    encoding: "utf8",
  });
  const ok = !result.error && result.status === 0;
  const output = verbose ? "" : `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return { ok, output };
}

export function runProjectInstall(
  pm: PackageManager,
  cwd: string,
  verbose: boolean,
): { ok: boolean; output: string } {
  const args =
    pm === "npm" ? ["install", "--no-audit", "--no-fund"] : ["install"];
  const result = spawnSync(pm, args, {
    cwd,
    stdio: verbose ? "inherit" : "pipe",
    env: process.env,
    encoding: "utf8",
  });
  const ok = !result.error && result.status === 0;
  const output = verbose ? "" : `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return { ok, output };
}

export async function ensureRuntimeDependencies(options: {
  cwd: string;
  packageManager: PackageManager;
  skipInstall?: boolean;
  /** Also install @useamplio/cli as a devDependency (init does this so the "amplio" npm script works out of the box). */
  withCliDevDependency?: boolean;
  /** Stream the raw package-manager output instead of the one-line summary. */
  verbose?: boolean;
}): Promise<"installed" | "migrated" | "present" | "skipped" | "manual"> {
  const pm = options.packageManager;
  const pkg = await readPackageJson(options.cwd);

  if (!pkg) {
    console.log("\nInstall runtime deps (no package.json found):");
    console.log(
      `  ${installCommand(
        pm,
        RUNTIME_REQUIREMENTS.map((requirement) => requirement.installSpec),
      )}`,
    );
    return "manual";
  }

  // Validate compatible dev-only declarations before planning their
  // transactional move into the runtime dependency section.
  await assertRuntimeCompatibility(options.cwd, pkg, {
    allowDevDependency: true,
  });
  if (options.withCliDevDependency) {
    await assertDependencyCompatibility({
      cwd: options.cwd,
      packageJson: pkg,
      dependencyName: CLI_PACKAGE,
      supportedRange: CLI_RANGE,
      label: "CLI",
      allowMissing: true,
      allowDevDependency: true,
      incompatibleAction: "update it explicitly before running amplio init",
    });
  }
  const missing = missingPackages(pkg, RUNTIME_PACKAGES);
  const missingRuntimeSpecs = runtimeInstallSpecs(missing);
  const missingCli = options.withCliDevDependency
    ? missingPackages(pkg, [CLI_PACKAGE])
    : [];
  const runtimeDevDeclarations = RUNTIME_PACKAGES.filter(
    (name) => pkg.devDependencies?.[name] !== undefined,
  );

  if (
    missing.length === 0 &&
    missingCli.length === 0 &&
    runtimeDevDeclarations.length === 0
  ) {
    console.log(
      `\n  · ${RUNTIME_PACKAGES.join(" and ")}${options.withCliDevDependency ? ` (and ${CLI_PACKAGE})` : ""} already in package.json`,
    );
    return "present";
  }

  if (options.skipInstall) {
    console.log("\nInstall runtime deps:");
    if (runtimeDevDeclarations.length > 0) {
      console.log(
        `  Move ${runtimeDevDeclarations.join(", ")} from devDependencies to dependencies, then run ${pm} install`,
      );
    }
    if (missing.length > 0) {
      console.log(`  ${installCommand(pm, missingRuntimeSpecs)}`);
    }
    if (missingCli.length > 0) {
      console.log(`  ${installCommand(pm, [CLI_INSTALL_SPEC], true)}`);
    }
    return "skipped";
  }

  const parts = [...missing, ...missingCli.map((name) => `${name} (dev)`)];
  const actions = [
    ...runtimeDevDeclarations.map((name) => `${name} (move to runtime)`),
    ...parts,
  ];
  const verbose = options.verbose ?? false;
  if (verbose) {
    console.log(`\nUpdating ${actions.join(", ")} with ${pm}…`);
  }

  const startedAt = Date.now();
  const snapshots = await snapshotPackageMutationFiles(
    options.cwd,
    options.packageManager,
  );
  let failedOutput = "";
  let ok = true;
  try {
    if (runtimeDevDeclarations.length > 0) {
      pkg.dependencies ??= {};
      pkg.devDependencies ??= {};
      for (const name of runtimeDevDeclarations) {
        pkg.dependencies[name] ??= pkg.devDependencies[name]!;
        delete pkg.devDependencies[name];
      }
      await fs.writeFile(
        path.join(options.cwd, "package.json"),
        `${JSON.stringify(pkg, null, 2)}\n`,
        "utf8",
      );
    }

    if (missing.length > 0) {
      const result = runInstall(
        pm,
        options.cwd,
        missingRuntimeSpecs,
        false,
        verbose,
      );
      ok = result.ok;
      failedOutput = result.output;
    }
    if (ok && missingCli.length > 0) {
      const result = runInstall(
        pm,
        options.cwd,
        [CLI_INSTALL_SPEC],
        true,
        verbose,
      );
      ok = result.ok;
      failedOutput = result.output;
    }
    if (
      ok &&
      runtimeDevDeclarations.length > 0 &&
      missing.length === 0 &&
      missingCli.length === 0
    ) {
      const result = runProjectInstall(pm, options.cwd, verbose);
      ok = result.ok;
      failedOutput = result.output;
    }
  } catch (error) {
    await restorePackageMutationFiles(snapshots);
    throw error;
  }

  if (!ok) {
    await restorePackageMutationFiles(snapshots);
    if (!verbose && failedOutput.trim()) {
      console.log(`\n${failedOutput.trimEnd()}`);
    }
    console.log("\nAutomatic install failed. Run:");
    if (runtimeDevDeclarations.length > 0) {
      console.log(
        `  Move ${runtimeDevDeclarations.join(", ")} from devDependencies to dependencies, then run ${pm} install`,
      );
    }
    if (missing.length > 0) {
      console.log(`  ${installCommand(pm, missingRuntimeSpecs)}`);
    }
    if (missingCli.length > 0) {
      console.log(`  ${installCommand(pm, [CLI_INSTALL_SPEC], true)}`);
    }
    return "manual";
  }

  try {
    const installedPackage = await readPackageJson(options.cwd);
    if (!installedPackage) {
      throw new Error(
        "package.json disappeared during dependency installation; no generated files were written.",
      );
    }
    await assertRuntimeCompatibility(options.cwd, installedPackage, {
      allowMissing: false,
    });
    if (options.withCliDevDependency) {
      await assertDependencyCompatibility({
        cwd: options.cwd,
        packageJson: installedPackage,
        dependencyName: CLI_PACKAGE,
        supportedRange: CLI_RANGE,
        label: "CLI",
        allowMissing: false,
        allowDevDependency: true,
        incompatibleAction: "update it explicitly before running amplio init",
      });
    }
  } catch (error) {
    await restorePackageMutationFiles(snapshots);
    throw error;
  }

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  if (runtimeDevDeclarations.length > 0) {
    console.log(
      `  ✓ moved ${runtimeDevDeclarations.join(", ")} to dependencies (${pm}, ${seconds}s)`,
    );
  }
  if (parts.length === 0) {
    return "migrated";
  }
  console.log(`  ✓ installed ${parts.join(", ")} (${pm}, ${seconds}s)`);
  return "installed";
}
