import path from "node:path";
import fs from "node:fs/promises";
import { runAddEvent, runAddMiddleware } from "./add.js";
import { renderAmplioConfig, renderInstrumentationTemplate, renderLoggerTemplate } from "../templates/init.js";
import { upsertComponentsJson } from "../utils/components-json.js";
import { detectFramework, shouldAutoScaffold } from "../utils/detect-framework.js";
import { detectPackageManager } from "../utils/detect-package-manager.js";
import { ensureDir, pathExists, writeFileIfMissing } from "../utils/fs.js";
import { hasAuthDependency, hasDependency } from "../utils/has-dep.js";
import { ALPHA_MD_URL, T3_MD_URL } from "../help.js";
import { readAmplioConfig, resolveRegistryPath } from "../utils/config.js";
import { ensureRuntimeDependencies } from "../utils/install-deps.js";
import { parseJsonc } from "../utils/jsonc.js";
import { resolveProjectPaths } from "../utils/paths.js";
import { registryPathForConfig } from "../utils/registry-path.js";

const DEFAULT_REGISTRY_URL = "https://amplio-ruddy.vercel.app/r/{name}.json";

const DEFAULT_SERVICE = "my-app";

export interface InitOptions {
  cwd: string;
  service?: string;
  packageManager?: "pnpm" | "npm" | "yarn" | "bun";
  typescript?: boolean;
  middleware?: string;
  event?: string;
  yes?: boolean;
  skipInstall?: boolean;
  paths?: boolean;
}

async function resolveDefaultService(cwd: string): Promise<string> {
  const pkgPath = path.join(cwd, "package.json");
  if (!(await pathExists(pkgPath))) {
    return DEFAULT_SERVICE;
  }

  try {
    const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8")) as { name?: string };
    const rawName = pkg.name?.trim();
    if (!rawName) {
      return DEFAULT_SERVICE;
    }
    return rawName.replace(/^@[^/]+\//, "");
  } catch {
    return DEFAULT_SERVICE;
  }
}

function resolveExplicitService(explicit: string | undefined): string | undefined {
  const trimmed = explicit?.trim();
  return trimmed ? trimmed : undefined;
}

async function resolveServiceName(cwd: string, explicit: string | undefined): Promise<string> {
  return resolveExplicitService(explicit) ?? (await resolveDefaultService(cwd));
}

function middlewareImportPath(telemetryDir: string, middlewareName: string, srcLayout: boolean): string {
  const base = srcLayout ? "../../" : "./";
  return `${base}${telemetryDir}/middleware/${middlewareName}`;
}

function printNextWiringSnippet(telemetryDir: string, srcLayout: boolean): void {
  const importPath = middlewareImportPath(telemetryDir, "next", srcLayout);
  console.log("\nWire Next.js route handlers:");
  console.log(`  import { withAmplio } from "${importPath}";`);
  console.log("  export const GET = withAmplio(async (request) => {");
  console.log("    // handler body");
  console.log("  });");
}

function printTrpcWiringSnippet(telemetryDir: string, srcLayout: boolean): void {
  const importPath = middlewareImportPath(telemetryDir, "trpc", srcLayout);
  console.log(`\nWire tRPC middleware (see ${ALPHA_MD_URL} ## tRPC (v11)):`);
  console.log(`  T3 / create-t3-app walkthrough: ${T3_MD_URL}`);
  console.log(`  import { amplioTrpcMiddleware } from "${importPath}";`);
  console.log("  const amplioMw = t.middleware(amplioTrpcMiddleware());");
  console.log("  publicProcedure.use(amplioMw);");
}

function printTsconfigPathsHint(): void {
  console.log("\nOptional: add to tsconfig.json compilerOptions.paths for shorter imports:");
  console.log('  "~telemetry/*": ["./telemetry/*"]');
  console.log("  Then import from \"~telemetry/middleware/next\" instead of relative paths.");
  console.log("  Or run: amplio init --paths");
}

function tsconfigHasTelemetryAlias(raw: string, telemetryDir: string): boolean {
  try {
    const config = parseJsonc<{ compilerOptions?: { paths?: Record<string, string[]> } }>(raw);
    const paths = config.compilerOptions?.paths ?? {};
    return paths["~telemetry/*"]?.includes(`./${telemetryDir}/*`) ?? false;
  } catch {
    return false;
  }
}

function detectEntryIndent(source: string, braceIndex: number): string {
  const afterBrace = source.slice(braceIndex + 1);
  const lineMatch = /^\s*\n(\s+)\S/.exec(afterBrace);
  return lineMatch?.[1] ?? "    ";
}

async function applyTsconfigPathsAlias(
  cwd: string,
  telemetryDir: string,
): Promise<"success" | "already" | "missing" | "failed"> {
  const tsconfigPath = path.join(cwd, "tsconfig.json");
  if (!(await pathExists(tsconfigPath))) {
    return "missing";
  }

  const raw = await fs.readFile(tsconfigPath, "utf8");
  if (tsconfigHasTelemetryAlias(raw, telemetryDir)) {
    return "already";
  }

  const aliasEntry = `"~telemetry/*": ["./${telemetryDir}/*"]`;
  let edited: string;

  const pathsKeyMatch = /(["'])paths\1\s*:\s*\{/.exec(raw);
  if (pathsKeyMatch && pathsKeyMatch.index !== undefined) {
    const braceIndex = raw.indexOf("{", pathsKeyMatch.index);
    const entryIndent = detectEntryIndent(raw, braceIndex);
    const insert = `\n${entryIndent}${aliasEntry},`;
    edited = raw.slice(0, braceIndex + 1) + insert + raw.slice(braceIndex + 1);
  } else {
    const compilerOptionsMatch = /(["'])compilerOptions\1\s*:\s*\{/.exec(raw);
    if (!compilerOptionsMatch || compilerOptionsMatch.index === undefined) {
      return "failed";
    }
    const braceIndex = raw.indexOf("{", compilerOptionsMatch.index);
    const entryIndent = detectEntryIndent(raw, braceIndex);
    const pathsBlock = `\n${entryIndent}"paths": {\n${entryIndent}  ${aliasEntry}\n${entryIndent}},`;
    edited = raw.slice(0, braceIndex + 1) + pathsBlock + raw.slice(braceIndex + 1);
  }

  try {
    const config = parseJsonc<{ compilerOptions?: { paths?: Record<string, string[]> } }>(edited);
    const paths = config.compilerOptions?.paths ?? {};
    if (!paths["~telemetry/*"]?.includes(`./${telemetryDir}/*`)) {
      return "failed";
    }
  } catch {
    return "failed";
  }

  await fs.writeFile(tsconfigPath, edited, "utf8");
  return "success";
}

async function writeTsconfigPathsAlias(cwd: string, telemetryDir: string): Promise<void> {
  const result = await applyTsconfigPathsAlias(cwd, telemetryDir);
  if (result === "success") {
    console.log("  ✓ tsconfig.json (~telemetry/* path alias)");
    return;
  }
  if (result === "already") {
    console.log("  · tsconfig.json already has ~telemetry/*");
    return;
  }
  if (result === "missing") {
    console.log("\ntsconfig.json not found — skipped path alias.");
    printTsconfigPathsHint();
    return;
  }
  printTsconfigPathsHint();
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
  hasAuth: boolean,
): string | null {
  if (explicit === "none") {
    return null;
  }
  if (explicit?.trim()) {
    return explicit.trim();
  }
  if (middlewareName && auto && hasAuth) {
    return "auth.user.signed_up";
  }
  return null;
}

function printNoStarterEventHint(): void {
  console.log("\nNo starter event scaffolded (no auth dependency detected). Add your first domain event:");
  console.log("  npx @useamplio/cli@alpha add event post.created");
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

  const service = await resolveServiceName(options.cwd, options.service);

  const loggerResult = await writeFileIfMissing(
    paths.logger,
    renderLoggerTemplate(service),
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
  const hasAuth = await hasAuthDependency(options.cwd);
  const middlewareName = resolveMiddlewareName(options.middleware, detected, auto);
  const eventName = resolveEventName(options.event, middlewareName, auto, hasAuth);
  const explicitEvent = options.event?.trim();

  if (detected && !middlewareName && !auto && options.middleware === undefined) {
    console.log(`\nDetected ${detected} in package.json.`);
  }

  if (middlewareName) {
    await runAddMiddleware(middlewareName, { cwd: options.cwd });
    const config = await readAmplioConfig(options.cwd);
    const telemetryDir = config?.telemetryDir ?? "telemetry";
    const srcLayout = (await resolveNextInstrumentationBase(options.cwd)) === "src";

    if (middlewareName === "next") {
      printNextWiringSnippet(telemetryDir, srcLayout);
    } else if (middlewareName === "trpc") {
      printTrpcWiringSnippet(telemetryDir, srcLayout);
    }
  }

  if (
    auto &&
    middlewareName === "next" &&
    (await hasDependency(options.cwd, "@trpc/server"))
  ) {
    await runAddMiddleware("trpc", { cwd: options.cwd });
    const config = await readAmplioConfig(options.cwd);
    const telemetryDir = config?.telemetryDir ?? "telemetry";
    const srcLayout = (await resolveNextInstrumentationBase(options.cwd)) === "src";
    printTrpcWiringSnippet(telemetryDir, srcLayout);
  }

  if (eventName) {
    await runAddEvent(eventName, { cwd: options.cwd });
  } else if (auto && middlewareName && !hasAuth && explicitEvent !== "none" && !explicitEvent) {
    printNoStarterEventHint();
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

    if ((await resolveNextInstrumentationBase(options.cwd)) === "src" && !options.paths) {
      printTsconfigPathsHint();
    }
  }

  if (!middlewareName && !eventName) {
    console.log("\nNext:");
    if (detected) {
      console.log(`  amplio add middleware ${detected}`);
    } else {
      console.log("  amplio add middleware hono");
    }
    console.log("  amplio add event post.created");
  }

  if (options.paths) {
    const config = await readAmplioConfig(options.cwd);
    const telemetryDir = config?.telemetryDir ?? "telemetry";
    await writeTsconfigPathsAlias(options.cwd, telemetryDir);
  }
}
