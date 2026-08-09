import fs from "node:fs/promises";
import path from "node:path";
import { updateEventBarrels } from "./add.js";
import { eventNameToExport, eventNameToRelativePath } from "../utils/event-name.js";
import { aliasPrefixFromComponentsJson } from "../utils/components-json.js";
import { readAmplioConfig } from "../utils/config.js";
import { detectFramework } from "../utils/detect-framework.js";
import { detectPackageManager } from "../utils/detect-package-manager.js";
import { coalesceBarrelExports, pathExists } from "../utils/fs.js";
import { parseJsonc } from "../utils/jsonc.js";
import { resolveProjectPaths } from "../utils/paths.js";
import {
  detectT3Layout,
  T3_NEXTAUTH_ROUTE_FILE,
  T3_ROUTE_FILE,
  T3_TRPC_FILE,
} from "../utils/wire-t3.js";
import { ALPHA_MD_URL } from "../help.js";

export interface DoctorOptions {
  cwd: string;
  fix?: boolean;
  strict?: boolean;
  verbose?: boolean;
}

type CheckStatus = "passed" | "warning" | "failed";

interface Check {
  status: CheckStatus;
  message: string;
  fix?: string;
}

const DEFINE_EVENT_RE = /defineEvent\s*\(\s*["']([^"']+)["']/g;
const LOGGER_SIDE_EFFECT_IMPORT_RE =
  /import\s+(?:[^;]*?from\s+)?["']\.\.\/logger["']/;
const TURBOPACK_MIDDLEWARE_FILES = ["next.ts", "trpc.ts"] as const;

const MIDDLEWARE_EXPORTS: Record<string, string> = {
  "next.ts": "withAmplio",
  "trpc.ts": "amplioTrpcMiddleware",
  "hono.ts": "amplioMiddleware",
  "express.ts": "amplioMiddleware",
  "fastify.ts": "amplioPlugin",
};

const APP_SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs"]);

const WALK_SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  "dist",
  "build",
  "coverage",
]);

async function walkAppSourceFiles(
  root: string,
  excludeDir: string,
): Promise<string[]> {
  const files: string[] = [];
  if (!(await pathExists(root))) {
    return files;
  }

  const excludeResolved = path.resolve(excludeDir);

  async function walk(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (WALK_SKIP_DIRS.has(entry.name)) {
          continue;
        }
        if (path.resolve(full) === excludeResolved) {
          continue;
        }
        await walk(full);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (APP_SOURCE_EXTENSIONS.has(ext)) {
          files.push(full);
        }
      }
    }
  }

  await walk(root);
  return files;
}

async function isMiddlewareExportReferenced(
  cwd: string,
  telemetryDir: string,
  exportName: string,
): Promise<boolean> {
  const appFiles = await walkAppSourceFiles(cwd, path.join(cwd, telemetryDir));
  for (const file of appFiles) {
    const source = await fs.readFile(file, "utf8");
    if (source.includes(exportName)) {
      return true;
    }
  }
  return false;
}

async function walkEventFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  if (!(await pathExists(dir))) {
    return files;
  }

  async function walk(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".ts") && entry.name !== "index.ts") {
        files.push(full);
      }
    }
  }

  await walk(dir);
  return files;
}

function barrelExportsName(barrelContent: string, exportName: string): boolean {
  return new RegExp(`export\\s*\\{[^}]*\\b${exportName}\\b`).test(barrelContent);
}

const BARREL_EXPORT_FROM_RE =
  /^\s*export\s*(\{[^}]*\}|\*)\s*from\s*["'](\.[^"']*)["'];?\s*$/;

async function collectBarrelFiles(eventsDir: string): Promise<string[]> {
  const barrels: string[] = [];
  if (!(await pathExists(eventsDir))) {
    return barrels;
  }

  async function walk(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name === "index.ts") {
        barrels.push(full);
      }
    }
  }

  await walk(eventsDir);
  return barrels;
}

async function resolveBarrelSpecifier(
  baseDir: string,
  specifier: string,
): Promise<string | null> {
  const resolved = path.resolve(baseDir, specifier);
  const candidates = [`${resolved}.ts`, `${resolved}.tsx`, path.join(resolved, "index.ts")];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** Raw entries of an `export { A, B as C }` clause; empty for `export *`. */
function exportClauseEntries(clause: string): string[] {
  if (clause === "*") {
    return [];
  }
  return clause
    .replace(/[{}]/g, "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function sourceNameOfEntry(entry: string): string {
  return entry.split(/\s+as\s+/)[0]!.trim();
}

interface StaleBarrelResult {
  content: string;
  stale: string[];
}

/**
 * Reverse-direction barrel check: every `export … from "./x"` must resolve to
 * a file that still exists and still exports the referenced names. Returns the
 * pruned content plus a description of each stale export found.
 */
async function pruneStaleBarrelExports(barrelPath: string): Promise<StaleBarrelResult> {
  const baseDir = path.dirname(barrelPath);
  const original = await fs.readFile(barrelPath, "utf8");
  const lines = original.split("\n");
  const kept: string[] = [];
  const stale: string[] = [];

  for (const line of lines) {
    const match = BARREL_EXPORT_FROM_RE.exec(line);
    if (!match) {
      kept.push(line);
      continue;
    }

    const specifier = match[2]!;
    const target = await resolveBarrelSpecifier(baseDir, specifier);
    if (!target) {
      stale.push(`"${specifier}" does not resolve to a file`);
      continue;
    }

    const entries = exportClauseEntries(match[1]!);
    if (entries.length === 0) {
      kept.push(line);
      continue;
    }

    const targetContent = await fs.readFile(target, "utf8");
    const liveEntries = entries.filter((entry) =>
      new RegExp(`export[^;]*\\b${sourceNameOfEntry(entry)}\\b`).test(targetContent),
    );

    if (liveEntries.length === entries.length) {
      kept.push(line);
      continue;
    }

    const missing = entries
      .filter((entry) => !liveEntries.includes(entry))
      .map(sourceNameOfEntry);
    stale.push(`"${specifier}" no longer exports ${missing.join(", ")}`);
    if (liveEntries.length > 0) {
      kept.push(`export { ${liveEntries.join(", ")} } from "${specifier}";`);
    }
  }

  let content = kept.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
  if (!/\S/.test(content)) {
    // An empty file is not a module under isolatedModules — keep it importable.
    content = "export {};\n";
  } else if (!content.endsWith("\n")) {
    content = `${content}\n`;
  }

  return { content, stale };
}

function devScriptUsesTurbo(pkg: { scripts?: Record<string, string> }): boolean {
  const dev = pkg.scripts?.dev ?? "";
  return /--turbo\b|--turbopack\b/.test(dev);
}

async function tsconfigHasAliasPrefix(cwd: string, prefix: string): Promise<boolean> {
  const tsconfigPath = path.join(cwd, "tsconfig.json");
  if (!(await pathExists(tsconfigPath))) {
    return false;
  }
  try {
    const raw = await fs.readFile(tsconfigPath, "utf8");
    const config = parseJsonc<{ compilerOptions?: { paths?: Record<string, string[]> } }>(raw);
    const paths = config.compilerOptions?.paths ?? {};
    const pattern = `${prefix}/*`;
    return pattern in paths;
  } catch {
    return false;
  }
}

function printCheck(check: Check): void {
  const icon = check.status === "passed" ? "✓" : check.status === "warning" ? "!" : "✗";
  console.log(`  ${icon} ${check.message}`);
  if (check.fix) {
    console.log(`    fix: ${check.fix}`);
  }
}

export async function runDoctor(options: DoctorOptions): Promise<number> {
  const { cwd, fix = false, strict = false, verbose = false } = options;
  const checks: Check[] = [];
  let hardFailures = 0;
  let warnings = 0;

  const pkgPath = path.join(cwd, "package.json");
  if (!(await pathExists(pkgPath))) {
    checks.push({
      status: "failed",
      message: "package.json not found",
      fix: "Run amplio init from your project root.",
    });
    hardFailures++;
  } else {
    const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const amplioRange = deps["@useamplio/amplio"];
    if (!amplioRange) {
      checks.push({
        status: "failed",
        message: "@useamplio/amplio missing from package.json",
        fix: "Run: pnpm add @useamplio/amplio (or npm/yarn/bun equivalent).",
      });
      hardFailures++;
    } else if (amplioRange === "*") {
      checks.push({
        status: "warning",
        message: '@useamplio/amplio range is "*"',
        fix: "Pin to a semver range (e.g. ^0.1.0-alpha.7).",
      });
    } else {
      checks.push({
        status: "passed",
        message: `@useamplio/amplio present (${amplioRange})`,
      });
    }
  }

  const config = await readAmplioConfig(cwd);
  if (!config) {
    checks.push({
      status: "warning",
      message: "amplio.json not found",
      fix: "Run: amplio init",
    });
  } else {
    checks.push({ status: "passed", message: "amplio.json exists" });
    const detectedPm = await detectPackageManager(cwd);
    if (config.packageManager && config.packageManager !== detectedPm) {
      checks.push({
        status: "warning",
        message: `amplio.json packageManager is "${config.packageManager}" but detected "${detectedPm}"`,
        fix: `Update amplio.json packageManager to "${detectedPm}" or align lockfiles.`,
      });
    } else {
      checks.push({
        status: "passed",
        message: `packageManager matches detection (${detectedPm})`,
      });
    }
  }

  const telemetryDir = config?.telemetryDir ?? "telemetry";
  const paths = resolveProjectPaths(cwd, telemetryDir);

  if (!(await pathExists(paths.logger))) {
    checks.push({
      status: "failed",
      message: "telemetry/logger.ts missing",
      fix: "Run: amplio init",
    });
    hardFailures++;
  } else {
    const loggerSource = await fs.readFile(paths.logger, "utf8");
    if (/init\s*\(/.test(loggerSource)) {
      checks.push({ status: "passed", message: "telemetry/logger.ts calls init()" });
    } else {
      checks.push({
        status: "failed",
        message: "telemetry/logger.ts does not call init()",
        fix: "Add init({ service, env, sinks, enrichers }) to telemetry/logger.ts.",
      });
      hardFailures++;
    }
  }

  const framework = await detectFramework(cwd);
  let hasNext = framework === "next";
  if (!hasNext && (await pathExists(pkgPath))) {
    const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    hasNext = "next" in { ...pkg.dependencies, ...pkg.devDependencies };
  }

  let pkgScripts: { scripts?: Record<string, string> } | null = null;
  if (await pathExists(pkgPath)) {
    pkgScripts = JSON.parse(await fs.readFile(pkgPath, "utf8")) as {
      scripts?: Record<string, string>;
    };
  }

  if (hasNext) {
    const instrumentationCandidates = [
      path.join(cwd, "src/instrumentation.ts"),
      path.join(cwd, "src/instrumentation.js"),
      path.join(cwd, "instrumentation.ts"),
      path.join(cwd, "instrumentation.js"),
    ];
    let instrumentationPath: string | null = null;
    for (const candidate of instrumentationCandidates) {
      if (await pathExists(candidate)) {
        instrumentationPath = candidate;
        break;
      }
    }

    if (!instrumentationPath) {
      checks.push({
        status: "warning",
        message: "Next.js instrumentation.ts/.js not found",
        fix: "Create instrumentation.ts that imports telemetry/logger, or add a side-effect import at your server entry.",
      });
    } else {
      const content = await fs.readFile(instrumentationPath, "utf8");
      if (/telemetry\/logger/.test(content)) {
        checks.push({
          status: "passed",
          message: `${path.relative(cwd, instrumentationPath)} references telemetry/logger`,
        });
        // Next compiles instrumentation.ts for the Edge runtime too; an
        // unguarded import of telemetry/ (node:fs via the JSON sink, etc.)
        // spams "not supported in the Edge Runtime" on every compile.
        if (!content.includes("NEXT_RUNTIME")) {
          checks.push({
            status: "warning",
            message: `${path.relative(cwd, instrumentationPath)} imports telemetry/logger without a NEXT_RUNTIME guard — Edge-runtime compiles will warn once telemetry/ pulls in node: builtins`,
            fix: 'Wrap the import: if (process.env.NEXT_RUNTIME === "nodejs") { await import("../telemetry/logger"); }',
          });
        }
      } else {
        checks.push({
          status: "warning",
          message: `${path.relative(cwd, instrumentationPath)} exists but does not import telemetry/logger`,
          fix: "Add `await import(\"./telemetry/logger\")` (or ../ path from src/) inside register().",
        });
      }
    }

    const turboSuffix =
      pkgScripts && devScriptUsesTurbo(pkgScripts) ? " (your dev script uses --turbo)" : "";
    const middlewareDir = path.join(paths.telemetry, "middleware");

    for (const middlewareFile of TURBOPACK_MIDDLEWARE_FILES) {
      const middlewarePath = path.join(middlewareDir, middlewareFile);
      if (!(await pathExists(middlewarePath))) {
        continue;
      }

      const content = await fs.readFile(middlewarePath, "utf8");
      if (LOGGER_SIDE_EFFECT_IMPORT_RE.test(content)) {
        continue;
      }

      const relPath = path.relative(cwd, middlewarePath).replace(/\\/g, "/");
      const middlewareId = middlewareFile.replace(/\.ts$/, "");
      checks.push({
        status: "warning",
        message: `${relPath} does not import "../logger" — under next dev --turbo, init() from instrumentation.ts may not reach this module graph and events drop silently${turboSuffix}`,
        fix: `Add \`import "../logger";\` at the top of the file, or regenerate with: amplio add middleware ${middlewareId} --force (templates now include it). Runtime >=0.1.0-alpha.8 also shares init() across module graphs.`,
      });
    }
  }

  const eventFiles = await walkEventFiles(paths.events);
  for (const file of eventFiles) {
    const source = await fs.readFile(file, "utf8");
    DEFINE_EVENT_RE.lastIndex = 0;
    for (const match of source.matchAll(DEFINE_EVENT_RE)) {
      const eventName = match[1]!;
      const expected = eventNameToRelativePath(eventName);
      const actual = path.relative(paths.telemetry, file).replace(/\\/g, "/");
      if (actual !== expected) {
        checks.push({
          status: "warning",
          message: `Event "${eventName}" path mismatch: ${actual} (expected ${expected})`,
          fix: `Rename to ${expected} or update defineEvent name to match the file path.`,
        });
        continue;
      }

      const exportName = eventNameToExport(eventName);
      const domainDir = path.dirname(expected);
      const domainBarrelPath = path.join(paths.telemetry, domainDir, "index.ts");
      const rootBarrelPath = path.join(paths.events, "index.ts");

      let domainBarrelOk = false;
      let rootBarrelOk = false;

      if (await pathExists(domainBarrelPath)) {
        const domainBarrel = await fs.readFile(domainBarrelPath, "utf8");
        domainBarrelOk = barrelExportsName(domainBarrel, exportName);
      }

      if (await pathExists(rootBarrelPath)) {
        const rootBarrel = await fs.readFile(rootBarrelPath, "utf8");
        rootBarrelOk = barrelExportsName(rootBarrel, exportName);
      }

      if (!domainBarrelOk || !rootBarrelOk) {
        if (fix) {
          await updateEventBarrels(cwd, telemetryDir, expected, exportName);
          checks.push({
            status: "passed",
            message: `Fixed barrel exports for ${eventName}`,
          });
        } else {
          const missing: string[] = [];
          if (!domainBarrelOk) {
            missing.push(path.relative(cwd, domainBarrelPath).replace(/\\/g, "/"));
          }
          if (!rootBarrelOk) {
            missing.push(path.relative(cwd, rootBarrelPath).replace(/\\/g, "/"));
          }
          checks.push({
            status: "warning",
            message: `Event "${eventName}" missing from barrel export(s): ${missing.join(", ")}`,
            fix: `Run: amplio doctor --fix (regenerates barrel exports), or amplio add event ${eventName}.`,
          });
        }
      }
    }
  }

  if (eventFiles.length > 0) {
    checks.push({
      status: "passed",
      message: `Checked ${eventFiles.length} event file(s) for name/path alignment`,
    });
  }

  // Reverse direction: barrels must not export files that no longer exist
  // (e.g. an event directory was deleted but the root barrel line remains —
  // tsc fails with TS2307 while the forward check stays green).
  // Deepest barrels first so a pruned domain barrel is what the root barrel
  // is validated (and re-pruned) against.
  const barrelFiles = (await collectBarrelFiles(paths.events)).sort(
    (a, b) => b.split(path.sep).length - a.split(path.sep).length,
  );
  for (const barrelPath of barrelFiles) {
    const relBarrel = path.relative(cwd, barrelPath).replace(/\\/g, "/");
    const { content, stale } = await pruneStaleBarrelExports(barrelPath);
    // While rewriting anyway, merge repeated `export { X } from "./m";`
    // statements for the same module into one (harmless, so no warning in
    // non-fix mode — --fix just tidies them up).
    const coalesced = coalesceBarrelExports(content);
    if (fix) {
      const original = await fs.readFile(barrelPath, "utf8");
      if (coalesced !== original) {
        await fs.writeFile(barrelPath, coalesced, "utf8");
      }
      if (stale.length > 0) {
        checks.push({
          status: "passed",
          message: `Pruned stale export(s) from ${relBarrel}: ${stale.join("; ")}`,
        });
      } else if (coalesced !== original) {
        checks.push({
          status: "passed",
          message: `Coalesced duplicate module exports in ${relBarrel}`,
        });
      }
    } else if (stale.length > 0) {
      checks.push({
        status: "warning",
        message: `${relBarrel} has stale export(s): ${stale.join("; ")} — tsc will fail with TS2307/TS2305`,
        fix: "Run: amplio doctor --fix (prunes exports whose targets no longer resolve).",
      });
    }
  }

  const eventsIndex = path.join(paths.events, "index.ts");
  if (await pathExists(eventsIndex)) {
    const barrel = (await fs.readFile(eventsIndex, "utf8")).trim();
    if (barrel === "export {};") {
      checks.push({
        status: "warning",
        message: "events/index.ts is an empty barrel (export {});",
        fix: "Remove it or add exports — amplio add event will populate it.",
      });
    }
  }

  const jsonSinkPath = path.join(paths.sinks, "json.ts");
  if (await pathExists(jsonSinkPath)) {
    const gitignorePath = path.join(cwd, ".gitignore");
    if (await pathExists(gitignorePath)) {
      const gitignore = await fs.readFile(gitignorePath, "utf8");
      if (/(^|\n)\s*amplio\*\.jsonl(\s|$)/m.test(gitignore)) {
        checks.push({ status: "passed", message: ".gitignore ignores amplio*.jsonl" });
      } else if (/(^|\n)\s*amplio\.jsonl(\s|$)/m.test(gitignore)) {
        checks.push({
          status: "warning",
          message:
            ".gitignore covers amplio.jsonl only — the JSON sink default file name now includes the env (amplio.development.jsonl, …)",
          fix: "Widen the entry to amplio*.jsonl (re-running amplio add sink json does this).",
        });
      } else {
        checks.push({
          status: "warning",
          message: "JSON sink present but amplio*.jsonl not in .gitignore",
          fix: "Add amplio*.jsonl to .gitignore (amplio add sink json does this automatically).",
        });
      }
    } else {
      checks.push({
        status: "warning",
        message: "JSON sink present but no .gitignore for amplio*.jsonl",
        fix: "Run: amplio add sink json (or add amplio*.jsonl to .gitignore manually).",
      });
    }
  }

  const componentsPath = path.join(cwd, "components.json");
  if (await pathExists(componentsPath)) {
    try {
      const components = JSON.parse(await fs.readFile(componentsPath, "utf8")) as {
        aliases?: Record<string, string>;
      };
      const prefix = aliasPrefixFromComponentsJson(components);
      if (prefix && !(await tsconfigHasAliasPrefix(cwd, prefix))) {
        checks.push({
          status: "warning",
          message: `components.json aliases use "${prefix}/*" but tsconfig paths do not define it`,
          fix: `Add "${prefix}/*" to tsconfig.json compilerOptions.paths or update components.json aliases.`,
        });
      }
    } catch {
      // best effort
    }
  }

  const middlewareDir = path.join(paths.telemetry, "middleware");
  if (await pathExists(middlewareDir)) {
    const middlewareEntries = await fs.readdir(middlewareDir, { withFileTypes: true });
    for (const entry of middlewareEntries) {
      if (!entry.isFile()) {
        continue;
      }
      const exportName = MIDDLEWARE_EXPORTS[entry.name];
      if (!exportName) {
        continue;
      }
      const referenced = await isMiddlewareExportReferenced(cwd, telemetryDir, exportName);
      if (!referenced) {
        const relPath = path.relative(cwd, path.join(middlewareDir, entry.name)).replace(/\\/g, "/");
        checks.push({
          status: "failed",
          message: `${relPath} scaffolded but ${exportName} is never imported by app code — no events will be emitted`,
          fix: `Wire the middleware in your app entry or route handlers (create-t3-app: run \`amplio init --wire\`) — see ${ALPHA_MD_URL} for framework-specific snippets.`,
        });
        hardFailures++;
      }
    }
  }

  // App-side wiring drift: init wired route.ts / trpc.ts once, but those are
  // exactly the files most likely to lose the edit in a merge or a T3
  // upgrade. The generic "export never referenced" check above misses this
  // when the export survives somewhere else (e.g. another wrapped route).
  {
    const layout = await detectT3Layout(cwd);
    const t3Checks: Array<{
      present: boolean;
      middlewareFile: string;
      appFile: string;
      marker: string;
      consequence: string;
    }> = [
      {
        present: layout.routeFile,
        middlewareFile: "next.ts",
        appFile: T3_ROUTE_FILE,
        marker: "withAmplio",
        consequence: "tRPC HTTP requests emit no spine",
      },
      {
        present: layout.trpcFile,
        middlewareFile: "trpc.ts",
        appFile: T3_TRPC_FILE,
        marker: "amplioTrpcMiddleware",
        consequence: "procedures no longer annotate the request spine",
      },
      {
        present:
          layout.nextAuthRouteFile &&
          (await pathExists(path.join(paths.integrations, "next-auth.ts"))),
        middlewareFile: "next.ts",
        appFile: T3_NEXTAUTH_ROUTE_FILE,
        marker: "withAmplio",
        consequence: "NextAuth event rows emit outside request scope (no request_id)",
      },
    ];

    for (const t3Check of t3Checks) {
      if (
        !t3Check.present ||
        !(await pathExists(path.join(paths.telemetry, "middleware", t3Check.middlewareFile)))
      ) {
        continue;
      }
      const source = await fs.readFile(path.join(cwd, t3Check.appFile), "utf8");
      if (source.includes(t3Check.marker)) {
        checks.push({
          status: "passed",
          message: `${t3Check.appFile} references ${t3Check.marker}`,
        });
      } else {
        checks.push({
          status: "warning",
          message: `${t3Check.appFile} no longer references ${t3Check.marker} — ${t3Check.consequence}. Wiring is lost most often in a merge or T3 upgrade.`,
          fix: "Run: amplio init --wire (re-wires the stock create-t3-app shape), or re-add the wrapper manually.",
        });
      }
    }
  }

  const sinksDir = paths.sinks;
  if ((await pathExists(sinksDir)) && (await pathExists(paths.logger))) {
    const loggerSource = await fs.readFile(paths.logger, "utf8");
    const sinkEntries = await fs.readdir(sinksDir, { withFileTypes: true });
    for (const entry of sinkEntries) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) {
        continue;
      }
      const sinkId = entry.name.replace(/\.ts$/, "");
      if (loggerSource.includes(`sinks/${sinkId}`)) {
        continue;
      }
      const relPath = path.relative(cwd, path.join(sinksDir, entry.name)).replace(/\\/g, "/");
      const relLogger = path.relative(cwd, paths.logger).replace(/\\/g, "/");
      checks.push({
        status: "warning",
        message: `${relPath} exists but is not referenced in ${relLogger} — events will not reach this sink`,
        fix: `Run: amplio add sink ${sinkId} (auto-wires logger.ts), or import it and add it to the init() sinks array.`,
      });
    }
  }

  console.log("amplio doctor\n");

  for (const check of checks) {
    printCheck(check);
    if (check.status === "warning") {
      warnings++;
    }
  }

  // Print the end-to-end epilogue only when it is likely to be read: after a
  // fix, when something needs attention, or on request. All-green runs stay
  // quiet so the epilogue doesn't train users to skim past it.
  if (fix || warnings > 0 || hardFailures > 0 || verbose) {
    console.log("\nVerify an event end-to-end:");
    console.log(
      "  Hit a wrapped route and look for one JSON object with service, env, timestamp, duration_ms, request_id, success, and your event fields.",
    );
    console.log("  Console sink: stdout (one line per emit).");
    console.log(
      "  JSON sink: amplio.<env>.jsonl in the project root (or AMPLIO_JSON_SINK_PATH).",
    );
    console.log("  Or let the CLI do it: amplio smoke <url> (requires the JSON sink).");
  }

  // Bottom-line summary so warnings above the epilogue are not skimmed past.
  if (hardFailures > 0) {
    console.log(
      `\n✗ ${hardFailures} check(s) failed${warnings > 0 ? `, ${warnings} warning(s)` : ""} — see the fix: lines above`,
    );
    return 1;
  }
  if (strict && warnings > 0) {
    console.log(`\n⚠ ${warnings} warning(s) — failing because --strict is set`);
    return 1;
  }
  if (warnings > 0) {
    console.log(
      `\n⚠ ${warnings} warning(s) (exit 0 with warnings — use --strict to fail on warnings, e.g. in CI)`,
    );
  }
  return 0;
}
