import path from "node:path";
import { runAddEvent, runAddMiddleware } from "./add.js";
import {
  renderAmplioConfig,
  renderComponentsJson,
  renderLoggerTemplate,
} from "../templates/init.js";
import { detectFramework, shouldAutoScaffold } from "../utils/detect-framework.js";
import { ensureDir, writeFileIfMissing } from "../utils/fs.js";
import { resolveRegistryPath } from "../utils/config.js";
import { ensureRuntimeDependencies } from "../utils/install-deps.js";
import { resolveProjectPaths } from "../utils/paths.js";
import { registryPathForConfig } from "../utils/registry-path.js";

const DEFAULT_REGISTRY_URL = "https://amplio-ruddy.vercel.app/r/{name}.json";

export interface InitOptions {
  cwd: string;
  service?: string;
  packageManager?: "pnpm" | "npm" | "yarn" | "bun";
  typescript?: boolean;
  middleware?: string;
  event?: string;
  yes?: boolean;
  skipInstall?: boolean;
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
  const packageManager = options.packageManager ?? "pnpm";

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
      packageManager,
      typescript: options.typescript ?? true,
    }),
  );

  const componentsPath = path.join(options.cwd, "components.json");
  const componentsResult = await writeFileIfMissing(
    componentsPath,
    renderComponentsJson(DEFAULT_REGISTRY_URL),
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
  console.log(
    `  ${componentsResult === "created" ? "✓" : "·"} ${path.relative(options.cwd, componentsPath)}`,
  );
  console.log(`  ${loggerResult === "created" ? "✓" : "·"} ${path.relative(options.cwd, paths.logger)}`);
  for (const dir of scaffoldDirs) {
    console.log(`  ✓ ${path.relative(options.cwd, dir)}/`);
  }
  console.log(
    `  ${eventsIndexResult === "created" ? "✓" : "·"} ${path.relative(options.cwd, eventsIndexPath)}`,
  );

  if (
    configResult === "skipped" ||
    componentsResult === "skipped" ||
    loggerResult === "skipped" ||
    eventsIndexResult === "skipped"
  ) {
    console.log("\nExisting files were left unchanged.");
  }

  await ensureRuntimeDependencies({
    cwd: options.cwd,
    packageManager,
    skipInstall: options.skipInstall,
  });

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
