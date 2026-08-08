import path from "node:path";
import { runAddEvent, runAddMiddleware } from "./add.js";
import { renderAmplioConfig, renderLoggerTemplate } from "../templates/init.js";
import { detectFramework, shouldAutoScaffold } from "../utils/detect-framework.js";
import { ensureDir, writeFileIfMissing } from "../utils/fs.js";
import { resolveRegistryPath } from "../utils/config.js";
import { resolveProjectPaths } from "../utils/paths.js";
import { registryPathForConfig } from "../utils/registry-path.js";

export interface InitOptions {
  cwd: string;
  service?: string;
  packageManager?: "pnpm" | "npm" | "yarn" | "bun";
  typescript?: boolean;
  middleware?: string;
  event?: string;
  yes?: boolean;
}

function resolveMiddlewareName(
  explicit: string | undefined,
  detected: Awaited<ReturnType<typeof detectFramework>>,
  auto: boolean,
): string | null {
  if (explicit === "none") {
    return null;
  }
  if (explicit?.trim()) {
    return explicit.trim();
  }
  if (detected && auto) {
    return detected;
  }
  return null;
}

function resolveEventName(
  explicit: string | undefined,
  middlewareName: string | null,
  auto: boolean,
): string | null {
  if (explicit === "none") {
    return null;
  }
  if (explicit?.trim()) {
    return explicit.trim();
  }
  if (middlewareName && auto) {
    return "auth.user.signed_up";
  }
  return null;
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
    renderAmplioConfig({
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

  console.log("amplio init");
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

  const detected = await detectFramework(options.cwd);
  const auto = shouldAutoScaffold(options.yes);
  const middlewareName = resolveMiddlewareName(options.middleware, detected, auto);
  const eventName = resolveEventName(options.event, middlewareName, auto);

  if (detected && !middlewareName && !auto && options.middleware === undefined) {
    console.log(`\nDetected ${detected} in package.json.`);
  }

  if (middlewareName) {
    await runAddMiddleware(middlewareName, { cwd: options.cwd });
  }

  if (eventName) {
    await runAddEvent(eventName, { cwd: options.cwd });
  }

  if (!middlewareName && !eventName) {
    console.log("\nNext:");
    if (detected) {
      console.log(`  amplio add middleware ${detected}`);
    } else {
      console.log("  amplio add middleware hono");
    }
    console.log("  amplio add event auth.user.signed_up");
  }
}
