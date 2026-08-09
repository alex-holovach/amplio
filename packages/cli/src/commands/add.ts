import path from "node:path";
import {
  assertValidEventName,
  eventNameToExport,
  eventNameToRegistryId,
  eventNameToRelativePath,
} from "../utils/event-name.js";
import { readAmplioConfig, resolveRegistryPath } from "../utils/config.js";
import { formatGeneratedFiles } from "../utils/format-files.js";
import fs from "node:fs/promises";
import { ensureDir, pathExists, upsertBarrelExport, writeFileOrSkip } from "../utils/fs.js";
import { updateLoggerWithEnricher } from "../utils/logger-enricher.js";
import { updateLoggerWithSink } from "../utils/logger-sink.js";
import { resolveProjectPaths } from "../utils/paths.js";
import {
  assertRegistryExists,
  findRegistryItem,
  loadRegistry,
  resolveRegistryDependencies,
} from "../registry/resolve.js";
import { installRegistryItem, mergePackageDependencies } from "../registry/install.js";
import { renderAuthUserSignedUpEvent, renderEventTemplate } from "../templates/event.js";
import { findDependency, INTEGRATION_DEP_RULES } from "../utils/has-dep.js";
import { hasTelemetryPathAlias } from "../utils/wire-t3.js";
import { T3_MD_URL } from "../help.js";

const MIDDLEWARE_IDS = new Set(["hono", "express", "next", "fastify", "trpc"]);
const SINK_IDS = new Set(["console", "otlp", "json"]);
const ENRICHER_REGISTRY_IDS = new Set([
  "service-metadata",
  "request-metadata",
  "query-allowlist",
]);
const ENRICHER_ALIASES: Record<string, string> = { request: "request-metadata" };

function resolveEnricherId(id: string): string {
  return ENRICHER_ALIASES[id] ?? id;
}

async function appendGitignoreJsonSink(
  cwd: string,
  dryRun = false,
): Promise<"created" | "updated" | "skipped"> {
  const gitignorePath = path.join(cwd, ".gitignore");
  // Glob, not exact: the sink's default file name includes the env
  // (amplio.development.jsonl, amplio.production.jsonl, …).
  const block = "# amplio JSON sink output\namplio*.jsonl\n";

  if (await pathExists(gitignorePath)) {
    const current = await fs.readFile(gitignorePath, "utf8");
    if (/(^|\n)\s*amplio\*\.jsonl(\s|$)/m.test(current)) {
      return "skipped";
    }
    if (/(^|\n)\s*amplio\.jsonl(\s|$)/m.test(current)) {
      // Legacy exact entry from older CLIs — widen it to the env-aware glob.
      if (!dryRun) {
        const next = current.replace(
          /(^|\n)(\s*)amplio\.jsonl(?=\s|$)/m,
          "$1$2amplio*.jsonl",
        );
        await fs.writeFile(gitignorePath, next, "utf8");
      }
      return "updated";
    }
    if (!dryRun) {
      const next = current.endsWith("\n") ? `${current}${block}` : `${current}\n${block}`;
      await fs.writeFile(gitignorePath, next, "utf8");
    }
    return "updated";
  }

  if (!dryRun) {
    await fs.writeFile(gitignorePath, block, "utf8");
  }
  return "created";
}

async function appendEnvExampleJsonSink(
  cwd: string,
  dryRun = false,
): Promise<"updated" | "skipped"> {
  const envExamplePath = path.join(cwd, ".env.example");
  if (!(await pathExists(envExamplePath))) {
    return "skipped";
  }

  const current = await fs.readFile(envExamplePath, "utf8");
  if (current.includes("AMPLIO_JSON_SINK_PATH")) {
    return "skipped";
  }

  if (!dryRun) {
    const block =
      "\n# Path for the amplio JSON file sink (defaults to amplio.<env>.jsonl, e.g. amplio.development.jsonl)\n# AMPLIO_JSON_SINK_PATH=amplio.dev.jsonl\n";
    const next = current.endsWith("\n") ? `${current}${block.slice(1)}` : `${current}${block}`;
    await fs.writeFile(envExamplePath, next, "utf8");
  }
  return "updated";
}

const INTEGRATION_IDS = new Set(["better-auth", "clerk", "next-auth", "resend", "polar"]);

/** Integrations whose files declare their third-party message shapes locally —
 * tsc stays green without the target package installed. */
const INTEGRATION_SELF_CONTAINED_TYPES = new Set(["next-auth", "resend", "polar"]);

/**
 * Manual wiring steps per integration — installing the files is only half the
 * job, and stopping silently after "5 files created" leaves the other half in
 * the docs where nobody is looking. importBase is `~telemetry` when the
 * tsconfig alias exists, else the telemetry dir.
 */
const INTEGRATION_WIRING: Record<string, (importBase: string) => string[]> = {
  "next-auth": (importBase) => [
    "Wire it up (2 manual steps):",
    "  1. Wrap the [...nextauth] route with withAmplio so auth events share the request spine",
    "     (stock create-t3-app: `amplio init --wire` does this):",
    "       const { GET: authGet, POST: authPost } = handlers;",
    "       export const GET = withAmplio(authGet);",
    "       export const POST = withAmplio(authPost);",
    "  2. Add the events to your NextAuth config (T3: src/server/auth/config.ts):",
    `       import { amplioNextAuthEvents } from "${importBase}/integrations/next-auth";`,
    "       export const authConfig = { /* … */, events: amplioNextAuthEvents() };",
    `  Guide: node_modules/@useamplio/amplio/docs/t3.md §6 (also ${T3_MD_URL})`,
  ],
  "better-auth": (importBase) => [
    "Wire it up: add the plugin to your betterAuth() config:",
    `  import { createBetterAuthAmplioPlugin } from "${importBase}/integrations/better-auth";`,
    "  export const auth = betterAuth({ /* … */, plugins: [createBetterAuthAmplioPlugin()] });",
  ],
  clerk: (importBase) => [
    "Wire it up: call handleClerkWebhook(event) from your Clerk webhook route after verifying the signature:",
    `  import { handleClerkWebhook } from "${importBase}/integrations/clerk";`,
    "  // e.g. src/app/api/webhooks/clerk/route.ts, after verifyWebhook(...)",
    "  handleClerkWebhook(event);",
  ],
  resend: (importBase) => [
    "Wire it up: call handleResendWebhook(event) from your Resend webhook route,",
    "or trackResendEmail(...) right after resend.emails.send():",
    `  import { handleResendWebhook, trackResendEmail } from "${importBase}/integrations/resend";`,
  ],
  polar: (importBase) => [
    "Wire it up: call handlePolarWebhook(event) from your Polar webhook handler:",
    `  import { handlePolarWebhook } from "${importBase}/integrations/polar";`,
  ],
};

export interface AddOptions {
  cwd: string;
  force?: boolean;
  /** Preview mode: print what would be created/updated/wired, write nothing. */
  dryRun?: boolean;
}

function itemId(kind: string, id: string): string {
  return `${kind}-${id}`;
}

function fileStatusLine(
  rel: string,
  status: "created" | "updated" | "skipped",
  dryRun: boolean,
): string {
  if (status === "created") {
    return dryRun ? `✓ ${rel} (would create)` : `✓ ${rel}`;
  }
  if (status === "updated") {
    return dryRun ? `↻ ${rel} (would overwrite)` : `↻ ${rel}`;
  }
  return `· ${rel} (exists — --force to overwrite)`;
}

function printDryRunFooter(): void {
  console.log("  (dry run — nothing was written)");
}

async function getTelemetryDir(cwd: string): Promise<string> {
  const config = await readAmplioConfig(cwd);
  return config?.telemetryDir ?? "telemetry";
}

async function formatTelemetry(cwd: string): Promise<void> {
  const telemetryDir = await getTelemetryDir(cwd);
  const formatted = await formatGeneratedFiles(cwd, [telemetryDir]);
  if (formatted) {
    console.log(`  ✓ formatted with ${formatted}`);
  }
}

async function installByName(
  cwd: string,
  registryItemName: string,
  options: AddOptions,
): Promise<void> {
  const registryPath = await resolveRegistryPath(cwd);
  await assertRegistryExists(registryPath);

  const manifest = await loadRegistry(registryPath);
  const item = findRegistryItem(manifest, registryItemName);
  if (!item) {
    throw new Error(`Registry item "${registryItemName}" not found.`);
  }

  const items = await resolveRegistryDependencies(registryPath, manifest, item);
  const telemetryDir = await getTelemetryDir(cwd);
  const paths = resolveProjectPaths(cwd, telemetryDir);
  const dryRun = options.dryRun ?? false;

  if (!dryRun) {
    for (const entry of items) {
      if (entry.files.some((file) => file.target?.includes("/middleware/"))) {
        await ensureDir(paths.middleware);
      }
      if (entry.files.some((file) => file.target?.includes("/sinks/"))) {
        await ensureDir(paths.sinks);
      }
      if (entry.files.some((file) => file.target?.includes("/enrichers/"))) {
        await ensureDir(paths.enrichers);
      }
      if (entry.files.some((file) => file.target?.includes("/integrations/"))) {
        await ensureDir(paths.integrations);
      }
      if (entry.files.some((file) => file.target?.includes("/events/"))) {
        await ensureDir(paths.events);
      }
    }
  }

  const mergedDeps = new Set<string>();
  const mergedDevDeps = new Set<string>();
  const installedEventFiles: string[] = [];

  for (const entry of items) {
    const result = await installRegistryItem(entry, {
      cwd,
      registryPath,
      telemetryDir,
      force: options.force,
      dryRun,
    });

    for (const file of [...result.created, ...result.updated, ...result.skipped]) {
      const rel = path.relative(cwd, file);
      const status = result.created.includes(file)
        ? "created"
        : result.updated.includes(file)
          ? "updated"
          : "skipped";
      console.log(`  ${fileStatusLine(rel, status, dryRun)}`);
      if (rel.replace(/\\/g, "/").includes("/events/")) {
        installedEventFiles.push(file);
      }
    }

    for (const dep of entry.dependencies ?? []) {
      mergedDeps.add(dep);
    }
    for (const dep of entry.devDependencies ?? []) {
      mergedDevDeps.add(dep);
    }
  }

  // Registry-dependency events (e.g. an integration pulling in its event)
  // must be wired into the barrels like a direct `add event`, or the install
  // is only half done and tsc/doctor complain immediately after. One printed
  // set for the whole install — an integration pulling in two events touches
  // the same barrels twice, but the report should say so once.
  const printedBarrels = new Set<string>();
  if (dryRun) {
    for (const file of installedEventFiles) {
      const domainBarrel = path.join(path.dirname(file), "index.ts");
      const rootBarrel = path.join(cwd, telemetryDir, "events", "index.ts");
      for (const barrel of [domainBarrel, rootBarrel]) {
        const rel = path.relative(cwd, barrel);
        if (!printedBarrels.has(rel)) {
          printedBarrels.add(rel);
          console.log(`  ~ ${rel} (would wire barrel export)`);
        }
      }
    }
  } else {
    for (const file of installedEventFiles) {
      await wireInstalledEventBarrels(cwd, telemetryDir, file, printedBarrels);
    }
  }

  await mergePackageDependencies(cwd, [...mergedDeps], [...mergedDevDeps], dryRun);
}

const DEFINE_EVENT_EXPORT_RE =
  /export\s+const\s+([A-Za-z0-9_$]+)\s*=\s*defineEvent\s*\(\s*["']([^"']+)["']/;

async function wireInstalledEventBarrels(
  cwd: string,
  telemetryDir: string,
  eventFile: string,
  printed?: Set<string>,
): Promise<void> {
  try {
    const source = await fs.readFile(eventFile, "utf8");
    const match = DEFINE_EVENT_EXPORT_RE.exec(source);
    if (!match) {
      return;
    }
    const [, exportName, eventName] = match;
    const relativePath = path
      .relative(path.join(cwd, telemetryDir), eventFile)
      .replace(/\\/g, "/");
    if (relativePath !== eventNameToRelativePath(eventName!)) {
      return;
    }
    await updateEventBarrels(cwd, telemetryDir, relativePath, exportName!, printed);
  } catch {
    // best effort — doctor --fix covers anything missed here
  }
}

export async function updateEventBarrels(
  cwd: string,
  telemetryDir: string,
  eventRelativePath: string,
  exportName: string,
  /** Barrel paths already reported this run — suppresses duplicate ✓ lines. */
  printed?: Set<string>,
): Promise<void> {
  const telemetryRoot = path.join(cwd, telemetryDir);
  const eventFile = path.join(telemetryRoot, eventRelativePath);
  const domainDir = path.dirname(eventRelativePath);
  const importPath = `./${path.basename(eventRelativePath, ".ts")}`;

  const domainBarrel = path.join(telemetryRoot, domainDir, "index.ts");
  const rootBarrel = path.join(telemetryRoot, "events", "index.ts");

  await upsertBarrelExport(
    domainBarrel,
    `export { ${exportName} } from "${importPath}";`,
  );

  // Same extensionless, index-implicit style as the domain barrel ("./sent",
  // "./post") so generator and doctor --fix produce identical diffs.
  const domainExportPath = `./${domainDir.split("/").slice(1).join("/")}`;
  await upsertBarrelExport(
    rootBarrel,
    `export { ${exportName} } from "${domainExportPath}";`,
  );

  for (const barrel of [domainBarrel, rootBarrel]) {
    const rel = path.relative(cwd, barrel);
    if (printed) {
      if (printed.has(rel)) {
        continue;
      }
      printed.add(rel);
    }
    console.log(`  ✓ ${rel}`);
  }
}

const DEFINE_EVENT_NAME_RE = /defineEvent\s*\(\s*["']([^"']+)["']/;

/**
 * `list` shows hyphenated registry ids alongside events; accept those as
 * `add event` input by mapping the id back to the dot name in the item's
 * defineEvent call (hyphen→dot is ambiguous with underscores, so read it
 * from the template instead of guessing).
 */
async function resolveEventNameArg(name: string, cwd: string): Promise<string> {
  try {
    assertValidEventName(name);
    return name;
  } catch (error) {
    if (!name.includes("-") || !/^[a-z][a-z0-9-]*$/.test(name)) {
      throw error;
    }
    try {
      const registryPath = await resolveRegistryPath(cwd);
      const manifest = await loadRegistry(registryPath);
      const item = findRegistryItem(
        manifest,
        name.startsWith("event-") ? name : `event-${name}`,
      );
      for (const file of item?.files ?? []) {
        const match = file.content ? DEFINE_EVENT_NAME_RE.exec(file.content) : null;
        if (match) {
          return match[1]!;
        }
      }
    } catch {
      // fall through to the original validation error
    }
    throw error;
  }
}

export async function runAddEvent(rawEventName: string, options: AddOptions): Promise<void> {
  const eventName = await resolveEventNameArg(rawEventName, options.cwd);
  const telemetryDir = await getTelemetryDir(options.cwd);
  const paths = resolveProjectPaths(options.cwd, telemetryDir);
  const exportName = eventNameToExport(eventName);
  const relativePath = eventNameToRelativePath(eventName);
  const targetPath = path.join(paths.telemetry, relativePath);

  const dryRun = options.dryRun ?? false;
  if (!dryRun) {
    await ensureDir(path.dirname(targetPath));
  }
  console.log(`amplio add event ${eventName}`);
  if (eventName !== rawEventName) {
    console.log(`  (registry id ${rawEventName} → event ${eventName})`);
  }

  try {
    const registryPath = await resolveRegistryPath(options.cwd);
    const manifest = await loadRegistry(registryPath);
    const registryId = eventNameToRegistryId(eventName);
    const item = findRegistryItem(manifest, registryId);
    if (item) {
      console.log(`  matched registry event ${registryId}`);
      const eventExists = await pathExists(targetPath);
      // installByName wires barrels for every installed event file.
      await installByName(options.cwd, registryId, options);
      if (eventExists && !(options.force ?? false)) {
        console.log("  · skipped existing event file");
      }
      if (dryRun) {
        printDryRunFooter();
        return;
      }
      await formatTelemetry(options.cwd);
      return;
    }
  } catch {
    // fall through to template generation
  }

  const content =
    eventName === "auth.user.signed_up"
      ? renderAuthUserSignedUpEvent()
      : renderEventTemplate(eventName, exportName);

  console.log(`  generated starter schema (no registry template for ${eventName})`);

  if (dryRun) {
    const exists = await pathExists(targetPath);
    const status = exists ? ((options.force ?? false) ? "updated" : "skipped") : "created";
    console.log(
      `  ${fileStatusLine(path.relative(options.cwd, targetPath), status, true)}`,
    );
    if (status !== "skipped") {
      const domainBarrel = path.join(path.dirname(targetPath), "index.ts");
      const rootBarrel = path.join(paths.events, "index.ts");
      for (const barrel of [domainBarrel, rootBarrel]) {
        console.log(`  ~ ${path.relative(options.cwd, barrel)} (would wire barrel export)`);
      }
    } else {
      console.log("  · skipped existing event file");
    }
    printDryRunFooter();
    return;
  }

  const status = await writeFileOrSkip(targetPath, content, options.force ?? false);
  console.log(
    `  ${fileStatusLine(path.relative(options.cwd, targetPath), status, false)}`,
  );

  if (status !== "skipped") {
    await updateEventBarrels(options.cwd, telemetryDir, relativePath, exportName);
    await formatTelemetry(options.cwd);
  } else {
    console.log("  · skipped existing event file");
  }
}

export async function runAddMiddleware(id: string, options: AddOptions): Promise<void> {
  if (!MIDDLEWARE_IDS.has(id)) {
    throw new Error(`Unknown middleware "${id}". Choose: ${[...MIDDLEWARE_IDS].join(", ")}`);
  }
  const telemetryDir = await getTelemetryDir(options.cwd);
  const paths = resolveProjectPaths(options.cwd, telemetryDir);
  const targetPath = path.join(paths.middleware, `${id}.ts`);
  const middlewareExists = await pathExists(targetPath);

  console.log(`amplio add middleware ${id}`);
  await installByName(options.cwd, itemId("middleware", id), options);

  if (middlewareExists && !(options.force ?? false)) {
    console.log("  · skipped existing middleware file");
  }
  if (options.dryRun) {
    printDryRunFooter();
    return;
  }
  await formatTelemetry(options.cwd);
}

export async function runAddSink(id: string, options: AddOptions): Promise<void> {
  if (!SINK_IDS.has(id)) {
    throw new Error(`Unknown sink "${id}". Choose: ${[...SINK_IDS].join(", ")}`);
  }
  const telemetryDir = await getTelemetryDir(options.cwd);
  const paths = resolveProjectPaths(options.cwd, telemetryDir);
  const targetPath = path.join(paths.sinks, `${id}.ts`);
  const sinkExists = await pathExists(targetPath);

  console.log(`amplio add sink ${id}`);
  await installByName(options.cwd, itemId("sink", id), options);

  if (sinkExists && !(options.force ?? false)) {
    console.log("  · skipped existing sink file");
  }

  const dryRun = options.dryRun ?? false;
  const loggerUpdate = await updateLoggerWithSink(paths.logger, id, dryRun);
  if (loggerUpdate) {
    const rel = path.relative(options.cwd, paths.logger);
    console.log(`  ${dryRun ? `~ ${rel} (would auto-wire sink)` : `✓ ${rel} (auto-wired sink)`}`);
    for (const line of loggerUpdate.insertedLines) {
      console.log(`    ${line}`);
    }
  }

  if (id === "json") {
    const gitignoreResult = await appendGitignoreJsonSink(options.cwd, dryRun);
    if (gitignoreResult !== "skipped") {
      console.log(
        dryRun
          ? `  ~ .gitignore (would add amplio*.jsonl)`
          : `  ✓ .gitignore (${gitignoreResult})`,
      );
    }
    const envResult = await appendEnvExampleJsonSink(options.cwd, dryRun);
    if (envResult === "updated") {
      console.log(
        dryRun ? "  ~ .env.example (would document AMPLIO_JSON_SINK_PATH)" : "  ✓ .env.example",
      );
    }
  }
  if (dryRun) {
    printDryRunFooter();
    return;
  }
  await formatTelemetry(options.cwd);
}

export async function runAddEnricher(id: string, options: AddOptions): Promise<void> {
  const registryId = resolveEnricherId(id);
  if (!ENRICHER_REGISTRY_IDS.has(registryId)) {
    throw new Error(
      `Unknown enricher "${id}". Choose: ${[...ENRICHER_REGISTRY_IDS].join(", ")}`,
    );
  }
  const telemetryDir = await getTelemetryDir(options.cwd);
  const paths = resolveProjectPaths(options.cwd, telemetryDir);
  const targetPath = path.join(paths.enrichers, `${registryId}.ts`);
  const enricherExists = await pathExists(targetPath);

  console.log(`amplio add enricher ${id}`);
  await installByName(options.cwd, itemId("enricher", registryId), options);

  if (enricherExists && !(options.force ?? false)) {
    console.log("  · skipped existing enricher file");
  }

  if (registryId === "request-metadata") {
    console.log(
      "  request-metadata is a per-request enricher factory — use it inside middleware/wrappers, not init():",
    );
    console.log(
      "    const enrich = requestMetadata({ method: req.method, path: req.path });",
    );
    console.log("    requestLogger.set(enrich({}));");
    return;
  }

  const dryRun = options.dryRun ?? false;
  const loggerUpdated = await updateLoggerWithEnricher(paths.logger, registryId, dryRun);
  if (loggerUpdated) {
    const rel = path.relative(options.cwd, paths.logger);
    console.log(dryRun ? `  ~ ${rel} (would auto-wire enricher)` : `  ✓ ${rel}`);
  }
  if (registryId === "query-allowlist") {
    console.log(
      '  queryAllowlist() drops http.search entirely — pass { allow: ["page", "sort"] } in logger.ts to keep specific params (others become [REDACTED])',
    );
  }
  if (dryRun) {
    printDryRunFooter();
    return;
  }
  await formatTelemetry(options.cwd);
}

export async function runAddIntegration(id: string, options: AddOptions): Promise<void> {
  if (!INTEGRATION_IDS.has(id)) {
    throw new Error(
      `Unknown integration "${id}". Choose: ${[...INTEGRATION_IDS].join(", ")}`,
    );
  }
  const telemetryDir = await getTelemetryDir(options.cwd);
  const paths = resolveProjectPaths(options.cwd, telemetryDir);
  const targetPath = path.join(paths.integrations, `${id}.ts`);
  const integrationExists = await pathExists(targetPath);

  console.log(`amplio add integration ${id}`);
  await installByName(options.cwd, itemId("integration", id), options);

  if (integrationExists && !(options.force ?? false)) {
    console.log("  · skipped existing integration file");
  }
  if (options.dryRun) {
    printDryRunFooter();
    return;
  }
  await formatTelemetry(options.cwd);

  // The integration is open code against a third-party package — installing
  // it into a project that doesn't have that package deserves a heads-up.
  const rule = INTEGRATION_DEP_RULES.find((entry) => entry.integration === id);
  if (rule && !(await findDependency(options.cwd, rule.matches))) {
    if (INTEGRATION_SELF_CONTAINED_TYPES.has(id)) {
      console.log(
        `\n! ${rule.depLabel} is not in package.json — this integration targets it. The file uses local structural types (tsc stays green), but it emits nothing until ${rule.depLabel} is installed and wired.`,
      );
    } else {
      console.log(
        `\n! ${rule.depLabel} is not in package.json — the integration file imports from it, so typecheck/build will fail until it is installed.`,
      );
    }
  }

  const wiring = INTEGRATION_WIRING[id];
  if (wiring) {
    const importBase = (await hasTelemetryPathAlias(options.cwd, telemetryDir))
      ? "~telemetry"
      : telemetryDir;
    console.log("");
    for (const line of wiring(importBase)) {
      console.log(`  ${line}`);
    }
  }
}
