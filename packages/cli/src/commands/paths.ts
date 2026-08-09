import { readAmplioConfig } from "../utils/config.js";
import { writeTsconfigPathsAlias } from "../utils/tsconfig-paths.js";

export interface PathsOptions {
  cwd: string;
}

/**
 * Standalone `amplio paths`: write the ~telemetry/* tsconfig alias and nothing
 * else. `init --paths` still works for one-shot setup, but re-running the whole
 * init flow just to add an alias implied more happened than did.
 */
export async function runPaths(options: PathsOptions): Promise<void> {
  console.log("amplio paths");
  const config = await readAmplioConfig(options.cwd);
  const telemetryDir = config?.telemetryDir ?? "telemetry";
  await writeTsconfigPathsAlias(options.cwd, telemetryDir);
}
