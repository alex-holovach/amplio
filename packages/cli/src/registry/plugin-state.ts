import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { valid } from "semver";
import type { RegistryItem, RegistryPluginProvider } from "./types.js";
import { ensureDir, pathExists } from "../utils/fs.js";
import {
  isCanonicallyWithin,
  isPathWithin,
} from "../utils/path-containment.js";

export type PluginWiringKind =
  "event-mount" | "provider-construction" | "boundary-registration";

export interface PluginWiringSnapshot {
  file: string;
  kind: PluginWiringKind;
  anchor: string;
  before: string;
  installed: string;
  ownership?: "managed" | "adopted";
}

export interface PluginInstallMetadata {
  recipeVersion: string;
  recipeDigest: string;
  baseArchive: string;
  stateArchive: string;
  coreRange?: string;
  peers: Record<string, string>;
  events: Array<{
    id: string;
    version: number;
    semanticDigest: string;
  }>;
  semanticDigest: string;
  nativeTransform: {
    version: number;
    digest: string;
  };
  dependencyDigest: string;
  privacyDigest: string;
  contractDigest: string;
  provider?: RegistryPluginProvider;
  role: "boundary" | "contributor";
  event?: string;
  branch?: string;
  source: string;
  compositionRoot?: string;
  sourceOnly?: boolean;
  mounts: Array<{
    instanceKey: "default";
    rootEventId: string;
    path: string[];
  }>;
  files: Record<
    string,
    { recipePath: string; baseHash: string; kind: "copied" }
  >;
  wiring: Array<{
    file: string;
    kind: PluginWiringKind;
    anchor: string;
    beforeHash: string;
    installedHash: string;
    ownership?: "managed" | "adopted";
  }>;
}

export interface PluginBaseArchive {
  schemaVersion: 1;
  recipeDigest: string;
  recipeVersion: string;
  files: Record<string, string>;
}

export interface PluginStateArchive {
  schemaVersion: 1;
  plugin: string;
  files: Record<string, { before: string; installed: string }>;
}

export interface PluginStatePlan {
  metadata: PluginInstallMetadata;
  baseArchivePath: string;
  baseArchiveContent: string;
  stateArchivePath: string;
  stateArchiveContent: string;
}

export function contentHash(content: string): string {
  return `sha256-${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function pluginPrivacyDigest(item: RegistryItem): string {
  return contentHash(stableJson(item.privacy ?? {}));
}

export function pluginContractDigest(item: RegistryItem): string {
  return contentHash(
    stableJson({
      role: item.role,
      placement: item.placement,
      provider: item.provider,
      wiringActions: (item.wiringActions ?? []).map((action) => ({
        type: action.type,
        export: action.export,
      })),
    }),
  );
}

export function pluginDependencyDigest(item: RegistryItem): string {
  return contentHash(
    stableJson({
      coreRange: item.coreRange,
      providerRanges: item.providerRanges,
      dependencies: [...(item.dependencies ?? [])].sort(),
      devDependencies: [...(item.devDependencies ?? [])].sort(),
      registryDependencies: [...(item.registryDependencies ?? [])]
        .map((dependency) => dependency.replace(/^@useamplio\//, ""))
        .sort(),
    }),
  );
}

function portableRelative(cwd: string, filePath: string): string {
  return path.relative(cwd, filePath).replace(/\\/g, "/");
}

export function planPluginState(options: {
  cwd: string;
  slug: string;
  item: RegistryItem;
  role: "boundary" | "contributor";
  sourcePath: string;
  recipePath: string;
  recipeSource: string;
  event?: string;
  branch?: string;
  compositionRoot?: string;
  sourceOnly?: boolean;
  wiring?: PluginWiringSnapshot[];
}): PluginStatePlan {
  const source = portableRelative(options.cwd, options.sourcePath);
  const recipeVersion = options.item.recipeVersion;
  if (!recipeVersion || valid(recipeVersion) === null) {
    throw new Error(
      `Plugin "${options.slug}" has an invalid recipeVersion; expected a SemVer string. No files were changed.`,
    );
  }
  const recipeDigest = contentHash(options.recipeSource);
  const baseArchive = `.amplio/bases/${recipeDigest}.json`;
  const stateArchive = `.amplio/installs/${options.slug}.json`;
  const wiring = options.wiring ?? [];
  const semanticDigest = options.item.semanticDigest;
  const nativeTransform = options.item.nativeTransform;
  const events = options.item.events ?? [];
  if (
    typeof semanticDigest !== "string" ||
    semanticDigest.length === 0 ||
    !nativeTransform ||
    !Number.isInteger(nativeTransform.version) ||
    nativeTransform.version < 1 ||
    typeof nativeTransform.digest !== "string" ||
    nativeTransform.digest.length === 0 ||
    events.length === 0 ||
    events.some(
      (entry) =>
        typeof entry.semanticDigest !== "string" ||
        entry.semanticDigest.length === 0,
    )
  ) {
    throw new Error(
      `Plugin "${options.slug}" is missing derived semantic or native transform contract metadata. No files were changed.`,
    );
  }
  const metadata: PluginInstallMetadata = {
    recipeVersion,
    recipeDigest,
    baseArchive,
    stateArchive,
    ...(options.item.coreRange ? { coreRange: options.item.coreRange } : {}),
    peers: { ...(options.item.providerRanges ?? {}) },
    events: events.map((entry) => ({
      id: entry.id,
      version: entry.version,
      semanticDigest: entry.semanticDigest!,
    })),
    semanticDigest,
    nativeTransform: {
      version: nativeTransform.version,
      digest: nativeTransform.digest,
    },
    dependencyDigest: pluginDependencyDigest(options.item),
    privacyDigest: pluginPrivacyDigest(options.item),
    contractDigest: pluginContractDigest(options.item),
    ...(options.item.provider ? { provider: options.item.provider } : {}),
    role: options.role,
    ...(options.event ? { event: options.event } : {}),
    ...(options.branch ? { branch: options.branch } : {}),
    source,
    ...(options.compositionRoot
      ? { compositionRoot: options.compositionRoot }
      : {}),
    ...(options.sourceOnly ? { sourceOnly: true } : {}),
    mounts:
      options.role === "contributor" && options.event && options.branch
        ? [
            {
              instanceKey: "default",
              rootEventId: options.event,
              path: [options.branch],
            },
          ]
        : [],
    files: {
      [source]: {
        recipePath: options.recipePath.replace(/^registry\//, ""),
        baseHash: contentHash(options.recipeSource),
        kind: "copied",
      },
    },
    wiring: wiring.map((entry) => ({
      file: entry.file,
      kind: entry.kind,
      anchor: entry.anchor,
      beforeHash: contentHash(entry.before),
      installedHash: contentHash(entry.installed),
      ...(entry.ownership ? { ownership: entry.ownership } : {}),
    })),
  };
  const base: PluginBaseArchive = {
    schemaVersion: 1,
    recipeDigest,
    recipeVersion: metadata.recipeVersion,
    files: { [source]: options.recipeSource },
  };
  const state: PluginStateArchive = {
    schemaVersion: 1,
    plugin: options.slug,
    files: Object.fromEntries(
      wiring.map((entry) => [
        entry.file,
        { before: entry.before, installed: entry.installed },
      ]),
    ),
  };
  return {
    metadata,
    baseArchivePath: path.join(options.cwd, baseArchive),
    baseArchiveContent: `${JSON.stringify(base, null, 2)}\n`,
    stateArchivePath: path.join(options.cwd, stateArchive),
    stateArchiveContent: `${JSON.stringify(state, null, 2)}\n`,
  };
}

export async function assertPluginStatePathsContained(
  cwd: string,
  plan: PluginStatePlan,
): Promise<void> {
  const root = path.resolve(cwd);
  for (const candidate of [plan.baseArchivePath, plan.stateArchivePath]) {
    if (
      !isPathWithin(root, path.resolve(candidate)) ||
      !(await isCanonicallyWithin(root, candidate))
    ) {
      throw new Error(
        "The .amplio lifecycle cache resolves outside the project; no files were changed.",
      );
    }
  }
}

export async function assertPluginCacheContained(cwd: string): Promise<void> {
  const root = path.resolve(cwd);
  for (const directory of [
    path.join(root, ".amplio"),
    path.join(root, ".amplio", "bases"),
    path.join(root, ".amplio", "installs"),
  ]) {
    try {
      if (!(await fs.stat(directory)).isDirectory()) {
        throw new Error("not a directory");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error(
        "The .amplio lifecycle cache is not a safe project directory; no files were changed.",
      );
    }
  }
  for (const candidate of [
    path.join(root, ".amplio", "bases", "probe"),
    path.join(root, ".amplio", "installs", "probe"),
  ]) {
    if (!(await isCanonicallyWithin(root, candidate))) {
      throw new Error(
        "The .amplio lifecycle cache resolves outside the project; no files were changed.",
      );
    }
  }
}

export async function persistPluginState(options: {
  cwd: string;
  slug: string;
  plan: PluginStatePlan;
}): Promise<PluginInstallMetadata> {
  await assertPluginCacheContained(options.cwd);
  await assertPluginStatePathsContained(options.cwd, options.plan);
  const configPath = path.join(options.cwd, "amplio.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<
    string,
    unknown
  >;
  const existing = (
    config.plugins as Record<string, PluginInstallMetadata> | undefined
  )?.[options.slug];
  const promotesSourceOnly =
    existing?.sourceOnly === true && options.plan.metadata.sourceOnly !== true;
  if (
    existing?.recipeDigest &&
    existing.baseArchive &&
    existing.stateArchive &&
    !promotesSourceOnly
  ) {
    return existing;
  }
  const plugins = {
    ...((config.plugins as Record<string, unknown> | undefined) ?? {}),
    [options.slug]: options.plan.metadata,
  };
  const writes = [
    {
      path: options.plan.baseArchivePath,
      content: options.plan.baseArchiveContent,
    },
    {
      path: options.plan.stateArchivePath,
      content: options.plan.stateArchiveContent,
    },
    {
      path: configPath,
      content: `${JSON.stringify({ ...config, plugins }, null, 2)}\n`,
    },
  ];
  const snapshots = await Promise.all(
    writes.map(async (entry) => {
      const existed = await pathExists(entry.path);
      return {
        path: entry.path,
        existed,
        ...(existed ? { content: await fs.readFile(entry.path, "utf8") } : {}),
      };
    }),
  );
  try {
    for (const entry of writes) {
      await ensureDir(path.dirname(entry.path));
      await fs.writeFile(entry.path, entry.content, "utf8");
    }
  } catch (error) {
    for (const snapshot of [...snapshots].reverse()) {
      if (snapshot.existed) {
        await fs.writeFile(snapshot.path, snapshot.content!, "utf8");
      } else {
        await fs.rm(snapshot.path, { force: true });
      }
    }
    throw error;
  }
  return options.plan.metadata;
}
