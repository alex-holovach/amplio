import fs from "node:fs/promises";
import path from "node:path";
import { pathExists } from "./fs.js";
import {
  isCanonicallyWithin,
  isPathWithin,
  isPortableAbsolute,
} from "./path-containment.js";
import { resolveBundledRegistryPath } from "./paths.js";

export interface AmplioConfig {
  telemetryDir?: string;
  registry?: string;
  packageManager?: "pnpm" | "npm" | "yarn" | "bun";
}

const PACKAGE_MANAGERS = new Set(["pnpm", "npm", "yarn", "bun"]);

export async function assertTelemetryDirContained(
  cwd: string,
  telemetryDir: unknown,
): Promise<void> {
  const invalid = (): Error =>
    new Error(
      `Invalid amplio.json telemetryDir ${JSON.stringify(telemetryDir)}; use a normalized relative path inside the project. No files were changed.`,
    );
  if (
    typeof telemetryDir !== "string" ||
    telemetryDir.length === 0 ||
    telemetryDir.includes("\\") ||
    isPortableAbsolute(telemetryDir) ||
    path.posix.normalize(telemetryDir) !== telemetryDir ||
    telemetryDir === "." ||
    telemetryDir
      .split("/")
      .some((segment) => segment === ".." || segment === ".")
  ) {
    throw invalid();
  }

  const projectRoot = path.resolve(cwd);
  const telemetryPath = path.resolve(projectRoot, telemetryDir);
  if (!isPathWithin(projectRoot, telemetryPath)) throw invalid();
  try {
    if (!(await isCanonicallyWithin(projectRoot, telemetryPath))) {
      throw new Error(
        `Invalid amplio.json telemetryDir ${JSON.stringify(telemetryDir)}; its symlink resolves outside the project. No files were changed.`,
      );
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("outside the project")
    ) {
      throw error;
    }
    throw new Error(
      `Invalid amplio.json telemetryDir ${JSON.stringify(telemetryDir)}; its path could not be validated safely. No files were changed.`,
      { cause: error },
    );
  }
}

export async function readAmplioConfig(
  cwd: string,
): Promise<AmplioConfig | null> {
  const configPath = path.join(cwd, "amplio.json");
  if (!(await pathExists(configPath))) {
    return null;
  }
  const raw = await fs.readFile(configPath, "utf8");
  const config = JSON.parse(raw) as AmplioConfig;
  const packageManager = (config as Record<string, unknown>).packageManager;
  if (
    packageManager !== undefined &&
    (typeof packageManager !== "string" ||
      !PACKAGE_MANAGERS.has(packageManager))
  ) {
    throw new Error(
      `Invalid amplio.json packageManager ${JSON.stringify(packageManager)}; use pnpm, npm, yarn, or bun. No files were changed.`,
    );
  }
  if (config.telemetryDir !== undefined) {
    await assertTelemetryDirContained(cwd, config.telemetryDir);
  }
  return config;
}

export async function resolveTelemetryDir(cwd: string): Promise<string> {
  const config = await readAmplioConfig(cwd);
  const telemetryDir = config?.telemetryDir ?? "telemetry";
  // readAmplioConfig validates configured values; this second check covers the
  // default path when no config exists yet.
  await assertTelemetryDirContained(cwd, telemetryDir);
  return telemetryDir;
}

async function firstExisting(paths: string[]): Promise<string | undefined> {
  for (const candidate of paths) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export async function resolveRegistryPath(cwd: string): Promise<string> {
  const config = await readAmplioConfig(cwd);
  const configured = config?.registry;
  if (configured !== undefined) {
    if (typeof configured !== "string" || configured.trim().length === 0) {
      throw new Error(
        "Configured registry in amplio.json must be a non-empty path. No files were changed.",
      );
    }
    const resolved = path.isAbsolute(configured)
      ? configured
      : path.resolve(cwd, configured);
    const existing = await firstExisting([
      resolved,
      resolved.replace(/registry\.json$/, "registry.manifest.json"),
    ]);
    if (existing) {
      return existing;
    }
    throw new Error(
      `Configured registry "${configured}" was not found. No files were changed.`,
    );
  }

  const bundled = resolveBundledRegistryPath();
  const existing = await firstExisting([
    bundled.replace(/registry\.json$/, "registry.manifest.json"),
    bundled,
  ]);
  if (existing) {
    return existing;
  }

  return bundled;
}

export function defaultAmplioConfig(
  registryPath: string,
  packageManager?: AmplioConfig["packageManager"],
): AmplioConfig {
  return {
    telemetryDir: "telemetry",
    registry: registryPath,
    ...(packageManager ? { packageManager } : {}),
  };
}
