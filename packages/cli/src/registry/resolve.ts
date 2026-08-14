import fs from "node:fs/promises";
import path from "node:path";
import type { RegistryItem, RegistryManifest } from "./types.js";
import { hydrateRegistryPluginContracts } from "./plugin-contracts.mjs";
import { pathExists } from "../utils/fs.js";
import {
  isCanonicallyWithin,
  isPathWithin,
  isPortableAbsolute,
} from "../utils/path-containment.js";

interface ManifestEntry extends Omit<RegistryItem, "files" | "type"> {
  source: string;
  target: string;
}

interface ManifestFile {
  name: string;
  homepage?: string;
  items: ManifestEntry[];
}

async function resolveContainedRegistryPath(options: {
  registryRoot: string;
  relativePath: string;
  label: "Manifest source" | "Registry file path";
}): Promise<string> {
  const { registryRoot, relativePath, label } = options;
  const invalid = (): Error =>
    new Error(
      `${label} "${relativePath}" escapes the registry root; no files were changed.`,
    );
  if (
    relativePath.length === 0 ||
    relativePath.includes("\\") ||
    isPortableAbsolute(relativePath) ||
    path.posix.normalize(relativePath) !== relativePath ||
    relativePath
      .split("/")
      .some((segment) => segment === ".." || segment === ".")
  ) {
    throw invalid();
  }
  const sourcePath = path.resolve(registryRoot, relativePath);
  if (!isPathWithin(path.resolve(registryRoot), sourcePath)) throw invalid();
  try {
    if (!(await isCanonicallyWithin(registryRoot, sourcePath))) {
      throw new Error(
        `${label} "${relativePath}" resolves through a symlink outside the registry root; no files were changed.`,
      );
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("outside the registry root")
    ) {
      throw error;
    }
    throw new Error(
      `${label} "${relativePath}" could not be validated safely; no files were changed.`,
      { cause: error },
    );
  }
  return sourcePath;
}

export async function loadRegistry(
  registryPath: string,
): Promise<RegistryManifest> {
  const raw = await fs.readFile(registryPath, "utf8");
  const parsed = JSON.parse(raw) as RegistryManifest | ManifestFile;

  if (
    "items" in parsed &&
    parsed.items.length > 0 &&
    "source" in parsed.items[0]!
  ) {
    return loadRegistryFromManifest(registryPath, parsed as ManifestFile);
  }

  return parsed as RegistryManifest;
}

async function loadRegistryFromManifest(
  manifestPath: string,
  manifest: ManifestFile,
): Promise<RegistryManifest> {
  const registryRoot = path.dirname(manifestPath);
  const items: RegistryItem[] = [];

  for (const entry of manifest.items) {
    const { source, target, ...metadata } = entry;
    const sourcePath = await resolveContainedRegistryPath({
      registryRoot,
      relativePath: source,
      label: "Manifest source",
    });
    const content = await fs.readFile(sourcePath, "utf8");
    const fileType = source.endsWith(".json")
      ? "registry:file"
      : "registry:lib";
    const resolvedTarget = target.startsWith("telemetry/")
      ? target.slice("telemetry/".length)
      : target;

    items.push({
      ...metadata,
      type: "registry:lib",
      files: [
        {
          path: path.posix.join("registry", source),
          type: fileType,
          target: resolvedTarget,
          content,
        },
      ],
    });
  }

  return {
    $schema: "https://ui.shadcn.com/schema/registry.json",
    name: manifest.name,
    ...(manifest.homepage ? { homepage: manifest.homepage } : {}),
    items: hydrateRegistryPluginContracts(items),
  };
}

function normalizeRegistryDependencyName(depName: string): string {
  const prefix = "@useamplio/";
  return depName.startsWith(prefix) ? depName.slice(prefix.length) : depName;
}

export function findRegistryItem(
  manifest: RegistryManifest,
  name: string,
): RegistryItem | undefined {
  return manifest.items.find((item) => item.name === name);
}

export async function readRegistryFileContent(
  registryPath: string,
  filePath: string,
  embedded?: string,
): Promise<string> {
  const registryRoot = path.dirname(registryPath);
  const relativePath = filePath.replace(/^registry\//, "");
  const absolute = await resolveContainedRegistryPath({
    registryRoot,
    relativePath,
    label: "Registry file path",
  });
  if (embedded) {
    return embedded;
  }
  return fs.readFile(absolute, "utf8");
}

export async function resolveRegistryDependencies(
  registryPath: string,
  manifest: RegistryManifest,
  item: RegistryItem,
  resolved = new Set<string>(),
): Promise<RegistryItem[]> {
  const ordered: RegistryItem[] = [];
  const visit = (current: RegistryItem) => {
    if (resolved.has(current.name)) {
      return;
    }
    resolved.add(current.name);

    for (const depName of current.registryDependencies ?? []) {
      const dep = findRegistryItem(
        manifest,
        normalizeRegistryDependencyName(depName),
      );
      if (!dep) {
        throw new Error(
          `Registry dependency "${depName}" not found in ${registryPath}`,
        );
      }
      visit(dep);
    }

    ordered.push(current);
  };

  visit(item);
  return ordered;
}

export async function assertRegistryExists(
  registryPath: string,
): Promise<void> {
  if (await pathExists(registryPath)) {
    return;
  }

  const manifestPath = registryPath.replace(
    /registry\.json$/,
    "registry.manifest.json",
  );
  if (await pathExists(manifestPath)) {
    return;
  }

  throw new Error(
    `Registry not found at ${registryPath}. Run amplio init first.`,
  );
}
