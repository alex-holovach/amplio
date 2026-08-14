import fs from "node:fs/promises";
import path from "node:path";
import {
  codeMask,
  eventDefinitionIds,
  hasAdoptedBoundaryActivation,
  hasActiveContributorProviderWiring,
  hasEventTreePluginMount,
  hasHttpRequestBoundaryContract,
  hasLiveNamedImport,
  importedProviderBindings,
} from "../registry/plugin-install.js";
import type { RegistryPluginProvider } from "../registry/types.js";
import { readAmplioConfig } from "../utils/config.js";
import { pathExists } from "../utils/fs.js";
import { resolveProjectPaths } from "../utils/paths.js";

export interface DoctorOptions {
  cwd: string;
  strict?: boolean;
  verbose?: boolean;
}

const RETIRED_DIRECTORIES = [
  "components",
  "workloads",
  "middleware",
  "integrations",
] as const;
const RETIRED_API =
  /\b(?:defineFact|defineOperation|defineComponent|defineWorkload|useLogger|getLogger)\b/;

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function hasLiveBoundaryRegistration(
  plugin: string,
  exportedNames: string[],
  compositionSource: string,
  compositionPath: string,
  pluginSourcePath: string,
): boolean {
  const mask = codeMask(compositionSource);
  const importedNames = exportedNames.filter((name) =>
    localImportSpecifiers(compositionPath, pluginSourcePath).some((specifier) =>
      hasLiveNamedImport(compositionSource, specifier, name),
    ),
  );
  if (plugin === "hono") {
    const bindings = importedProviderBindings(
      compositionSource,
      "hono",
      "Hono",
    );
    return bindings.some((binding) => {
      const assignment = new RegExp(
        `\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*new\\s+${escapeRegExp(binding)}(?:\\s*<[^;]+>)?\\s*\\(`,
        "g",
      );
      return [...mask.matchAll(assignment)].some((match) =>
        importedNames.some((name) =>
          new RegExp(
            `\\b${escapeRegExp(match[1]!)}\\.use\\s*\\(\\s*,\\s*${escapeRegExp(name)}\\s*\\(\\s*\\)\\s*\\)`,
          ).test(mask),
        ),
      );
    });
  }
  if (plugin === "fastify") {
    const bindings = importedProviderBindings(
      compositionSource,
      "fastify",
      "fastify",
      true,
    );
    return bindings.some((binding) => {
      const assignment = new RegExp(
        `\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${escapeRegExp(binding)}\\s*\\(`,
        "g",
      );
      return [...mask.matchAll(assignment)].some((match) =>
        importedNames.some((name) =>
          new RegExp(
            `\\b${escapeRegExp(match[1]!)}\\.register\\s*\\(\\s*${escapeRegExp(name)}\\s*\\)`,
          ).test(mask),
        ),
      );
    });
  }
  if (plugin === "next" || plugin === "express") {
    return exportedNames.some((exportName) =>
      hasAdoptedBoundaryActivation({
        plugin,
        source: compositionSource,
        compositionPath,
        pluginPath: pluginSourcePath,
        exportName,
      }),
    );
  }
  return false;
}

function localImportSpecifiers(fromFile: string, toFile: string): string[] {
  let relative = path
    .relative(path.dirname(fromFile), toFile)
    .replace(/\\/g, "/")
    .replace(/\.[cm]?[jt]sx?$/, "");
  if (!relative.startsWith(".")) relative = `./${relative}`;
  return [relative, `${relative}.js`];
}

function hasLiveAmplioInit(source: string): boolean {
  const mask = codeMask(source);
  return importedProviderBindings(source, "@useamplio/amplio", "init").some(
    (binding) => new RegExp(`\\b${escapeRegExp(binding)}\\s*\\(`).test(mask),
  );
}

async function sourceFiles(directory: string): Promise<string[]> {
  if (!(await pathExists(directory))) return [];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const output: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await sourceFiles(absolute)));
    else if (entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name))
      output.push(absolute);
  }
  return output.sort();
}

export async function runDoctor(options: DoctorOptions): Promise<number> {
  const config = await readAmplioConfig(options.cwd);
  const dir = config?.telemetryDir ?? "telemetry";
  const paths = resolveProjectPaths(options.cwd, dir);
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!config) errors.push("amplio.json is missing (run: amplio init)");
  if (!(await pathExists(paths.runtime))) {
    errors.push(`${dir}/runtime.ts is missing (run: amplio init)`);
  } else {
    const runtime = await fs.readFile(paths.runtime, "utf8");
    if (!hasLiveAmplioInit(runtime)) {
      errors.push(`${dir}/runtime.ts does not initialize @useamplio/amplio`);
    }
    if (RETIRED_API.test(runtime)) {
      errors.push(`${dir}/runtime.ts imports a retired alpha API`);
    }
  }

  const events = await sourceFiles(paths.events);
  if (events.length === 0) {
    errors.push(`${dir}/events has no Event definitions (run: amplio init)`);
  }
  const ids = new Map<string, string>();
  for (const file of events) {
    const source = await fs.readFile(file, "utf8");
    const eventIds = eventDefinitionIds(source);
    if (RETIRED_API.test(source) || eventIds.length === 0) {
      errors.push(
        `${path.relative(options.cwd, file)} is not a vNext Event definition`,
      );
    }
    if (eventIds.length === 0) {
      errors.push(
        `${path.relative(options.cwd, file)} has no literal Event id`,
      );
    }
    for (const id of eventIds) {
      if (ids.has(id)) {
        errors.push(
          `Event id "${id}" is duplicated in ${path.relative(options.cwd, file)} and ${path.relative(options.cwd, ids.get(id)!)} `,
        );
      } else {
        ids.set(id, file);
      }
    }
  }

  for (const file of await sourceFiles(paths.plugins)) {
    const source = await fs.readFile(file, "utf8");
    if (RETIRED_API.test(source)) {
      errors.push(
        `${path.relative(options.cwd, file)} imports a retired alpha API`,
      );
    }
  }
  for (const retired of RETIRED_DIRECTORIES) {
    if (await pathExists(path.join(paths.telemetry, retired))) {
      errors.push(`${dir}/${retired} is a retired alpha directory`);
    }
  }

  const tracked = (
    config as typeof config & {
      plugins?: Record<
        string,
        {
          event?: string;
          role?: "boundary" | "contributor";
          branch?: string;
          source?: string;
          compositionRoot?: string;
          sourceOnly?: boolean;
          provider?: RegistryPluginProvider;
        }
      >;
    }
  )?.plugins;
  let activeBoundaries = 0;
  for (const [plugin, metadata] of Object.entries(tracked ?? {})) {
    if (!metadata.event || !ids.has(metadata.event)) {
      errors.push(
        `Plugin "${plugin}" references missing Event "${metadata.event ?? ""}"`,
      );
    }
    const sourcePath = metadata.source
      ? path.join(options.cwd, metadata.source)
      : undefined;
    if (!sourcePath || !(await pathExists(sourcePath))) {
      errors.push(
        `Plugin "${plugin}" has missing source ${metadata.source ?? ""}`,
      );
    }
    if (metadata.sourceOnly) {
      warnings.push(
        `Plugin "${plugin}" is source-only and inactive; rerun add without --source-only after wiring its native seam`,
      );
      continue;
    }

    const compositionPath = metadata.compositionRoot
      ? path.join(options.cwd, metadata.compositionRoot)
      : undefined;
    if (!compositionPath || !(await pathExists(compositionPath))) {
      errors.push(
        `Plugin "${plugin}" has missing compositionRoot ${metadata.compositionRoot ?? ""}`,
      );
      continue;
    }
    if (metadata.role === "boundary" && sourcePath) {
      const eventPath = metadata.event ? ids.get(metadata.event) : undefined;
      if (
        metadata.event === "http.request" &&
        eventPath &&
        !hasHttpRequestBoundaryContract(await fs.readFile(eventPath, "utf8"))
      ) {
        errors.push(
          `Plugin "${plugin}" requires ${path.relative(options.cwd, eventPath)} to export HttpRequest and resolveRequestId`,
        );
      }
      const [pluginSource, compositionSource] = await Promise.all([
        fs.readFile(sourcePath, "utf8"),
        fs.readFile(compositionPath, "utf8"),
      ]);
      const exportedNames = [
        ...codeMask(pluginSource).matchAll(
          /\bexport\s+(?:async\s+)?(?:function|const)\s+([A-Za-z_$][\w$]*)/g,
        ),
      ].map((match) => match[1]!);
      const isRegistered = hasLiveBoundaryRegistration(
        plugin,
        exportedNames,
        compositionSource,
        compositionPath,
        sourcePath,
      );
      if (!isRegistered) {
        errors.push(
          `Plugin "${plugin}" is not registered in ${metadata.compositionRoot}`,
        );
      } else {
        activeBoundaries += 1;
      }
    } else if (
      (metadata.role === "contributor" || metadata.branch !== undefined) &&
      sourcePath &&
      metadata.event &&
      metadata.branch
    ) {
      const eventPath = ids.get(metadata.event);
      if (!eventPath) continue;
      const [pluginSource, eventSource, compositionSource] = await Promise.all([
        fs.readFile(sourcePath, "utf8"),
        fs.readFile(eventPath, "utf8"),
        fs.readFile(compositionPath, "utf8"),
      ]);
      const exportedNames = [
        ...codeMask(pluginSource).matchAll(
          /\bexport\s+(?:async\s+)?(?:function|const)\s+([A-Za-z_$][\w$]*)/g,
        ),
      ].map((match) => match[1]!);
      const mountedName = exportedNames.find(
        (name) =>
          localImportSpecifiers(eventPath, sourcePath).some((specifier) =>
            hasLiveNamedImport(eventSource, specifier, name),
          ) &&
          hasEventTreePluginMount({
            source: eventSource,
            eventId: metadata.event!,
            branch: metadata.branch!,
            pluginName: name,
          }),
      );
      if (!mountedName) {
        errors.push(
          `Plugin "${plugin}" is not mounted under "${metadata.branch}" in ${path.relative(options.cwd, eventPath)}`,
        );
        continue;
      }
      const provider = metadata.provider;
      if (
        !provider ||
        provider.instrumenter !== mountedName ||
        !hasActiveContributorProviderWiring({
          source: compositionSource,
          provider,
          pluginModuleSpecifiers: localImportSpecifiers(
            compositionPath,
            sourcePath,
          ),
        })
      ) {
        errors.push(
          `Plugin "${plugin}" is not active in ${metadata.compositionRoot}`,
        );
      }
    }
  }
  if (activeBoundaries === 0) {
    warnings.push("no active boundary Plugin is registered yet");
  }

  console.log("amplio doctor");
  for (const message of errors) console.log(`  ✗ ${message}`);
  for (const message of warnings) console.log(`  ! ${message}`);
  if (errors.length === 0 && (!options.strict || warnings.length === 0)) {
    console.log(
      `  ✓ ${events.length} Event definition(s), ${Object.keys(tracked ?? {}).length} tracked Plugin(s), ${activeBoundaries} active boundary Plugin(s)`,
    );
    return 0;
  }
  if (options.verbose) {
    console.log(
      "  Event + Plugin layout only; alpha component/workload paths are not supported.",
    );
  }
  return 1;
}
