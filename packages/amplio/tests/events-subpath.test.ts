import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = path.join(packageRoot, "src");

const resolveImport = (fromFile: string, specifier: string): string | null => {
  if (!specifier.startsWith(".")) {
    return null;
  }
  const base = path.dirname(fromFile);
  const withoutExt = specifier.endsWith(".js") ? specifier.slice(0, -3) : specifier;
  const candidates = [
    path.resolve(base, `${withoutExt}.ts`),
    path.resolve(base, `${withoutExt}.tsx`),
    path.resolve(base, withoutExt),
  ];
  for (const candidate of candidates) {
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
};

const collectTransitiveImports = (entryFile: string): string[] => {
  const visited = new Set<string>();
  const queue = [entryFile];

  while (queue.length > 0) {
    const file = queue.shift()!;
    if (visited.has(file)) {
      continue;
    }
    visited.add(file);

    const source = readFileSync(file, "utf8");
    const importRe = /from\s+["']([^"']+)["']/g;
    for (const match of source.matchAll(importRe)) {
      const specifier = match[1]!;
      if (!specifier.startsWith(".")) {
        continue;
      }
      const resolved = resolveImport(file, specifier);
      if (resolved && resolved.startsWith(srcRoot)) {
        queue.push(resolved);
      }
    }
  }

  return [...visited];
};

describe("@useamplio/amplio/events subpath", () => {
  it("does not transitively import node:async_hooks", () => {
    const entry = path.join(srcRoot, "events.ts");
    const files = collectTransitiveImports(entry);

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toContain("node:async_hooks");
    }
  });
});
