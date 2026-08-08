import fs from "node:fs/promises";
import path from "node:path";
import type { RegistryItem, RegistryManifest } from "./types.js";
import { pathExists } from "../utils/fs.js";

interface ManifestEntry {
  name: string;
  source: string;
  target: string;
  description?: string;
  dependencies?: string[];
  devDependencies?: string[];
  registryDependencies?: string[];
}

interface ManifestFile {
  name: string;
  homepage?: string;
  items: ManifestEntry[];
}

export async function loadRegistry(registryPath: string): Promise<RegistryManifest> {
  const raw = await fs.readFile(registryPath, "utf8");
  const parsed = JSON.parse(raw) as RegistryManifest | ManifestFile;

  if ("items" in parsed && parsed.items.length > 0 && "source" in parsed.items[0]!) {
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
    const sourcePath = path.join(registryRoot, entry.source);
    const content = await fs.readFile(sourcePath, "utf8");
    const fileType = entry.source.endsWith(".json") ? "registry:file" : "registry:lib";
    const target = entry.target.startsWith("telemetry/")
      ? `~/${entry.target.slice("telemetry/".length)}`
      : entry.target;

    items.push({
      name: entry.name,
      type: "registry:lib",
      ...(entry.description ? { description: entry.description } : {}),
      ...(entry.dependencies ? { dependencies: entry.dependencies } : {}),
      ...(entry.devDependencies ? { devDependencies: entry.devDependencies } : {}),
      ...(entry.registryDependencies ? { registryDependencies: entry.registryDependencies } : {}),
      files: [
        {
          path: path.posix.join("registry", entry.source),
          type: fileType,
          target,
          content,
        },
      ],
    });
  }

  return {
    $schema: "https://ui.shadcn.com/schema/registry.json",
    name: manifest.name,
    ...(manifest.homepage ? { homepage: manifest.homepage } : {}),
    items,
  };
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
  if (embedded) {
    return embedded;
  }
  const registryRoot = path.dirname(registryPath);
  const absolute = path.resolve(registryRoot, filePath.replace(/^registry\//, ""));
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
      const dep = findRegistryItem(manifest, depName);
      if (!dep) {
        throw new Error(`Registry dependency "${depName}" not found in ${registryPath}`);
      }
      visit(dep);
    }

    ordered.push(current);
  };

  visit(item);
  return ordered;
}

export async function assertRegistryExists(registryPath: string): Promise<void> {
  if (await pathExists(registryPath)) {
    return;
  }

  const manifestPath = registryPath.replace(/registry\.json$/, "registry.manifest.json");
  if (await pathExists(manifestPath)) {
    return;
  }

  throw new Error(`Registry not found at ${registryPath}. Run amplio init first.`);
}
