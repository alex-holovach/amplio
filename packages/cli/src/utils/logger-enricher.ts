import fs from "node:fs/promises";
import { pathExists } from "./fs.js";

const SERVICE_IMPORT =
  'import { serviceMetadata } from "./enrichers/service-metadata.js";';
const SERVICE_IMPORT_PATTERN =
  /^import\s+\{\s*serviceMetadata\s*\}\s+from\s+["']\.\/enrichers\/service-metadata(?:\.js)?["'];?$/m;

function hasServiceImport(source: string): boolean {
  return SERVICE_IMPORT_PATTERN.test(source);
}

function extractEnrichers(source: string): {
  start: number;
  end: number;
  items: string[];
} | null {
  const match = /enrichers:\s*\[/.exec(source);
  if (!match || match.index === undefined) return null;
  const start = match.index + match[0].length;
  const end = source.indexOf("]", start);
  if (end === -1) return null;
  return {
    start,
    end,
    items: source
      .slice(start, end)
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  };
}

function insertImport(source: string): string {
  if (hasServiceImport(source)) return source;
  const imports = [...source.matchAll(/^import\s.+;$/gm)];
  const last = imports.at(-1);
  if (!last) return `${SERVICE_IMPORT}\n${source}`;
  const at = (last.index ?? 0) + last[0].length;
  return `${source.slice(0, at)}\n${SERVICE_IMPORT}${source.slice(at)}`;
}

export async function isEnricherWired(
  runtimePath: string,
  id: string,
): Promise<boolean> {
  if (id !== "service-metadata" || !(await pathExists(runtimePath))) {
    return false;
  }
  const source = await fs.readFile(runtimePath, "utf8");
  return (
    hasServiceImport(source) &&
    (extractEnrichers(source)?.items.includes("serviceMetadata") ?? false)
  );
}

export async function updateRuntimeWithEnricher(
  runtimePath: string,
  id: string,
  dryRun = false,
): Promise<boolean> {
  if (id !== "service-metadata" || !(await pathExists(runtimePath))) {
    return false;
  }
  const source = await fs.readFile(runtimePath, "utf8");
  if (await isEnricherWired(runtimePath, id)) return false;
  const withImport = insertImport(source);
  const array = extractEnrichers(withImport);
  if (!array) return false;
  const items = [...array.items, "serviceMetadata"];
  const updated = `${withImport.slice(0, array.start)}${items.join(", ")}${withImport.slice(array.end)}`;
  if (!dryRun) await fs.writeFile(runtimePath, updated, "utf8");
  return true;
}
