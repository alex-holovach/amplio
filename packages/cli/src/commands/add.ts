import fs from "node:fs/promises";
import path from "node:path";
import { valid } from "semver";
import {
  findRegistryItem,
  loadRegistry,
  readRegistryFileContent,
  resolveRegistryDependencies,
  assertRegistryExists,
} from "../registry/resolve.js";
import {
  installRegistryItems,
  mergePackageDependencies,
  type InstallResult,
} from "../registry/install.js";
import {
  assertPluginCompatibility,
  installContributorPlugin,
  planBoundaryPluginWiring,
} from "../registry/plugin-install.js";
import type { RegistryItem } from "../registry/types.js";
import {
  assertPluginCacheContained,
  contentHash,
  persistPluginState,
  planPluginState,
  type PluginInstallMetadata,
} from "../registry/plugin-state.js";
import { renderEventTemplate } from "../templates/event.js";
import {
  readAmplioConfig,
  resolveRegistryPath,
  resolveTelemetryDir,
} from "../utils/config.js";
import { detectPackageManager } from "../utils/detect-package-manager.js";
import {
  assertValidEventName,
  eventNameToExport,
  eventNameToRelativePath,
} from "../utils/event-name.js";
import { formatGeneratedFiles } from "../utils/format-files.js";
import { ensureDir, pathExists, writeFileOrSkip } from "../utils/fs.js";
import {
  normalizeGeneratedFileLocalImports,
  normalizeGeneratedLocalImports,
  usesExtensionlessGeneratedImports,
} from "../utils/generated-imports.js";
import {
  isEnricherWired,
  updateRuntimeWithEnricher,
} from "../utils/logger-enricher.js";
import { isSinkWired, updateRuntimeWithSink } from "../utils/logger-sink.js";
import { resolveProjectPaths } from "../utils/paths.js";
import { ensurePluginProviderDependency } from "../utils/provider-dependency.js";
import { isCanonicallyWithin } from "../utils/path-containment.js";

const SINK_IDS = new Set(["console", "json", "otlp"]);
const ENRICHER_IDS = new Set(["service-metadata"]);

export interface AddOptions {
  cwd: string;
  force?: boolean;
  dryRun?: boolean;
  event?: string;
  sourceOnly?: boolean;
  yes?: boolean;
  target?: string;
}

const PLUGIN_LOCKFILES = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
] as const;

interface PluginFileSnapshot {
  path: string;
  existed: boolean;
  content?: Buffer;
}

async function snapshotPluginFiles(
  cwd: string,
  filePaths: string[],
): Promise<PluginFileSnapshot[]> {
  const root = path.resolve(cwd);
  const snapshots: PluginFileSnapshot[] = [];
  for (const filePath of [
    ...new Set(filePaths.map((file) => path.resolve(file))),
  ]) {
    if (!(await isCanonicallyWithin(root, filePath))) {
      throw new Error(
        `Plugin transaction path ${path.relative(root, filePath)} resolves outside the project. No files were changed.`,
      );
    }
    const existed = await pathExists(filePath);
    snapshots.push({
      path: filePath,
      existed,
      ...(existed ? { content: await fs.readFile(filePath) } : {}),
    });
  }
  return snapshots;
}

async function restorePluginFiles(
  snapshots: PluginFileSnapshot[],
): Promise<void> {
  for (const snapshot of [...snapshots].reverse()) {
    if (snapshot.existed) {
      await ensureDir(path.dirname(snapshot.path));
      await fs.writeFile(snapshot.path, snapshot.content!);
    } else {
      await fs.rm(snapshot.path, { force: true });
    }
  }
}

async function trackedPlugin(
  configPath: string,
  slug: string,
): Promise<PluginInstallMetadata | undefined> {
  const config = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<
    string,
    unknown
  >;
  return (
    config.plugins as Record<string, PluginInstallMetadata> | undefined
  )?.[slug];
}

async function assertUntrackedPluginSourceAdoptable(options: {
  cwd: string;
  pluginPath: string;
  pluginSource: string;
  metadata?: PluginInstallMetadata;
  force?: boolean;
}): Promise<void> {
  if (options.metadata || !(await pathExists(options.pluginPath))) return;
  const existing = await fs.readFile(options.pluginPath, "utf8");
  if (existing === options.pluginSource || options.force) return;
  throw new Error(
    `${path.relative(options.cwd, options.pluginPath)} is an untracked Plugin source that differs from the registry recipe. Rerun with --force to overwrite it transactionally. No files were changed.`,
  );
}

function printInstallResult(
  cwd: string,
  result: InstallResult,
  dryRun: boolean,
): void {
  for (const file of result.created) {
    console.log(
      `  ✓ ${path.relative(cwd, file)}${dryRun ? " (would create)" : ""}`,
    );
  }
  for (const file of result.updated) {
    console.log(
      `  ↻ ${path.relative(cwd, file)}${dryRun ? " (would overwrite)" : ""}`,
    );
  }
  for (const file of result.skipped) {
    console.log(`  · ${path.relative(cwd, file)} (exists)`);
  }
}

async function installRecipe(
  item: RegistryItem,
  options: AddOptions,
  installOptions: { skipPackageDependencies?: boolean } = {},
): Promise<{ files: string[]; registryPath: string }> {
  const registryPath = await resolveRegistryPath(options.cwd);
  await assertRegistryExists(registryPath);
  const manifest = await loadRegistry(registryPath);
  const ordered = await resolveRegistryDependencies(
    registryPath,
    manifest,
    item,
  );
  const dir = await resolveTelemetryDir(options.cwd);
  const files: string[] = [];
  const dependencies = new Set<string>();
  const devDependencies = new Set<string>();

  const result = await installRegistryItems(ordered, {
    cwd: options.cwd,
    registryPath,
    telemetryDir: dir,
    force: options.force,
    dryRun: options.dryRun,
  });
  printInstallResult(options.cwd, result, options.dryRun ?? false);
  files.push(...result.created, ...result.updated, ...result.skipped);

  for (const recipe of ordered) {
    for (const dependency of recipe.dependencies ?? []) {
      dependencies.add(dependency);
    }
    for (const dependency of recipe.devDependencies ?? []) {
      devDependencies.add(dependency);
    }
  }

  if (!installOptions.skipPackageDependencies) {
    await mergePackageDependencies(
      options.cwd,
      [...dependencies],
      [...devDependencies],
      options.dryRun,
    );
  }
  return { files, registryPath };
}

async function preflightRecipeInstall(
  item: RegistryItem,
  options: AddOptions,
): Promise<string[]> {
  const registryPath = await resolveRegistryPath(options.cwd);
  await assertRegistryExists(registryPath);
  const manifest = await loadRegistry(registryPath);
  const ordered = await resolveRegistryDependencies(
    registryPath,
    manifest,
    item,
  );
  const result = await installRegistryItems(ordered, {
    cwd: options.cwd,
    registryPath,
    telemetryDir: await resolveTelemetryDir(options.cwd),
    force: options.force,
    dryRun: true,
  });
  return [...result.created, ...result.updated, ...result.skipped];
}

async function recipeDependencyClosure(
  item: RegistryItem,
  cwd: string,
): Promise<{ dependencies: string[]; devDependencies: string[] }> {
  const registryPath = await resolveRegistryPath(cwd);
  await assertRegistryExists(registryPath);
  const manifest = await loadRegistry(registryPath);
  const ordered = await resolveRegistryDependencies(
    registryPath,
    manifest,
    item,
  );
  return {
    dependencies: [
      ...new Set(ordered.flatMap((recipe) => recipe.dependencies ?? [])),
    ],
    devDependencies: [
      ...new Set(ordered.flatMap((recipe) => recipe.devDependencies ?? [])),
    ],
  };
}

async function installContributorRecipeSupport(
  item: RegistryItem,
  options: AddOptions,
  dryRun: boolean,
): Promise<string[]> {
  const registryPath = await resolveRegistryPath(options.cwd);
  await assertRegistryExists(registryPath);
  const manifest = await loadRegistry(registryPath);
  const ordered = await resolveRegistryDependencies(
    registryPath,
    manifest,
    item,
  );
  const supportItems = ordered.filter((recipe) => recipe.name !== item.name);
  const result = await installRegistryItems(supportItems, {
    cwd: options.cwd,
    registryPath,
    telemetryDir: await resolveTelemetryDir(options.cwd),
    force: options.force,
    dryRun,
  });
  printInstallResult(options.cwd, result, dryRun);

  return [...result.created, ...result.updated, ...result.skipped];
}

async function registryItem(
  cwd: string,
  name: string,
): Promise<{ item: RegistryItem; registryPath: string }> {
  const registryPath = await resolveRegistryPath(cwd);
  await assertRegistryExists(registryPath);
  const manifest = await loadRegistry(registryPath);
  const item = findRegistryItem(manifest, name);
  if (!item) throw new Error(`Registry item "${name}" not found.`);
  return { item, registryPath };
}

async function pluginPackageManager(cwd: string) {
  const config = await readAmplioConfig(cwd);
  return config?.packageManager ?? (await detectPackageManager(cwd));
}

async function formatFiles(cwd: string, files: string[]): Promise<void> {
  const targets = files.map((file) => path.relative(cwd, file));
  const formatter = await formatGeneratedFiles(cwd, [...new Set(targets)]);
  if (formatter) console.log(`  ✓ formatted with ${formatter}`);
}

async function trackBoundaryPlugin(options: {
  cwd: string;
  item: RegistryItem;
  sourcePath: string;
  recipePath: string;
  recipeSource: string;
  compositionRoot?: string;
  compositionBefore?: string;
  compositionInstalled?: string;
  wiringOwnership?: "managed" | "adopted";
  wiringAnchor?: string;
  sourceOnly?: boolean;
}): Promise<void> {
  const slug = options.item.name.replace(/^plugin-/, "");
  const wiring =
    options.compositionRoot &&
    options.compositionBefore !== undefined &&
    options.compositionInstalled !== undefined
      ? [
          {
            file: options.compositionRoot,
            kind: "boundary-registration" as const,
            anchor:
              options.wiringAnchor ??
              options.item.wiringActions?.find(
                (action) =>
                  action.type === "register-boundary" ||
                  action.type === "wrap-boundary",
              )?.export ??
              slug,
            before: options.compositionBefore,
            installed: options.compositionInstalled,
            ...(options.wiringOwnership
              ? { ownership: options.wiringOwnership }
              : {}),
          },
        ]
      : [];
  await persistPluginState({
    cwd: options.cwd,
    slug,
    plan: planPluginState({
      cwd: options.cwd,
      slug,
      item: options.item,
      role: "boundary",
      sourcePath: options.sourcePath,
      recipePath: options.recipePath,
      recipeSource: options.recipeSource,
      ...(options.item.events?.[0]?.id
        ? { event: options.item.events[0].id }
        : {}),
      ...(options.compositionRoot
        ? { compositionRoot: options.compositionRoot }
        : {}),
      ...(options.sourceOnly ? { sourceOnly: true } : {}),
      wiring,
    }),
  });
}

async function trackSourceOnlyContributor(options: {
  cwd: string;
  item: RegistryItem;
  eventId: string;
  sourcePath: string;
  recipePath: string;
  recipeSource: string;
}): Promise<void> {
  const slug = options.item.name.replace(/^plugin-/, "");
  await persistPluginState({
    cwd: options.cwd,
    slug,
    plan: planPluginState({
      cwd: options.cwd,
      slug,
      item: options.item,
      role: "contributor",
      sourcePath: options.sourcePath,
      recipePath: options.recipePath,
      recipeSource: options.recipeSource,
      event: options.eventId,
      ...(options.item.placement?.branch
        ? { branch: options.item.placement.branch }
        : {}),
      sourceOnly: true,
    }),
  });
}

export async function runAddEvent(
  id: string,
  options: AddOptions,
): Promise<void> {
  assertValidEventName(id);
  const dir = await resolveTelemetryDir(options.cwd);
  const relative = eventNameToRelativePath(id);
  const eventPath = path.join(options.cwd, dir, relative);
  const source = renderEventTemplate(id, eventNameToExport(id));
  const exists = await pathExists(eventPath);
  const status = exists ? (options.force ? "updated" : "skipped") : "created";

  console.log(`amplio add event ${id}`);
  if (!options.dryRun) {
    await writeFileOrSkip(eventPath, source, options.force ?? false);
  }
  const marker = status === "created" ? "✓" : status === "updated" ? "↻" : "·";
  console.log(
    `  ${marker} ${path.relative(options.cwd, eventPath)}${options.dryRun && status !== "skipped" ? ` (would ${status === "created" ? "create" : "overwrite"})` : ""}`,
  );
  await mergePackageDependencies(
    options.cwd,
    ["@useamplio/amplio", "zod"],
    [],
    options.dryRun,
  );
  if (!options.dryRun && status !== "skipped") {
    await formatFiles(options.cwd, [eventPath]);
  }
}

async function appendJsonSinkSupport(
  cwd: string,
  dryRun: boolean,
): Promise<void> {
  const gitignorePath = path.join(cwd, ".gitignore");
  const entry = "amplio*.jsonl";
  if (await pathExists(gitignorePath)) {
    const source = await fs.readFile(gitignorePath, "utf8");
    if (!source.split("\n").some((line) => line.trim() === entry)) {
      if (!dryRun) {
        await fs.writeFile(
          gitignorePath,
          `${source}${source.endsWith("\n") ? "" : "\n"}${entry}\n`,
          "utf8",
        );
      }
      console.log(`  ✓ .gitignore${dryRun ? " (would update)" : ""}`);
    }
  } else {
    if (!dryRun) await fs.writeFile(gitignorePath, `${entry}\n`, "utf8");
    console.log(`  ✓ .gitignore${dryRun ? " (would create)" : ""}`);
  }
}

export async function runAddSink(
  id: string,
  options: AddOptions,
): Promise<void> {
  if (!SINK_IDS.has(id)) {
    throw new Error(
      `Unknown sink "${id}". Choose: ${[...SINK_IDS].join(", ")}`,
    );
  }
  const { item } = await registryItem(options.cwd, `sink-${id}`);
  const dir = await resolveTelemetryDir(options.cwd);
  const runtime = resolveProjectPaths(options.cwd, dir).runtime;
  const alreadyWired = await isSinkWired(runtime, id);
  const plannedUpdate = alreadyWired
    ? null
    : await updateRuntimeWithSink(runtime, id, true);
  if (!alreadyWired && !plannedUpdate) {
    throw new Error(
      `${path.relative(options.cwd, runtime)} cannot be safely wired with sink "${id}"; no files were changed`,
    );
  }
  console.log(`amplio add sink ${id}`);
  const installed = await installRecipe(item, options);
  const update = alreadyWired
    ? null
    : await updateRuntimeWithSink(runtime, id, options.dryRun);
  if (update) {
    console.log(
      `  ✓ ${path.relative(options.cwd, runtime)}${options.dryRun ? " (would wire)" : " (wired)"}`,
    );
  } else if (!(await pathExists(runtime))) {
    console.log("  ! sink installed but runtime.ts is absent; run amplio init");
  }
  if (id === "json")
    await appendJsonSinkSupport(options.cwd, options.dryRun ?? false);
  if (!options.dryRun && (await pathExists(runtime))) {
    await normalizeGeneratedFileLocalImports(options.cwd, runtime);
  }
  if (!options.dryRun) await formatFiles(options.cwd, installed.files);
}

export async function runAddEnricher(
  id: string,
  options: AddOptions,
): Promise<void> {
  if (!ENRICHER_IDS.has(id)) {
    throw new Error(
      `Unknown enricher "${id}". Choose: ${[...ENRICHER_IDS].join(", ")}`,
    );
  }
  const { item } = await registryItem(options.cwd, `enricher-${id}`);
  const dir = await resolveTelemetryDir(options.cwd);
  const runtime = resolveProjectPaths(options.cwd, dir).runtime;
  const alreadyWired = await isEnricherWired(runtime, id);
  const plannedUpdate = alreadyWired
    ? false
    : await updateRuntimeWithEnricher(runtime, id, true);
  if (!alreadyWired && !plannedUpdate) {
    throw new Error(
      `${path.relative(options.cwd, runtime)} cannot be safely wired with enricher "${id}"; no files were changed`,
    );
  }
  console.log(`amplio add enricher ${id}`);
  const installed = await installRecipe(item, options);
  const wired = alreadyWired
    ? false
    : await updateRuntimeWithEnricher(runtime, id, options.dryRun);
  if (wired) {
    console.log(
      `  ✓ ${path.relative(options.cwd, runtime)}${options.dryRun ? " (would wire)" : " (wired)"}`,
    );
  } else if (!(await pathExists(runtime))) {
    console.log(
      "  ! enricher installed but runtime.ts is absent; run amplio init",
    );
  }
  if (!options.dryRun && (await pathExists(runtime))) {
    await normalizeGeneratedFileLocalImports(options.cwd, runtime);
  }
  if (!options.dryRun) await formatFiles(options.cwd, installed.files);
}

export async function runAddPlugin(
  id: string,
  options: AddOptions,
): Promise<void> {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id)) {
    throw new Error(`Invalid Plugin slug "${id}".`);
  }
  if (options.target && options.sourceOnly) {
    throw new Error(
      "--target selects an active Plugin seam and cannot be used with --source-only. No files were changed.",
    );
  }
  const { item, registryPath } = await registryItem(
    options.cwd,
    `plugin-${id}`,
  );
  if (!item.recipeVersion || valid(item.recipeVersion) === null) {
    throw new Error(
      `Plugin "${id}" has missing or invalid SemVer recipeVersion metadata. No files were changed.`,
    );
  }
  await assertPluginCacheContained(options.cwd);

  if (item.role === "boundary") {
    if (options.event?.trim()) {
      throw new Error(`Boundary Plugin "${id}" selects its own root Event.`);
    }
    const configPath = path.join(options.cwd, "amplio.json");
    if (!(await pathExists(configPath))) {
      throw new Error(
        "amplio.json is missing; run amplio init before adding a Plugin. No files were changed.",
      );
    }
    const dir = await resolveTelemetryDir(options.cwd);
    const slug = item.name.replace(/^plugin-/, "");
    const existingMetadata = await trackedPlugin(configPath, slug);
    if (
      options.sourceOnly &&
      existingMetadata &&
      existingMetadata.sourceOnly !== true
    ) {
      throw new Error(
        `Plugin "${slug}" is already active and cannot downgrade to --source-only. Remove it first. No files were changed.`,
      );
    }
    const pluginPath = path.join(options.cwd, dir, "plugins", `${slug}.ts`);
    const sourceFile = item.files.find(
      (file) =>
        file.target?.replace(/\\/g, "/").endsWith(`/plugins/${slug}.ts`) ||
        file.target?.replace(/\\/g, "/") === `plugins/${slug}.ts`,
    );
    if (!sourceFile) {
      throw new Error(`Plugin "${id}" has no editable source file.`);
    }
    const pluginSource = normalizeGeneratedLocalImports(
      await readRegistryFileContent(
        registryPath,
        sourceFile.path,
        sourceFile.content,
      ),
      await usesExtensionlessGeneratedImports(options.cwd),
    );
    await assertUntrackedPluginSourceAdoptable({
      cwd: options.cwd,
      pluginPath,
      pluginSource,
      metadata: existingMetadata,
      force: options.force,
    });
    if (options.sourceOnly) {
      await assertPluginCompatibility({
        cwd: options.cwd,
        item,
        allowMissing: true,
      });
    }
    const wiring = options.sourceOnly
      ? undefined
      : await planBoundaryPluginWiring({
          cwd: options.cwd,
          telemetryDir: dir,
          item,
          allowMissingDependencies: true,
          allowPluginOverwrite: options.force,
          ...(options.target ? { target: options.target } : {}),
        });
    const plannedCompositionRoot = wiring
      ? path.relative(options.cwd, wiring.compositionPath).replace(/\\/g, "/")
      : undefined;
    if (
      wiring &&
      existingMetadata &&
      existingMetadata.sourceOnly !== true &&
      existingMetadata.compositionRoot !== plannedCompositionRoot
    ) {
      throw new Error(
        `Plugin "${slug}" is already active at ${existingMetadata.compositionRoot}; refusing to retarget it to ${plannedCompositionRoot}. Remove and reinstall the Plugin explicitly. No files were changed.`,
      );
    }
    const compositionBefore = wiring
      ? await fs.readFile(wiring.compositionPath, "utf8")
      : undefined;
    const recipeDependencies = wiring
      ? await recipeDependencyClosure(item, options.cwd)
      : undefined;
    let previewFiles: string[] | undefined;
    if (wiring) {
      console.log(`amplio add plugin ${id}`);
      previewFiles = (
        await installRecipe(
          item,
          { ...options, dryRun: true },
          { skipPackageDependencies: true },
        )
      ).files;
      console.log(
        wiring.ownership === "adopted"
          ? `  ~ would adopt verified customer-owned boundary in ${path.relative(options.cwd, wiring.compositionPath)}`
          : `  ~ would activate boundary in ${path.relative(options.cwd, wiring.compositionPath)}`,
      );
      console.log("  ~ would track Plugin install in amplio.json");
      console.log(
        wiring.ownership === "adopted"
          ? "  ~ tracked rollback: package, lockfile, Plugin source, and install state; the customer composition seam is verified but not rewritten; node_modules, package-manager cache, and dependency lifecycle scripts are not reversible"
          : "  ~ tracked rollback: package, lockfile, Plugin source, composition seam, and install state; node_modules, package-manager cache, and dependency lifecycle scripts are not reversible",
      );
    }
    const transactionSnapshots = options.dryRun
      ? []
      : await snapshotPluginFiles(options.cwd, [
          ...(previewFiles ?? (await preflightRecipeInstall(item, options))),
          configPath,
          path.join(options.cwd, "package.json"),
          ...PLUGIN_LOCKFILES.map((lockfile) =>
            path.join(options.cwd, lockfile),
          ),
          ...(wiring ? [wiring.compositionPath] : []),
          path.join(
            options.cwd,
            ".amplio",
            "bases",
            `${contentHash(pluginSource)}.json`,
          ),
          path.join(options.cwd, ".amplio", "installs", `${slug}.json`),
        ]);
    let providerChange:
      Awaited<ReturnType<typeof ensurePluginProviderDependency>> | undefined;
    if (wiring) {
      providerChange = await ensurePluginProviderDependency({
        cwd: options.cwd,
        item,
        packageManager: await pluginPackageManager(options.cwd),
        yes: options.yes,
        dryRun: options.dryRun,
        recipeDependencies,
      });
    }
    if (options.dryRun && wiring) return;
    try {
      if (!wiring) console.log(`amplio add plugin ${id} --source-only`);
      await installRecipe(item, options, {
        skipPackageDependencies: wiring !== undefined,
      });
      if (options.dryRun) {
        console.log("  ~ would copy inert source without boundary activation");
        console.log("  ~ would track Plugin install in amplio.json");
        return;
      }
      if (wiring) {
        if (wiring.ownership !== "adopted") {
          await fs.writeFile(
            wiring.compositionPath,
            wiring.compositionSource,
            "utf8",
          );
        }
        await trackBoundaryPlugin({
          cwd: options.cwd,
          item,
          sourcePath: pluginPath,
          recipePath: sourceFile.path,
          recipeSource: pluginSource,
          compositionRoot: plannedCompositionRoot!,
          compositionBefore,
          compositionInstalled: wiring.compositionSource,
          ...(wiring.ownership ? { wiringOwnership: wiring.ownership } : {}),
          ...(wiring.anchor ? { wiringAnchor: wiring.anchor } : {}),
        });
        console.log(
          wiring.ownership === "adopted"
            ? `  ✓ ${path.relative(options.cwd, wiring.compositionPath)} (verified customer-owned boundary adopted; source retained)`
            : `  ✓ ${path.relative(options.cwd, wiring.compositionPath)} (boundary activated)`,
        );
      } else {
        await trackBoundaryPlugin({
          cwd: options.cwd,
          item,
          sourcePath: pluginPath,
          recipePath: sourceFile.path,
          recipeSource: pluginSource,
          sourceOnly: true,
        });
        console.log(
          "  ! source copied without activation; doctor --strict will fail until wired",
        );
      }
      return;
    } catch (error) {
      try {
        await restorePluginFiles(transactionSnapshots);
      } finally {
        await providerChange?.rollback();
      }
      throw error;
    }
  }

  const eventId = options.event?.trim();
  if (!eventId) throw new Error(`Plugin "${id}" requires --event <event-id>.`);
  const sourceFile = item.files.find((file) => {
    const target = file.target?.replace(/\\/g, "/");
    return (
      target === `plugins/${id}.ts` ||
      target?.endsWith(`/plugins/${id}.ts`) === true
    );
  });
  if (!sourceFile)
    throw new Error(`Plugin "${id}" has no editable source file.`);
  const pluginSource = normalizeGeneratedLocalImports(
    await readRegistryFileContent(
      registryPath,
      sourceFile.path,
      sourceFile.content,
    ),
    await usesExtensionlessGeneratedImports(options.cwd),
  );
  const dir = await resolveTelemetryDir(options.cwd);
  const configPath = path.join(options.cwd, "amplio.json");
  if (!(await pathExists(configPath))) {
    throw new Error(
      "amplio.json is missing; run amplio init before adding a Plugin. No files were changed.",
    );
  }
  const existingMetadata = await trackedPlugin(configPath, id);
  const pluginPath = path.join(options.cwd, dir, "plugins", `${id}.ts`);
  await assertUntrackedPluginSourceAdoptable({
    cwd: options.cwd,
    pluginPath,
    pluginSource,
    metadata: existingMetadata,
    force: options.force,
  });

  if (options.sourceOnly) {
    await assertPluginCompatibility({
      cwd: options.cwd,
      item,
      allowMissing: true,
    });
    if (existingMetadata && existingMetadata.sourceOnly !== true) {
      throw new Error(
        `Plugin "${id}" is already active and cannot downgrade to --source-only. Remove it first. No files were changed.`,
      );
    }
    if (
      existingMetadata?.sourceOnly === true &&
      (existingMetadata.event !== eventId ||
        existingMetadata.branch !== item.placement?.branch)
    ) {
      throw new Error(
        `Plugin "${id}" is already tracked as source-only for Event "${existingMetadata.event}" under "${existingMetadata.branch}". Remove it before selecting a different root Event. No files were changed.`,
      );
    }
    const transactionSnapshots = options.dryRun
      ? []
      : await snapshotPluginFiles(options.cwd, [
          ...(await preflightRecipeInstall(item, options)),
          configPath,
          path.join(options.cwd, "package.json"),
          ...PLUGIN_LOCKFILES.map((lockfile) =>
            path.join(options.cwd, lockfile),
          ),
          path.join(
            options.cwd,
            ".amplio",
            "bases",
            `${contentHash(pluginSource)}.json`,
          ),
          path.join(options.cwd, ".amplio", "installs", `${id}.json`),
        ]);
    try {
      console.log(`amplio add plugin ${id} --event ${eventId} --source-only`);
      await installRecipe(item, options);
      if (!options.dryRun) {
        await trackSourceOnlyContributor({
          cwd: options.cwd,
          item,
          eventId,
          sourcePath: pluginPath,
          recipePath: sourceFile.path,
          recipeSource: pluginSource,
        });
      } else {
        console.log("  ~ would track inert Plugin source in amplio.json");
      }
    } catch (error) {
      await restorePluginFiles(transactionSnapshots);
      throw error;
    }
    console.log(
      "  ! source copied without composition or provider wiring; doctor --strict will fail until wired",
    );
    return;
  }

  const planned = await installContributorPlugin({
    cwd: options.cwd,
    telemetryDir: dir,
    item,
    eventId,
    pluginSource,
    recipePath: sourceFile.path,
    dryRun: true,
    allowMissingDependencies: true,
    forceUntrackedSource: options.force,
    ...(options.target ? { target: options.target } : {}),
  });
  console.log(`amplio add plugin ${id} --event ${eventId}`);
  const recipeDependencies = await recipeDependencyClosure(item, options.cwd);
  const supportPaths = await installContributorRecipeSupport(
    item,
    options,
    true,
  );
  console.log(
    `  ~ would create or retain ${path.relative(options.cwd, planned.pluginPath)}`,
  );
  console.log(
    `  ~ would mount under ${item.placement?.branch} in ${path.relative(options.cwd, planned.eventPath)}`,
  );
  console.log(
    `  ~ would wire ${path.relative(options.cwd, planned.compositionPath)}`,
  );
  console.log("  ~ would track Plugin install in amplio.json");
  console.log(
    "  ~ tracked rollback: package, lockfile, Plugin source, root Event, provider seam, and install state; node_modules, package-manager cache, and dependency lifecycle scripts are not reversible",
  );
  const transactionSnapshots = options.dryRun
    ? []
    : await snapshotPluginFiles(options.cwd, [
        ...supportPaths,
        planned.pluginPath,
        planned.eventPath,
        planned.compositionPath,
        configPath,
        path.join(options.cwd, "package.json"),
        ...PLUGIN_LOCKFILES.map((lockfile) => path.join(options.cwd, lockfile)),
        path.join(
          options.cwd,
          ".amplio",
          "bases",
          `${contentHash(pluginSource)}.json`,
        ),
        path.join(options.cwd, ".amplio", "installs", `${id}.json`),
      ]);
  const providerChange = await ensurePluginProviderDependency({
    cwd: options.cwd,
    item,
    packageManager: await pluginPackageManager(options.cwd),
    yes: options.yes,
    dryRun: options.dryRun,
    recipeDependencies,
  });
  if (options.dryRun) return;
  try {
    await installContributorRecipeSupport(item, options, false);
    const result = await installContributorPlugin({
      cwd: options.cwd,
      telemetryDir: dir,
      item,
      eventId,
      pluginSource,
      recipePath: sourceFile.path,
      forceUntrackedSource: options.force,
      ...(options.target ? { target: options.target } : {}),
    });
    const marker = result.changed ? "✓" : "·";
    console.log(`  ${marker} ${path.relative(options.cwd, result.pluginPath)}`);
    console.log(
      `  ${marker} ${path.relative(options.cwd, result.eventPath)} (mounted under ${item.placement?.branch})`,
    );
    console.log(
      `  ${marker} ${path.relative(options.cwd, result.compositionPath)} (selected composition root)`,
    );
  } catch (error) {
    try {
      await restorePluginFiles(transactionSnapshots);
    } finally {
      await providerChange.rollback();
    }
    throw error;
  }
}
