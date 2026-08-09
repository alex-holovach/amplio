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

async function appendGitignoreJsonSink(cwd: string): Promise<"created" | "updated" | "skipped"> {
  const gitignorePath = path.join(cwd, ".gitignore");
  const entry = "amplio.jsonl";
  const block = "# amplio JSON sink output\namplio.jsonl\n";

  if (await pathExists(gitignorePath)) {
    const current = await fs.readFile(gitignorePath, "utf8");
    if (/(^|\n)\s*amplio\.jsonl(\s|$)/m.test(current)) {
      return "skipped";
    }
    const next = current.endsWith("\n") ? `${current}${block}` : `${current}\n${block}`;
    await fs.writeFile(gitignorePath, next, "utf8");
    return "updated";
  }

  await fs.writeFile(gitignorePath, block, "utf8");
  return "created";
}

async function appendEnvExampleJsonSink(cwd: string): Promise<"updated" | "skipped"> {
  const envExamplePath = path.join(cwd, ".env.example");
  if (!(await pathExists(envExamplePath))) {
    return "skipped";
  }

  const current = await fs.readFile(envExamplePath, "utf8");
  if (current.includes("AMPLIO_JSON_SINK_PATH")) {
    return "skipped";
  }

  const block =
    "\n# Path for the amplio JSON file sink (defaults to amplio.jsonl)\n# AMPLIO_JSON_SINK_PATH=amplio.jsonl\n";
  const next = current.endsWith("\n") ? `${current}${block.slice(1)}` : `${current}${block}`;
  await fs.writeFile(envExamplePath, next, "utf8");
  return "updated";
}

const INTEGRATION_IDS = new Set(["better-auth", "clerk", "resend", "polar"]);

export interface AddOptions {
  cwd: string;
  force?: boolean;
}

function itemId(kind: string, id: string): string {
  return `${kind}-${id}`;
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

  const mergedDeps = new Set<string>();
  const mergedDevDeps = new Set<string>();
  const installedEventFiles: string[] = [];

  for (const entry of items) {
    const result = await installRegistryItem(entry, {
      cwd,
      registryPath,
      telemetryDir,
      force: options.force,
    });

    for (const file of [...result.created, ...result.updated, ...result.skipped]) {
      const rel = path.relative(cwd, file);
      const marker = result.created.includes(file)
        ? "✓"
        : result.updated.includes(file)
          ? "↻"
          : "·";
      console.log(`  ${marker} ${rel}`);
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
  // is only half done and tsc/doctor complain immediately after.
  for (const file of installedEventFiles) {
    await wireInstalledEventBarrels(cwd, telemetryDir, file);
  }

  await mergePackageDependencies(cwd, [...mergedDeps], [...mergedDevDeps]);
}

const DEFINE_EVENT_EXPORT_RE =
  /export\s+const\s+([A-Za-z0-9_$]+)\s*=\s*defineEvent\s*\(\s*["']([^"']+)["']/;

async function wireInstalledEventBarrels(
  cwd: string,
  telemetryDir: string,
  eventFile: string,
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
    await updateEventBarrels(cwd, telemetryDir, relativePath, exportName!);
  } catch {
    // best effort — doctor --fix covers anything missed here
  }
}

export async function updateEventBarrels(
  cwd: string,
  telemetryDir: string,
  eventRelativePath: string,
  exportName: string,
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

  console.log(`  ✓ ${path.relative(cwd, domainBarrel)}`);
  console.log(`  ✓ ${path.relative(cwd, rootBarrel)}`);
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

  await ensureDir(path.dirname(targetPath));
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
  const status = await writeFileOrSkip(targetPath, content, options.force ?? false);
  console.log(`  ${status === "skipped" ? "·" : "✓"} ${path.relative(options.cwd, targetPath)}`);

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

  const loggerUpdate = await updateLoggerWithSink(paths.logger, id);
  if (loggerUpdate) {
    console.log(`  ✓ ${path.relative(options.cwd, paths.logger)} (auto-wired sink)`);
    for (const line of loggerUpdate.insertedLines) {
      console.log(`    ${line}`);
    }
  }

  if (id === "json") {
    const gitignoreResult = await appendGitignoreJsonSink(options.cwd);
    if (gitignoreResult !== "skipped") {
      console.log(`  ✓ .gitignore (${gitignoreResult})`);
    }
    const envResult = await appendEnvExampleJsonSink(options.cwd);
    if (envResult === "updated") {
      console.log("  ✓ .env.example");
    }
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

  const loggerUpdated = await updateLoggerWithEnricher(paths.logger, registryId);
  if (loggerUpdated) {
    console.log(`  ✓ ${path.relative(options.cwd, paths.logger)}`);
  }
  if (registryId === "query-allowlist") {
    console.log(
      '  queryAllowlist() drops http.search entirely — pass { allow: ["page", "sort"] } in logger.ts to keep specific params (others become [REDACTED])',
    );
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
  await formatTelemetry(options.cwd);
}
