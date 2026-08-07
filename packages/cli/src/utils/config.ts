import fs from "node:fs/promises";
import path from "node:path";
import { pathExists } from "./fs.js";
import { resolveBundledRegistryPath } from "./paths.js";

export interface LogcnConfig {
  telemetryDir?: string;
  registry?: string;
  typescript?: boolean;
  packageManager?: "pnpm" | "npm" | "yarn" | "bun";
}

export async function readLogcnConfig(cwd: string): Promise<LogcnConfig | null> {
  const configPath = path.join(cwd, "logcn.json");
  if (!(await pathExists(configPath))) {
    return null;
  }
  const raw = await fs.readFile(configPath, "utf8");
  return JSON.parse(raw) as LogcnConfig;
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
  const config = await readLogcnConfig(cwd);
  const configured = config?.registry;
  if (configured) {
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
  }

  const bundled = resolveBundledRegistryPath();
  const existing = await firstExisting([
    bundled,
    bundled.replace(/registry\.json$/, "registry.manifest.json"),
  ]);
  if (existing) {
    return existing;
  }

  return bundled;
}

export function defaultLogcnConfig(registryPath: string): LogcnConfig {
  return {
    telemetryDir: "telemetry",
    registry: registryPath,
    typescript: true,
    packageManager: "pnpm",
  };
}
