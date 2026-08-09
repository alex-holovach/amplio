import fs from "node:fs/promises";
import { pathExists } from "./fs.js";

type SinkMeta = {
  exportName: string;
  sinkExpression: string;
  importPath: string;
};

const SINK_META: Record<string, SinkMeta> = {
  console: {
    exportName: "consoleSink",
    sinkExpression: "consoleSink",
    importPath: "./sinks/console",
  },
  otlp: {
    exportName: "otlpSink",
    sinkExpression: "otlpSink()",
    importPath: "./sinks/otlp",
  },
  json: {
    exportName: "jsonFileSink",
    sinkExpression: "jsonFileSink()",
    importPath: "./sinks/json",
  },
};

function hasInitAndSinks(source: string): boolean {
  return source.includes("init(") && source.includes("sinks:");
}

function sinkAlreadyInSinksArray(source: string, meta: SinkMeta): boolean {
  const arrayContent = extractSinksArrayContent(source);
  if (!arrayContent) {
    return false;
  }

  const { items } = arrayContent;
  return items.some(
    (item) =>
      item === meta.sinkExpression ||
      item === meta.exportName ||
      item.startsWith(`${meta.exportName}(`),
  );
}

function extractSinksArrayContent(
  source: string,
): { items: string[]; arrayStart: number; arrayEnd: number } | null {
  const composeMatch = source.match(/sinks:\s*composeSinks\([^,]+,\s*\[/);
  const plainMatch = source.match(/sinks:\s*\[/);

  const match = composeMatch ?? plainMatch;
  if (!match || match.index === undefined) {
    return null;
  }

  const arrayStart = match.index + match[0].length;
  let depth = 1;
  let arrayEnd = arrayStart;

  for (let i = arrayStart; i < source.length; i++) {
    const char = source[i];
    if (char === "[") {
      depth += 1;
    } else if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        arrayEnd = i;
        break;
      }
    }
  }

  if (depth !== 0) {
    return null;
  }

  const rawItems = source.slice(arrayStart, arrayEnd);
  const items = rawItems
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return { items, arrayStart, arrayEnd };
}

function hasSinkImport(source: string, meta: SinkMeta): boolean {
  const importPattern = new RegExp(
    `import\\s*\\{[^}]*\\b${meta.exportName}\\b[^}]*\\}\\s*from\\s*["']${escapeRegExp(meta.importPath)}["']`,
  );
  return importPattern.test(source);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeAfterImportBlock(rest: string): string {
  const trimmed = rest.replace(/^\n+/, "");
  return trimmed.length > 0 ? `\n\n${trimmed}` : rest;
}

function insertImport(source: string, meta: SinkMeta): string {
  if (hasSinkImport(source, meta)) {
    return source;
  }

  const importLine = `import { ${meta.exportName} } from "${meta.importPath}";`;
  const importMatches = [...source.matchAll(/^import\s.+;$/gm)];

  if (importMatches.length === 0) {
    return `${importLine}\n${source}`;
  }

  const lastImport = importMatches[importMatches.length - 1];
  if (!lastImport) {
    return `${importLine}\n${source}`;
  }
  const insertAt = (lastImport.index ?? 0) + lastImport[0].length;
  const rest = normalizeAfterImportBlock(source.slice(insertAt));
  return `${source.slice(0, insertAt)}\n${importLine}${rest}`;
}

function appendSinkToArray(source: string, meta: SinkMeta): string {
  const arrayContent = extractSinksArrayContent(source);
  if (!arrayContent) {
    return source;
  }

  const { items, arrayStart, arrayEnd } = arrayContent;
  const nextItems = [...items, meta.sinkExpression];
  const nextArrayBody = nextItems.join(", ");
  return `${source.slice(0, arrayStart)}${nextArrayBody}${source.slice(arrayEnd)}`;
}

export async function updateLoggerWithSink(
  loggerPath: string,
  sinkId: string,
): Promise<boolean> {
  const meta = SINK_META[sinkId];
  if (!meta) {
    return false;
  }

  if (!(await pathExists(loggerPath))) {
    return false;
  }

  const source = await fs.readFile(loggerPath, "utf8");

  if (!hasInitAndSinks(source)) {
    return false;
  }

  if (sinkAlreadyInSinksArray(source, meta)) {
    return false;
  }

  const withImport = insertImport(source, meta);
  const updated = appendSinkToArray(withImport, meta);

  if (updated === source) {
    return false;
  }

  await fs.writeFile(loggerPath, updated, "utf8");
  return true;
}
