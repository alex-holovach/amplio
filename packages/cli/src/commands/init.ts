import path from "node:path";
import { runAddEvent, runAddMiddleware } from "./add.js";
import { renderAmplioConfig, renderInstrumentationTemplate, renderLoggerTemplate } from "../templates/init.js";
import { upsertComponentsJson } from "../utils/components-json.js";
import { detectFramework, shouldAutoScaffold } from "../utils/detect-framework.js";
import { detectPackageManager } from "../utils/detect-package-manager.js";
import { ensureDir, pathExists, writeFileIfMissing } from "../utils/fs.js";
import { hasDependency } from "../utils/has-dep.js";
import { readAmplioConfig, resolveRegistryPath } from "../utils/config.js";
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

async function resolveNextInstrumentationBase(cwd: string): Promise<"src" | ""> {
  if (
    (await pathExists(path.join(cwd, "src/app"))) ||
    (await pathExists(path.join(cwd, "src/pages")))
  ) {
    return "src";
  }
  return "";
}

function loggerImportForInstrumentation(
  cwd: string,
  instrumentationBase: "src" | "",
  loggerPath: string,
): string {
  const instrumentationDir = instrumentationBase
    ? path.join(cwd, instrumentationBase)
    : cwd;
  const relative = path
    .relative(instrumentationDir, loggerPath)
    .replace(/\\/g, "/")
    .replace(/\.ts$/, "");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

async function scaffoldNextInstrumentation(
  cwd: string,
  telemetryDir: string,
  loggerPath: string,
): Promise<"created" | "exists"> {
  const base = await resolveNextInstrumentationBase(cwd);
  const instrumentationTs = path.join(cwd, base, "instrumentation.ts");
  const instrumentationJs = path.join(cwd, base, "instrumentation.js");

  if ((await pathExists(instrumentationTs)) || (await pathExists(instrumentationJs))) {
    console.log(
      "\nNext.js: ensure instrumentation.ts imports your telemetry/logger so init() runs at boot.",
    );
    return "exists";
  }

  const importPath = loggerImportForInstrumentation(cwd, base, loggerPath);
  await writeFileIfMissing(
    instrumentationTs,
    renderInstrumentationTemplate(importPath),
  );
  console.log(`  ✓ ${path.relative(cwd, instrumentationTs)}`);
  return "created";
}

export async function runInit(options: InitOptions): Promise<void> {
  const registryPath = await resolveRegistryPath(options.cwd);
  const paths = resolveProjectPaths(options.cwd, "telemetry");
  const registry = registryPathForConfig(options.cwd, registryPath);
  const packageManager =
    options.packageManager ?? (await detectPackageManager(options.cwd));

  await ensureDir(paths.telemetry);
  await ensureDir(paths.events);

  const configResult = await writeFileIfMissing(
    paths.config,
    renderAmplioConfig({
      ...(registry ? { registry } : {}),
      packageManager,
      typescript: options.typescript ?? true,
    }),
  );

  const componentsPath = path.join(options.cwd, "components.json");
  const componentsResult = await upsertComponentsJson(options.cwd, DEFAULT_REGISTRY_URL);

  const loggerResult = await writeFileIfMissing(
    paths.logger,
    renderLoggerTemplate(options.service),
  );

  console.log("amplio init");
  console.log(`  ${configResult === "created" ? "✓" : "·"} ${path.relative(options.cwd, paths.config)}`);
  console.log(
    `  ${componentsResult === "created" ? "✓" : componentsResult === "updated" ? "↻" : "·"} ${path.relative(options.cwd, componentsPath)}`,
  );
  console.log(`  ${loggerResult === "created" ? "✓" : "·"} ${path.relative(options.cwd, paths.logger)}`);
  console.log(`  ✓ ${path.relative(options.cwd, paths.telemetry)}/`);
  console.log(`  ✓ ${path.relative(options.cwd, paths.events)}/`);

  if (
    configResult === "skipped" ||
    componentsResult === "skipped" ||
    loggerResult === "skipped"
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

  if (
    auto &&
    middlewareName === "next" &&
    (await hasDependency(options.cwd, "@trpc/server"))
  ) {
    await runAddMiddleware("trpc", { cwd: options.cwd });
    console.log(
      "\ntRPC detected: see ALPHA.md for wiring tRPC middleware with the Next.js route-handler wrapper.",
    );
  }

  if (eventName) {
    await runAddEvent(eventName, { cwd: options.cwd });
  }

  const isNext =
    detected === "next" || middlewareName === "next" || (await hasDependency(options.cwd, "next"));
  if (isNext) {
    const config = await readAmplioConfig(options.cwd);
    const telemetryDir = config?.telemetryDir ?? "telemetry";
    const loggerPath = path.join(options.cwd, telemetryDir, "logger.ts");
    await scaffoldNextInstrumentation(options.cwd, telemetryDir, loggerPath);

    console.log("\nVerify:");
    console.log("  1. Start your dev server");
    console.log("  2. curl any route wrapped with amplio middleware");
    console.log("  3. Expect one JSON line on stdout (console sink)");
    console.log("  4. npx @useamplio/cli@alpha doctor");
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
