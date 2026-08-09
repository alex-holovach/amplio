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
import { formatGeneratedFiles } from "../utils/format-files.js";
import { ensureRuntimeDependencies } from "../utils/install-deps.js";
import { parseJsonc } from "../utils/jsonc.js";
import { resolveProjectPaths } from "../utils/paths.js";
import { registryPathForConfig } from "../utils/registry-path.js";
import {
  detectT3Layout,
  hasTelemetryPathAlias,
  middlewareImportForFile,
  T3_ROUTE_FILE,
  T3_TRPC_FILE,
  wireT3RouteHandler,
  wireT3TrpcProcedures,
  type WireResult,
} from "../utils/wire-t3.js";

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
  wire?: boolean;
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

/**
 * Resolve the import path to print in wiring snippets. Prefers the ~telemetry
 * alias when tsconfig defines it; otherwise computes the exact relative path
 * from the known T3 file when present, so pasted snippets resolve first try.
 */
async function snippetImportPath(
  cwd: string,
  telemetryDir: string,
  middlewareName: "next" | "trpc",
  srcLayout: boolean,
): Promise<string> {
  if (await hasTelemetryPathAlias(cwd, telemetryDir)) {
    return `~telemetry/middleware/${middlewareName}`;
  }
  const knownFile = middlewareName === "next" ? T3_ROUTE_FILE : T3_TRPC_FILE;
  if (await pathExists(path.join(cwd, knownFile))) {
    return middlewareImportForFile(cwd, telemetryDir, knownFile, middlewareName);
  }
  return middlewareImportPath(telemetryDir, middlewareName, srcLayout);
}

function printNextWiringSnippet(importPath: string): void {
  console.log("\nWire Next.js route handlers:");
  console.log(`  import { withAmplio } from "${importPath}";`);
  console.log("  export const GET = withAmplio(async (request) => {");
  console.log("    // handler body");
  console.log("  });");
}

function printTrpcWiringSnippet(importPath: string): void {
  console.log(`\nWire tRPC middleware (see ${ALPHA_MD_URL} ## tRPC (v11)):`);
  console.log(`  T3 / create-t3-app walkthrough: ${T3_MD_URL}`);
  console.log(`  import { amplioTrpcMiddleware } from "${importPath}";`);
  console.log("  const amplioMw = t.middleware(amplioTrpcMiddleware());");
  console.log("  publicProcedure.use(amplioMw);");
}

function printWireResult(result: WireResult, action: string): boolean {
  if (result.status === "wired") {
    console.log(`  ✓ ${result.file} (${action})`);
    return true;
  }
  if (result.status === "already") {
    console.log(`  · ${result.file} already wired`);
    return true;
  }
  if (result.status === "unrecognized") {
    console.log(
      `  ! ${result.file} does not match the create-t3-app shape — wire it manually:`,
    );
  }
  return false;
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

function printNoStarterEventHint(packageManager: string): void {
  console.log("\nNo starter event scaffolded (no auth dependency detected). Add your first domain event:");
  console.log(`  ${scriptRunCommand(packageManager, "amplio add event post.created")}`);
}

/** Any real event file (not a barrel) under telemetry/events/? */
async function hasExistingEvents(eventsDir: string): Promise<boolean> {
  if (!(await pathExists(eventsDir))) {
    return false;
  }

  async function walk(current: string): Promise<boolean> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (await walk(full)) {
          return true;
        }
      } else if (entry.isFile() && entry.name.endsWith(".ts") && entry.name !== "index.ts") {
        return true;
      }
    }
    return false;
  }

  return walk(eventsDir);
}

function scriptRunCommand(packageManager: string, script: string): string {
  // npm and bun need `run` to invoke package scripts; pnpm and yarn run them directly.
  if (packageManager === "npm" || packageManager === "bun") {
    return `${packageManager} run ${script}`;
  }
  return `${packageManager} ${script}`;
}

function devInstallCommand(packageManager: string, pkg: string): string {
  if (packageManager === "npm") {
    return `npm install -D ${pkg}`;
  }
  if (packageManager === "bun") {
    return `bun add -d ${pkg}`;
  }
  return `${packageManager} add -D ${pkg}`;
}

/**
 * Add an `"amplio": "amplio"` script so follow-up commands are e.g.
 * `pnpm amplio doctor` / `npm run amplio doctor` instead of a fresh npx
 * resolve. The CLI itself is installed as a devDependency by
 * ensureRuntimeDependencies; when that was skipped, print the install command
 * so the script is not broken out of the box.
 */
async function ensureAmplioScript(cwd: string, packageManager: string): Promise<void> {
  const pkgPath = path.join(cwd, "package.json");
  if (!(await pathExists(pkgPath))) {
    return;
  }

  try {
    const raw = await fs.readFile(pkgPath, "utf8");
    const pkg = JSON.parse(raw) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    const hasCliDep =
      pkg.dependencies?.["@useamplio/cli"] !== undefined ||
      pkg.devDependencies?.["@useamplio/cli"] !== undefined;

    if (pkg.scripts?.amplio === undefined) {
      pkg.scripts = { ...pkg.scripts, amplio: "amplio" };
      const trailing = raw.endsWith("\n") ? "\n" : "";
      await fs.writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}${trailing}`, "utf8");
      console.log(
        `  ✓ package.json ("amplio" script — run \`${scriptRunCommand(packageManager, "amplio doctor")}\`)`,
      );
    }

    if (!hasCliDep) {
      console.log(
        `\nThe "amplio" script needs the CLI as a devDependency (install was skipped):`,
      );
      console.log(`  ${devInstallCommand(packageManager, "@useamplio/cli@alpha")}`);
    }
  } catch {
    // best effort — leave package.json alone if it does not parse
  }
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

  const existing = (await pathExists(instrumentationTs))
    ? instrumentationTs
    : (await pathExists(instrumentationJs))
      ? instrumentationJs
      : null;
  if (existing) {
    // Re-runs should read like the first run: `·` when wired, hint when not.
    const content = await fs.readFile(existing, "utf8");
    if (/telemetry\/logger/.test(content)) {
      console.log(`  · ${path.relative(cwd, existing)} already wired`);
    } else {
      console.log(
        "\nNext.js: ensure instrumentation.ts imports your telemetry/logger so init() runs at boot.",
      );
    }
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
    renderLoggerTemplate(service, scriptRunCommand(packageManager, "amplio doctor")),
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
    withCliDevDependency: true,
  });

  // Apply the tsconfig alias before wiring so wired imports can use ~telemetry/*.
  if (options.paths) {
    const config = await readAmplioConfig(options.cwd);
    const telemetryDir = config?.telemetryDir ?? "telemetry";
    await writeTsconfigPathsAlias(options.cwd, telemetryDir);
  }

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
  }

  const addTrpcMiddleware =
    auto &&
    middlewareName === "next" &&
    (await hasDependency(options.cwd, "@trpc/server"));
  if (addTrpcMiddleware) {
    await runAddMiddleware("trpc", { cwd: options.cwd });
  }

  if (eventName) {
    await runAddEvent(eventName, { cwd: options.cwd });
  }

  // Scaffolding continues (instrumentation, package.json script) before the
  // wiring/verify sections so the output reads scaffold → wire → verify → tips.
  const instrumentationCreated: string[] = [];
  const isNext =
    detected === "next" || middlewareName === "next" || (await hasDependency(options.cwd, "next"));
  if (isNext) {
    const config = await readAmplioConfig(options.cwd);
    const telemetryDir = config?.telemetryDir ?? "telemetry";
    const loggerPath = path.join(options.cwd, telemetryDir, "logger.ts");
    const instrumentationResult = await scaffoldNextInstrumentation(
      options.cwd,
      telemetryDir,
      loggerPath,
    );
    if (instrumentationResult === "created") {
      const base = await resolveNextInstrumentationBase(options.cwd);
      instrumentationCreated.push(
        base ? `${base}/instrumentation.ts` : "instrumentation.ts",
      );
    }
  }

  await ensureAmplioScript(options.cwd, packageManager);

  const wiredFiles: string[] = [];
  let t3LayoutDetected = false;
  {
    const config = await readAmplioConfig(options.cwd);
    const telemetryDir = config?.telemetryDir ?? "telemetry";
    const srcLayout = (await resolveNextInstrumentationBase(options.cwd)) === "src";
    const layout = await detectT3Layout(options.cwd);
    t3LayoutDetected = Boolean(layout.routeFile || layout.trpcFile);
    const wantWire = options.wire === true || auto;
    const nextMiddlewarePresent = await pathExists(
      path.join(options.cwd, telemetryDir, "middleware", "next.ts"),
    );
    const trpcMiddlewarePresent = await pathExists(
      path.join(options.cwd, telemetryDir, "middleware", "trpc.ts"),
    );

    let routeHandled = false;
    let trpcHandled = false;

    if (wantWire && (layout.routeFile || layout.trpcFile)) {
      console.log("\nWiring create-t3-app layout:");
      if (layout.routeFile && nextMiddlewarePresent) {
        const result = await wireT3RouteHandler(options.cwd, telemetryDir);
        routeHandled = printWireResult(result, "wrapped tRPC fetch handler with withAmplio");
        if (result.status === "wired") {
          wiredFiles.push(result.file);
        }
      }
      if (layout.trpcFile && trpcMiddlewarePresent) {
        const result = await wireT3TrpcProcedures(options.cwd, telemetryDir);
        trpcHandled = printWireResult(
          result,
          "prepended amplioTrpcMiddleware to publicProcedure/protectedProcedure",
        );
        if (result.status === "wired") {
          wiredFiles.push(result.file);
        }
      }
    }

    if (nextMiddlewarePresent && middlewareName === "next" && !routeHandled) {
      printNextWiringSnippet(
        await snippetImportPath(options.cwd, telemetryDir, "next", srcLayout),
      );
    }
    if (
      trpcMiddlewarePresent &&
      (middlewareName === "trpc" || addTrpcMiddleware) &&
      !trpcHandled
    ) {
      printTrpcWiringSnippet(
        await snippetImportPath(options.cwd, telemetryDir, "trpc", srcLayout),
      );
    }

    if (!wantWire && (layout.routeFile || layout.trpcFile) && (nextMiddlewarePresent || trpcMiddlewarePresent)) {
      console.log(
        "\nDetected a create-t3-app layout — run `amplio init --wire` to wire the route handler and tRPC procedures automatically.",
      );
    }
  }

  if (isNext) {
    console.log("\nVerify:");
    console.log("  1. Start your dev server");
    console.log(
      "  2. curl any route wrapped with amplio middleware — confirm the port Next actually bound (it moves to 3001+ if 3000 is busy; a wrong-port curl looks identical to dropped events)",
    );
    console.log("  3. Expect one JSON line on stdout (console sink)");
    console.log(`  4. ${scriptRunCommand(packageManager, "amplio doctor")}`);
  }

  if (t3LayoutDetected) {
    console.log(
      `\nT3 / create-t3-app guide: node_modules/@useamplio/amplio/docs/t3.md (also ${T3_MD_URL})`,
    );
  }

  if (
    !eventName &&
    auto &&
    middlewareName &&
    !hasAuth &&
    explicitEvent !== "none" &&
    !explicitEvent &&
    !(await hasExistingEvents(paths.events))
  ) {
    printNoStarterEventHint(packageManager);
  }

  if (
    isNext &&
    (await resolveNextInstrumentationBase(options.cwd)) === "src" &&
    !options.paths
  ) {
    printTsconfigPathsHint();
  }

  if (!middlewareName && !eventName) {
    console.log("\nNext:");
    if (detected) {
      console.log(`  amplio add middleware ${detected}`);
      console.log("  amplio add event post.created");
    } else {
      console.log("  amplio add event post.created");
      console.log(
        "  No framework detected — middleware available: next, hono, express, fastify, trpc",
      );
    }
  }

  {
    const config = await readAmplioConfig(options.cwd);
    const telemetryDir = config?.telemetryDir ?? "telemetry";
    const formatted = await formatGeneratedFiles(options.cwd, [
      telemetryDir,
      ...instrumentationCreated,
      ...wiredFiles,
    ]);
    if (formatted) {
      console.log(`  ✓ formatted generated files with ${formatted}`);
    }
  }
}
