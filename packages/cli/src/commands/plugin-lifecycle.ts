import fs from "node:fs/promises";
import path from "node:path";
import { compare, valid } from "semver";
import {
  contentHash,
  pluginContractDigest,
  pluginDependencyDigest,
  pluginPrivacyDigest,
  planPluginState,
  type PluginBaseArchive,
  type PluginInstallMetadata,
  type PluginStateArchive,
} from "../registry/plugin-state.js";
import {
  assertPluginCompatibility,
  codeMask,
} from "../registry/plugin-install.js";
import {
  assertRegistryExists,
  findRegistryItem,
  loadRegistry,
  readRegistryFileContent,
} from "../registry/resolve.js";
import type { RegistryFile, RegistryItem } from "../registry/types.js";
import { resolveRegistryPath } from "../utils/config.js";
import { ensureDir, pathExists } from "../utils/fs.js";
import {
  normalizeGeneratedLocalImports,
  usesExtensionlessGeneratedImports,
} from "../utils/generated-imports.js";
import {
  canonicalizePath,
  isCanonicallyWithin,
  isPathWithin,
  isPortableAbsolute,
} from "../utils/path-containment.js";
import { renderUnifiedDiff, threeWayMerge } from "../utils/three-way-merge.js";

export interface PluginLifecycleOptions {
  cwd: string;
}

interface LoadedInstall {
  configPath: string;
  config: Record<string, unknown>;
  metadata: PluginInstallMetadata;
}

interface CurrentRecipe {
  item: RegistryItem;
  registryPath: string;
  file: RegistryFile;
  source: string;
}

interface FileSnapshot {
  path: string;
  existed: boolean;
  content?: string;
}

type Mutation =
  | { type: "write"; path: string; content: string }
  | { type: "delete"; path: string };

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
]);
const SKIPPED_SOURCE_DIRECTORIES = new Set([
  ".amplio",
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
]);

function assertSlug(slug: string): void {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error(`Invalid Plugin slug "${slug}".`);
  }
}

async function resolveTrackedPath(
  cwd: string,
  relativePath: unknown,
  label: string,
): Promise<string> {
  const invalid = (): Error =>
    new Error(
      `Installed Plugin has an invalid ${label} path ${JSON.stringify(relativePath)}; no files were changed.`,
    );
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    relativePath.includes("\\") ||
    isPortableAbsolute(relativePath) ||
    path.posix.normalize(relativePath) !== relativePath ||
    relativePath
      .split("/")
      .some((segment) => segment === "." || segment === "..")
  ) {
    throw invalid();
  }
  const root = path.resolve(cwd);
  const resolved = path.resolve(root, relativePath);
  if (!isPathWithin(root, resolved)) throw invalid();
  try {
    if (!(await isCanonicallyWithin(root, resolved))) throw invalid();
  } catch (error) {
    if (error instanceof Error && error.message.includes("invalid")) {
      throw error;
    }
    throw invalid();
  }
  return resolved;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function projectSourceFiles(
  cwd: string,
  ignoredFiles: Set<string>,
  ignoredRoots: Set<string>,
): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && SKIPPED_SOURCE_DIRECTORIES.has(entry.name)) {
        continue;
      }
      const absolute = path.join(directory, entry.name);
      if (
        [...ignoredRoots].some((root) =>
          isPathWithin(root, path.resolve(absolute)),
        )
      ) {
        continue;
      }
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (
        entry.isFile() &&
        SOURCE_EXTENSIONS.has(path.extname(entry.name)) &&
        !ignoredFiles.has(path.resolve(absolute))
      ) {
        files.push(absolute);
      }
    }
  };
  await visit(await fs.realpath(path.resolve(cwd)));
  return files.sort();
}

function importedModuleSpecifiers(source: string): string[] {
  const mask = codeMask(source);
  const specifiers = new Set<string>();
  for (const token of mask.matchAll(/\b(?:import|export)\b/g)) {
    const tail = source.slice(token.index!);
    const declaration =
      /^import\s+(?:type\s+)?(?:[^;"']*?\s+from\s*)?(["'])([^"'\r\n]+)\1/.exec(
        tail,
      ) ??
      /^export\s+(?:type\s+)?[^;"']*?\s+from\s*(["'])([^"'\r\n]+)\1/.exec(tail);
    if (declaration?.[2]) specifiers.add(declaration[2]);

    const call = /^(?:import|require)\s*\(\s*(["'])([^"'\r\n]+)\1\s*\)/.exec(
      tail,
    );
    if (call?.[2]) specifiers.add(call[2]);
  }
  for (const token of mask.matchAll(/\brequire\b/g)) {
    const call = /^require\s*\(\s*(["'])([^"'\r\n]+)\1\s*\)/.exec(
      source.slice(token.index!),
    );
    if (call?.[2]) specifiers.add(call[2]);
  }
  return [...specifiers];
}

function withoutSourceExtension(filePath: string): string {
  return filePath.replace(/\.(?:[cm]?[jt]sx?)$/, "");
}

function moduleSpecifierTargetsPlugin(
  fromFile: string,
  moduleSpecifier: string,
  pluginSourcePath: string,
  trackedSource: string,
): boolean {
  const pluginWithoutExtension = withoutSourceExtension(
    path.resolve(pluginSourcePath),
  );
  if (moduleSpecifier.startsWith(".")) {
    return (
      withoutSourceExtension(
        path.resolve(path.dirname(fromFile), moduleSpecifier),
      ) === pluginWithoutExtension
    );
  }
  const portable = withoutSourceExtension(trackedSource.replace(/\\/g, "/"));
  return new Set([
    portable,
    `~${portable}`,
    `~/${portable}`,
    `@/${portable}`,
  ]).has(withoutSourceExtension(moduleSpecifier));
}

async function remainingPluginConsumers(options: {
  cwd: string;
  sourcePath: string;
  trackedSource: string;
  exportedNames: string[];
  ignoredFiles?: string[];
  ignoredRoots?: string[];
  proposedWrites: Mutation[];
}): Promise<string[]> {
  const proposed = new Map(
    await Promise.all(
      options.proposedWrites
        .filter(
          (mutation): mutation is Extract<Mutation, { type: "write" }> =>
            mutation.type === "write",
        )
        .map(
          async (mutation) =>
            [await canonicalizePath(mutation.path), mutation.content] as const,
        ),
    ),
  );
  const consumers: string[] = [];
  const ignoredFiles = new Set(
    await Promise.all(
      (options.ignoredFiles ?? []).map((file) => canonicalizePath(file)),
    ),
  );
  const ignoredRoots = new Set(
    await Promise.all(
      (options.ignoredRoots ?? []).map((root) => canonicalizePath(root)),
    ),
  );
  const canonicalSourcePath = await canonicalizePath(options.sourcePath);
  const canonicalCwd = await fs.realpath(path.resolve(options.cwd));
  for (const file of await projectSourceFiles(
    options.cwd,
    ignoredFiles,
    ignoredRoots,
  )) {
    if (path.resolve(file) === path.resolve(canonicalSourcePath)) continue;
    const source =
      proposed.get(path.resolve(file)) ?? (await fs.readFile(file, "utf8"));
    const mask = codeMask(source);
    if (
      importedModuleSpecifiers(source).some((specifier) =>
        moduleSpecifierTargetsPlugin(
          file,
          specifier,
          options.sourcePath,
          options.trackedSource,
        ),
      ) ||
      options.exportedNames.some((name) =>
        new RegExp(`\\b${name.replace(/[$]/g, "\\$")}\\b`).test(mask),
      )
    ) {
      consumers.push(path.relative(canonicalCwd, file).replace(/\\/g, "/"));
    }
  }
  return consumers;
}

async function configuredRegistryExclusions(
  cwd: string,
  config: Record<string, unknown>,
  metadata: PluginInstallMetadata,
): Promise<{ ignoredFiles: string[]; ignoredRoots: string[] }> {
  if (typeof config.registry !== "string") {
    return { ignoredFiles: [], ignoredRoots: [] };
  }
  const configured = path.isAbsolute(config.registry)
    ? config.registry
    : path.resolve(cwd, config.registry);
  const registryRoot = await fs
    .stat(configured)
    .then((stat) =>
      stat.isDirectory() ? configured : path.dirname(configured),
    )
    .catch(() => path.dirname(configured));
  const [canonicalCwd, canonicalRoot] = await Promise.all([
    fs.realpath(path.resolve(cwd)),
    canonicalizePath(registryRoot),
  ]);
  const recipePath = metadata.files[metadata.source]!.recipePath;
  const rootIsStrictProjectDescendant =
    path.resolve(canonicalRoot) !== path.resolve(canonicalCwd) &&
    isPathWithin(canonicalCwd, canonicalRoot);
  return {
    ignoredFiles: [
      await canonicalizePath(path.resolve(canonicalRoot, recipePath)),
    ],
    ignoredRoots: rootIsStrictProjectDescendant ? [canonicalRoot] : [],
  };
}

async function loadInstall(cwd: string, slug: string): Promise<LoadedInstall> {
  assertSlug(slug);
  const configPath = path.join(cwd, "amplio.json");
  if (!(await pathExists(configPath))) {
    throw new Error(
      `Plugin "${slug}" is not installed; amplio.json is missing.`,
    );
  }
  const config = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<
    string,
    unknown
  >;
  const plugins = config.plugins;
  const raw = isRecord(plugins) ? plugins[slug] : undefined;
  if (!isRecord(raw)) {
    throw new Error(`Plugin "${slug}" is not tracked in amplio.json.`);
  }
  if (
    (raw.role !== "boundary" && raw.role !== "contributor") ||
    typeof raw.source !== "string" ||
    typeof raw.recipeVersion !== "string" ||
    valid(raw.recipeVersion) === null ||
    typeof raw.recipeDigest !== "string" ||
    typeof raw.baseArchive !== "string" ||
    typeof raw.stateArchive !== "string" ||
    !isRecord(raw.files) ||
    !Array.isArray(raw.wiring) ||
    !Array.isArray(raw.events) ||
    typeof raw.privacyDigest !== "string" ||
    typeof raw.contractDigest !== "string" ||
    typeof raw.semanticDigest !== "string" ||
    typeof raw.dependencyDigest !== "string" ||
    !isRecord(raw.nativeTransform) ||
    !Number.isInteger(raw.nativeTransform.version) ||
    typeof raw.nativeTransform.digest !== "string" ||
    raw.events.some(
      (event) => !isRecord(event) || typeof event.semanticDigest !== "string",
    )
  ) {
    throw new Error(
      `Plugin "${slug}" was installed without lifecycle metadata. Preserve its source and reinstall it before using diff, update, or remove.`,
    );
  }
  return {
    configPath,
    config,
    metadata: raw as unknown as PluginInstallMetadata,
  };
}

function selectRecipeFile(
  item: RegistryItem,
  metadata: PluginInstallMetadata,
): RegistryFile {
  const trackedRecipePath = metadata.files[metadata.source]?.recipePath;
  const match = item.files.find(
    (file) =>
      file.path.replace(/^registry\//, "") === trackedRecipePath ||
      file.target?.replace(/^telemetry\//, "") ===
        metadata.source.replace(/^telemetry\//, ""),
  );
  if (!match) {
    throw new Error(
      `Registry Plugin "${item.name.replace(/^plugin-/, "")}" no longer has its tracked source file; no files were changed.`,
    );
  }
  return match;
}

async function loadCurrentRecipe(
  cwd: string,
  slug: string,
  metadata: PluginInstallMetadata,
): Promise<CurrentRecipe> {
  const registryPath = await resolveRegistryPath(cwd);
  await assertRegistryExists(registryPath);
  const registry = await loadRegistry(registryPath);
  const item = findRegistryItem(registry, `plugin-${slug}`);
  if (!item || (item.kind !== undefined && item.kind !== "plugin")) {
    throw new Error(`Registry Plugin "${slug}" was not found.`);
  }
  const file = selectRecipeFile(item, metadata);
  return {
    item,
    registryPath,
    file,
    source: normalizeGeneratedLocalImports(
      await readRegistryFileContent(registryPath, file.path, file.content),
      await usesExtensionlessGeneratedImports(cwd),
    ),
  };
}

async function loadBase(
  cwd: string,
  metadata: PluginInstallMetadata,
): Promise<{ archive: PluginBaseArchive; source: string }> {
  const archivePath = await resolveTrackedPath(
    cwd,
    metadata.baseArchive,
    "base archive",
  );
  const archive = JSON.parse(
    await fs.readFile(archivePath, "utf8"),
  ) as PluginBaseArchive;
  const source = archive.files?.[metadata.source];
  const tracked = metadata.files[metadata.source];
  if (
    archive.schemaVersion !== 1 ||
    archive.recipeDigest !== metadata.recipeDigest ||
    typeof source !== "string" ||
    !tracked ||
    contentHash(source) !== tracked.baseHash ||
    contentHash(source) !== metadata.recipeDigest
  ) {
    throw new Error(
      `Installed Plugin base archive failed integrity validation; no files were changed.`,
    );
  }
  return { archive, source };
}

async function snapshot(filePath: string): Promise<FileSnapshot> {
  const existed = await pathExists(filePath);
  return {
    path: filePath,
    existed,
    ...(existed ? { content: await fs.readFile(filePath, "utf8") } : {}),
  };
}

async function applyMutations(mutations: Mutation[]): Promise<void> {
  const unique = [
    ...new Map(mutations.map((mutation) => [mutation.path, mutation])).values(),
  ];
  const snapshots = await Promise.all(
    unique.map((mutation) => snapshot(mutation.path)),
  );
  try {
    for (const mutation of unique) {
      if (mutation.type === "write") {
        await ensureDir(path.dirname(mutation.path));
        await fs.writeFile(mutation.path, mutation.content, "utf8");
      } else {
        await fs.rm(mutation.path, { force: true });
      }
    }
  } catch (error) {
    for (const previous of [...snapshots].reverse()) {
      if (previous.existed) {
        await ensureDir(path.dirname(previous.path));
        await fs.writeFile(previous.path, previous.content!, "utf8");
      } else {
        await fs.rm(previous.path, { force: true });
      }
    }
    throw error;
  }
}

function nextConfigWithoutPlugin(
  config: Record<string, unknown>,
  slug: string,
): string {
  const plugins = { ...((config.plugins as Record<string, unknown>) ?? {}) };
  delete plugins[slug];
  return `${JSON.stringify({ ...config, plugins }, null, 2)}\n`;
}

export async function runDiffPlugin(
  slug: string,
  options: PluginLifecycleOptions,
): Promise<void> {
  const installed = await loadInstall(options.cwd, slug);
  const base = await loadBase(options.cwd, installed.metadata);
  const sourcePath = await resolveTrackedPath(
    options.cwd,
    installed.metadata.source,
    "Plugin source",
  );
  const local = await fs.readFile(sourcePath, "utf8");
  const current = await loadCurrentRecipe(
    options.cwd,
    slug,
    installed.metadata,
  );
  const localChanged = local !== base.source;
  const registryChanged = current.source !== base.source;
  const semanticChanged =
    current.item.semanticDigest !== installed.metadata.semanticDigest;
  const privacyChanged =
    pluginPrivacyDigest(current.item) !== installed.metadata.privacyDigest;
  const dependencyChanged =
    pluginDependencyDigest(current.item) !==
    installed.metadata.dependencyDigest;
  const currentNative = current.item.nativeTransform;
  const nativeChanged =
    !currentNative ||
    currentNative.version !== installed.metadata.nativeTransform.version ||
    currentNative.digest !== installed.metadata.nativeTransform.digest;

  console.log(`amplio diff plugin ${slug}`);
  console.log(
    `  installed recipe: ${String(installed.metadata.recipeVersion)} (${installed.metadata.recipeDigest})`,
  );
  console.log(
    `  registry recipe: ${String(current.item.recipeVersion ?? "unversioned")} (${contentHash(current.source)})`,
  );
  console.log(`  local source: ${localChanged ? "modified" : "unchanged"}`);
  console.log(
    `  registry source: ${registryChanged ? "update available" : "current"}`,
  );
  console.log(
    `  registry semantic: ${semanticChanged ? "changed" : "current"}`,
  );
  console.log(`  registry privacy: ${privacyChanged ? "changed" : "current"}`);
  console.log(
    `  registry dependencies: ${dependencyChanged ? "changed" : "current"}`,
  );
  console.log(
    `  registry native transform: ${nativeChanged ? "changed" : "current"} (v${installed.metadata.nativeTransform.version} → v${String(currentNative?.version ?? "missing")})`,
  );
  if (localChanged) {
    console.log(
      renderUnifiedDiff(base.source, local, {
        base: `${installed.metadata.source} (installed base)`,
        changed: `${installed.metadata.source} (local)`,
      }),
    );
  }
  if (registryChanged) {
    console.log(
      renderUnifiedDiff(base.source, current.source, {
        base: `${installed.metadata.source} (installed base)`,
        changed: `registry/plugin-${slug}@${String(current.item.recipeVersion)}`,
      }),
    );
  }
}

export async function runUpdatePlugin(
  slug: string,
  options: PluginLifecycleOptions,
): Promise<void> {
  const installed = await loadInstall(options.cwd, slug);
  const current = await loadCurrentRecipe(
    options.cwd,
    slug,
    installed.metadata,
  );
  const currentVersion = current.item.recipeVersion;
  if (!currentVersion || valid(currentVersion) === null) {
    throw new Error(
      `Plugin "${slug}" has missing or invalid SemVer recipeVersion metadata in the registry. No files were changed.`,
    );
  }
  const versionOrder = compare(
    currentVersion,
    installed.metadata.recipeVersion,
  );
  if (
    versionOrder === 0 &&
    contentHash(current.source) !== installed.metadata.recipeDigest
  ) {
    throw new Error(
      `Plugin "${slug}" kept the same recipeVersion ${currentVersion}, but its source changed. Registry recipes are immutable; publish a new SemVer recipeVersion. No files were changed.`,
    );
  }
  if (versionOrder < 0) {
    throw new Error(
      `Plugin "${slug}" registry recipeVersion ${currentVersion} is older than installed ${installed.metadata.recipeVersion}. Downgrades require an explicit migration; no files were changed.`,
    );
  }
  if (
    (current.item.role ?? installed.metadata.role) !== installed.metadata.role
  ) {
    throw new Error(
      `Plugin "${slug}" changed roles; remove and reinstall it after reviewing migration notes. No files were changed.`,
    );
  }
  if (
    installed.metadata.role === "contributor" &&
    current.item.placement?.branch !== installed.metadata.branch
  ) {
    throw new Error(
      `Plugin "${slug}" changed its Event tree path; remove and reinstall it after reviewing migration notes. No files were changed.`,
    );
  }

  const installedEvents = new Map(
    installed.metadata.events.map((event) => [event.id, event]),
  );
  const currentEvents = new Map(
    (current.item.events ?? []).map((event) => [event.id, event]),
  );
  const changedEventIds = new Set(
    [...installedEvents.keys(), ...currentEvents.keys()].filter(
      (eventId) => !installedEvents.has(eventId) || !currentEvents.has(eventId),
    ),
  );
  if (changedEventIds.size > 0) {
    throw new Error(
      `Plugin "${slug}" changed its nested Event identities (${[...changedEventIds].sort().join(", ")}). The installed source and wiring were preserved. Review the recipe migration notes, then remove and reinstall the Plugin explicitly.`,
    );
  }
  for (const [eventId, nextEvent] of currentEvents) {
    const previousEvent = installedEvents.get(eventId)!;
    if (nextEvent.version < previousEvent.version) {
      throw new Error(
        `Plugin "${slug}" downgraded Event ${eventId} from wire version ${previousEvent.version} to ${nextEvent.version}. The installed source and wiring were preserved; publish a newer Event version or migrate manually.`,
      );
    }
    if (
      nextEvent.semanticDigest !== previousEvent.semanticDigest &&
      nextEvent.version === previousEvent.version
    ) {
      throw new Error(
        `Plugin "${slug}" changed semantic shape for Event ${eventId} while keeping wire version ${previousEvent.version}. Publish version ${previousEvent.version + 1} (or newer), then retry; no files were changed.`,
      );
    }
  }

  const currentNative = current.item.nativeTransform;
  if (
    !currentNative ||
    currentNative.version !== installed.metadata.nativeTransform.version ||
    currentNative.digest !== installed.metadata.nativeTransform.digest ||
    pluginContractDigest(current.item) !== installed.metadata.contractDigest
  ) {
    throw new Error(
      `Plugin "${slug}" changed its native transform contract (installed v${installed.metadata.nativeTransform.version}, registry v${String(currentNative?.version ?? "missing")}). The installed source and wiring were preserved. Review the native migration notes, then remove and reinstall the Plugin explicitly.`,
    );
  }
  if (pluginPrivacyDigest(current.item) !== installed.metadata.privacyDigest) {
    throw new Error(
      `Plugin "${slug}" changed its privacy contract. The installed source and wiring were preserved; review the privacy delta with amplio diff plugin ${slug}, then remove and reinstall explicitly.`,
    );
  }
  if (
    pluginDependencyDigest(current.item) !== installed.metadata.dependencyDigest
  ) {
    throw new Error(
      `Plugin "${slug}" changed its dependency contract. The installed package state, source, and wiring were preserved; review amplio diff plugin ${slug}, then remove and reinstall explicitly.`,
    );
  }
  await assertPluginCompatibility({
    cwd: options.cwd,
    item: current.item,
    allowMissing: installed.metadata.sourceOnly === true,
  });

  const base = await loadBase(options.cwd, installed.metadata);
  const sourcePath = await resolveTrackedPath(
    options.cwd,
    installed.metadata.source,
    "Plugin source",
  );
  const localSource = await fs.readFile(sourcePath, "utf8");
  const merge = threeWayMerge(base.source, localSource, current.source);
  if (!merge.ok) {
    const lines = merge.conflicts
      .map((conflict) =>
        conflict.baseEnd > conflict.baseStart
          ? `${conflict.baseStart + 1}-${conflict.baseEnd}`
          : String(conflict.baseStart + 1),
      )
      .join(", ");
    throw new Error(
      `Plugin "${slug}" has overlapping local and registry edits near base line(s) ${lines}. The local file was preserved; run amplio diff plugin ${slug}, reconcile it manually, then retry.`,
    );
  }

  const nextState = planPluginState({
    cwd: options.cwd,
    slug,
    item: current.item,
    role: installed.metadata.role,
    sourcePath,
    recipePath: current.file.path,
    recipeSource: current.source,
    ...(installed.metadata.event ? { event: installed.metadata.event } : {}),
    ...(installed.metadata.branch ? { branch: installed.metadata.branch } : {}),
    ...(installed.metadata.compositionRoot
      ? { compositionRoot: installed.metadata.compositionRoot }
      : {}),
    ...(installed.metadata.sourceOnly ? { sourceOnly: true } : {}),
  });
  const metadata: PluginInstallMetadata = {
    ...installed.metadata,
    recipeVersion: nextState.metadata.recipeVersion,
    recipeDigest: nextState.metadata.recipeDigest,
    baseArchive: nextState.metadata.baseArchive,
    ...(nextState.metadata.coreRange
      ? { coreRange: nextState.metadata.coreRange }
      : {}),
    peers: nextState.metadata.peers,
    events: nextState.metadata.events,
    semanticDigest: nextState.metadata.semanticDigest,
    nativeTransform: nextState.metadata.nativeTransform,
    dependencyDigest: nextState.metadata.dependencyDigest,
    privacyDigest: nextState.metadata.privacyDigest,
    contractDigest: nextState.metadata.contractDigest,
    files: nextState.metadata.files,
  };
  const plugins = {
    ...((installed.config.plugins as Record<string, unknown>) ?? {}),
    [slug]: metadata,
  };
  const nextConfig = `${JSON.stringify(
    { ...installed.config, plugins },
    null,
    2,
  )}\n`;
  const mutations: Mutation[] = [
    { type: "write", path: sourcePath, content: merge.content },
    {
      type: "write",
      path: nextState.baseArchivePath,
      content: nextState.baseArchiveContent,
    },
    { type: "write", path: installed.configPath, content: nextConfig },
  ];
  await applyMutations(mutations);
  const changed =
    localSource !== merge.content ||
    installed.metadata.recipeDigest !== metadata.recipeDigest;
  console.log(`amplio update plugin ${slug}`);
  console.log(
    changed
      ? `  ✓ ${installed.metadata.source} updated with a three-way merge`
      : `  · ${installed.metadata.source} is already current`,
  );
}

export async function runRemovePlugin(
  slug: string,
  options: PluginLifecycleOptions,
): Promise<void> {
  const installed = await loadInstall(options.cwd, slug);
  const base = await loadBase(options.cwd, installed.metadata);
  const sourcePath = await resolveTrackedPath(
    options.cwd,
    installed.metadata.source,
    "Plugin source",
  );
  const localSource = await fs.readFile(sourcePath, "utf8");
  if (localSource !== base.source) {
    throw new Error(
      `Plugin source ${installed.metadata.source} has customer edits and was preserved. Copy or commit those edits, restore the installed recipe shown by amplio diff plugin ${slug}, then retry removal. The provider dependency was not changed.`,
    );
  }

  const statePath = await resolveTrackedPath(
    options.cwd,
    installed.metadata.stateArchive,
    "state archive",
  );
  const state = JSON.parse(
    await fs.readFile(statePath, "utf8"),
  ) as PluginStateArchive;
  if (
    state.schemaVersion !== 1 ||
    state.plugin !== slug ||
    !isRecord(state.files)
  ) {
    throw new Error(
      `Plugin "${slug}" state archive failed integrity validation; no files were changed.`,
    );
  }

  const wiringMutations: Mutation[] = [];
  for (const entry of installed.metadata.wiring) {
    if (
      !isRecord(entry) ||
      typeof entry.file !== "string" ||
      typeof entry.beforeHash !== "string" ||
      typeof entry.installedHash !== "string" ||
      (entry.ownership !== undefined &&
        entry.ownership !== "managed" &&
        entry.ownership !== "adopted")
    ) {
      throw new Error(
        `Plugin "${slug}" wiring metadata is invalid; no files were changed.`,
      );
    }
    const saved = state.files[entry.file];
    if (
      !saved ||
      contentHash(saved.before) !== entry.beforeHash ||
      contentHash(saved.installed) !== entry.installedHash
    ) {
      throw new Error(
        `Plugin "${slug}" wiring state failed integrity validation; no files were changed.`,
      );
    }
    if (entry.ownership === "adopted") continue;
    const filePath = await resolveTrackedPath(
      options.cwd,
      entry.file,
      "wiring",
    );
    const current = await fs.readFile(filePath, "utf8");
    const merge = threeWayMerge(saved.installed, current, saved.before);
    if (!merge.ok) {
      throw new Error(
        `Plugin "${slug}" cannot be removed safely because ${entry.file} changed across its managed wiring. The file was preserved; remove the Plugin wiring manually, then update amplio.json.`,
      );
    }
    wiringMutations.push({
      type: "write",
      path: filePath,
      content: merge.content,
    });
  }

  const registryExclusions = await configuredRegistryExclusions(
    options.cwd,
    installed.config,
    installed.metadata,
  );
  const consumers = await remainingPluginConsumers({
    cwd: options.cwd,
    sourcePath,
    trackedSource: installed.metadata.source,
    exportedNames: [
      ...new Set([
        ...(installed.metadata.provider?.instrumenter
          ? [installed.metadata.provider.instrumenter]
          : []),
        ...[
          ...codeMask(localSource).matchAll(
            /\bexport\s+(?:async\s+)?(?:class|function|const|let|var)\s+([A-Za-z_$][\w$]*)/g,
          ),
        ].map((match) => match[1]!),
      ]),
    ],
    ...registryExclusions,
    proposedWrites: wiringMutations,
  });
  if (consumers.length > 0) {
    throw new Error(
      `Plugin "${slug}" is still imported or referenced by ${consumers.join(", ")} after managed wiring removal. All files were preserved; remove its Plugin import or reference manually, then retry. The provider dependency was not changed.`,
    );
  }

  await applyMutations([
    ...wiringMutations,
    {
      type: "write",
      path: installed.configPath,
      content: nextConfigWithoutPlugin(installed.config, slug),
    },
    { type: "delete", path: sourcePath },
    { type: "delete", path: statePath },
  ]);
  console.log(`amplio remove plugin ${slug}`);
  console.log(
    installed.metadata.wiring.some((entry) => entry.ownership === "adopted")
      ? `  ✓ removed ${installed.metadata.source}; verified customer-owned wiring was not rewritten`
      : `  ✓ removed ${installed.metadata.source} and managed wiring`,
  );
  console.log("  · provider dependencies were retained");
}
