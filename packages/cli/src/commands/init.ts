import path from "node:path";
import { renderLogcnConfig, renderLoggerTemplate } from "../templates/init.js";
import { ensureDir, writeFileIfMissing } from "../utils/fs.js";
import { resolveRegistryPath } from "../utils/config.js";
import { resolveProjectPaths } from "../utils/paths.js";
import { registryPathForConfig } from "../utils/registry-path.js";

export interface InitOptions {
  cwd: string;
  service?: string;
  packageManager?: "pnpm" | "npm" | "yarn" | "bun";
  typescript?: boolean;
}

export async function runInit(options: InitOptions): Promise<void> {
  const registryPath = await resolveRegistryPath(options.cwd);
  const paths = resolveProjectPaths(options.cwd, "telemetry");
  const registry = registryPathForConfig(options.cwd, registryPath);

  const scaffoldDirs = [
    paths.events,
    paths.middleware,
    paths.sinks,
    paths.enrichers,
    paths.integrations,
  ] as const;

  for (const dir of scaffoldDirs) {
    await ensureDir(dir);
  }

  const configResult = await writeFileIfMissing(
    paths.config,
    renderLogcnConfig({
      ...(registry ? { registry } : {}),
      packageManager: options.packageManager ?? "pnpm",
      typescript: options.typescript ?? true,
    }),
  );

  const loggerResult = await writeFileIfMissing(
    paths.logger,
    renderLoggerTemplate(options.service),
  );

  const eventsIndexPath = path.join(paths.events, "index.ts");
  const eventsIndexResult = await writeFileIfMissing(
    eventsIndexPath,
    "export {};\n",
  );

  console.log("logcn init");
  console.log(`  ${configResult === "created" ? "✓" : "·"} ${path.relative(options.cwd, paths.config)}`);
  console.log(`  ${loggerResult === "created" ? "✓" : "·"} ${path.relative(options.cwd, paths.logger)}`);
  for (const dir of scaffoldDirs) {
    console.log(`  ✓ ${path.relative(options.cwd, dir)}/`);
  }
  console.log(
    `  ${eventsIndexResult === "created" ? "✓" : "·"} ${path.relative(options.cwd, eventsIndexPath)}`,
  );

  if (
    configResult === "skipped" ||
    loggerResult === "skipped" ||
    eventsIndexResult === "skipped"
  ) {
    console.log("\nExisting files were left unchanged.");
  }

  console.log("\nNext:");
  console.log("  logcn add event auth.user.signed_up");
  console.log("  logcn add middleware hono");
}
