import fs from "node:fs/promises";
import path from "node:path";
import { pathExists } from "./fs.js";
import { resolveBundledRegistryPath } from "./paths.js";

export interface AmplioConfig {
  telemetryDir?: string;
  registry?: string;
  typescript?: boolean;
  packageManager?: "pnpm" | "npm" | "yarn" | "bun";
}

export async function readAmplioConfig(cwd: string): Promise<AmplioConfig | null> {
  const configPath = path.join(cwd, "amplio.json");
  if (!(await pathExists(configPath))) {
    return null;
  }
  const raw = await fs.readFile(configPath, "utf8");
  return JSON.parse(raw) as AmplioConfig;
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

export function defaultAmplioConfig(
  registryPath: string,
  packageManager?: AmplioConfig["packageManager"],
): AmplioConfig {
  return {
    telemetryDir: "telemetry",
    registry: registryPath,
    typescript: true,
    ...(packageManager ? { packageManager } : {}),
  };
}
