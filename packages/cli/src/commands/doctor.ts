import fs from "node:fs/promises";
import path from "node:path";
import { updateEventBarrels } from "./add.js";
import { eventNameToExport, eventNameToRelativePath } from "../utils/event-name.js";
import { aliasPrefixFromComponentsJson } from "../utils/components-json.js";
import { readAmplioConfig } from "../utils/config.js";
import { detectFramework } from "../utils/detect-framework.js";
import { detectPackageManager } from "../utils/detect-package-manager.js";
import { pathExists } from "../utils/fs.js";
import { parseJsonc } from "../utils/jsonc.js";
import { resolveProjectPaths } from "../utils/paths.js";
import { ALPHA_MD_URL } from "../help.js";

export interface DoctorOptions {
  cwd: string;
  fix?: boolean;
  strict?: boolean;
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
  const { cwd, fix = false, strict = false } = options;
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
      if (!/(^|\n)\s*amplio\.jsonl(\s|$)/m.test(gitignore)) {
        checks.push({
          status: "warning",
          message: "JSON sink present but amplio.jsonl not in .gitignore",
          fix: "Add amplio.jsonl to .gitignore (amplio add sink json does this automatically).",
        });
      } else {
        checks.push({ status: "passed", message: ".gitignore ignores amplio.jsonl" });
      }
    } else {
      checks.push({
        status: "warning",
        message: "JSON sink present but no .gitignore for amplio.jsonl",
        fix: "Run: amplio add sink json (or add amplio.jsonl to .gitignore manually).",
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
          status: "warning",
          message: `${relPath} scaffolded but ${exportName} is never imported by app code`,
          fix: `Wire the middleware in your app entry or route handlers — see ${ALPHA_MD_URL} for framework-specific snippets.`,
        });
      }
    }
  }

  console.log("amplio doctor\n");

  for (const check of checks) {
    printCheck(check);
    if (check.status === "warning") {
      warnings++;
    }
  }

  console.log("\nVerify an event end-to-end:");
  console.log(
    "  Hit a wrapped route and look for one JSON object with service, env, timestamp, duration_ms, request_id, success, and your event fields.",
  );
  console.log("  Console sink: stdout (one line per emit).");
  console.log("  JSON sink: amplio.jsonl in the project root (or AMPLIO_JSON_SINK_PATH).");

  if (hardFailures > 0) {
    return 1;
  }
  if (strict && warnings > 0) {
    return 1;
  }
  return 0;
}
