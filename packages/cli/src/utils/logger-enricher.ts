import fs from "node:fs/promises";
import { pathExists } from "./fs.js";

type EnricherMeta = {
  exportName: string;
  enricherExpression: string;
  importPath: string;
  /** Wire into init({ enrichers }) / composeSinks. false = import-only (factory helpers). */
  wireIntoInit: boolean;
};

const ENRICHER_META: Record<string, EnricherMeta> = {
  "service-metadata": {
    exportName: "serviceMetadata",
    enricherExpression: "serviceMetadata",
    importPath: "./enrichers/service-metadata",
    wireIntoInit: true,
  },
  "request-metadata": {
    exportName: "requestMetadata",
    enricherExpression: "requestMetadata",
    importPath: "./enrichers/request-metadata",
    wireIntoInit: false,
  },
};

const COMPOSE_SINKS_HELPER = `type Enricher = (record: LogRecord) => LogRecord;

function composeSinks(enrichers: Enricher[], sinks: Sink[]): Sink[] {
  if (enrichers.length === 0) {
    return sinks;
  }

  return sinks.map((sink) => (record) => sink(enrichers.reduce((acc, enrich) => enrich(acc), record)));
}
`;

function hasInitAndSinks(source: string): boolean {
  return source.includes("init(") && source.includes("sinks:");
}

function hasComposeSinksHelper(source: string): boolean {
  return /function\s+composeSinks\s*\(/.test(source);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasEnricherImport(source: string, meta: EnricherMeta): boolean {
  const importPattern = new RegExp(
    `import\\s*\\{[^}]*\\b${meta.exportName}\\b[^}]*\\}\\s*from\\s*["']${escapeRegExp(meta.importPath)}["']`,
  );
  return importPattern.test(source);
}

function normalizeAfterImportBlock(rest: string): string {
  const trimmed = rest.replace(/^\n+/, "");
  return trimmed.length > 0 ? `\n\n${trimmed}` : rest;
}

function insertImport(source: string, meta: EnricherMeta): string {
  if (hasEnricherImport(source, meta)) {
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

function insertComposeSinksHelper(source: string): string {
  if (hasComposeSinksHelper(source)) {
    return source;
  }

  const initMatch = source.match(/^init\s*\(/m);
  if (initMatch?.index !== undefined) {
    return `${source.slice(0, initMatch.index)}${COMPOSE_SINKS_HELPER}\n${source.slice(initMatch.index)}`;
  }

  return `${source}\n${COMPOSE_SINKS_HELPER}\n`;
}

function extractBalancedArray(
  source: string,
  openBracketIndex: number,
): { items: string[]; arrayEnd: number } | null {
  let depth = 1;
  let arrayEnd = openBracketIndex + 1;

  for (let i = openBracketIndex + 1; i < source.length; i++) {
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

  const rawItems = source.slice(openBracketIndex + 1, arrayEnd);
  const items = rawItems
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return { items, arrayEnd };
}

function enricherInArrayItems(items: string[], meta: EnricherMeta): boolean {
  return items.some(
    (item) =>
      item === meta.enricherExpression ||
      item === meta.exportName ||
      item.startsWith(`${meta.exportName}(`),
  );
}

function extractNamedArray(
  source: string,
  name: "enrichers" | "sinks",
): { items: string[]; keyStart: number; arrayStart: number; arrayEnd: number } | null {
  const match = source.match(new RegExp(`${name}:\\s*\\[`));
  if (!match || match.index === undefined) {
    return null;
  }

  const arrayStart = match.index + match[0].length - 1;
  const parsed = extractBalancedArray(source, arrayStart);
  if (!parsed) {
    return null;
  }

  return {
    items: parsed.items,
    keyStart: match.index,
    arrayStart: arrayStart + 1,
    arrayEnd: parsed.arrayEnd,
  };
}

function extractComposeSinksArrays(
  source: string,
): {
  enricherItems: string[];
  sinkItems: string[];
  matchStart: number;
  matchEnd: number;
} | null {
  const composeMatch = source.match(/sinks:\s*composeSinks\s*\(\s*\[/);
  if (!composeMatch || composeMatch.index === undefined) {
    return null;
  }

  const enricherArrayStart = composeMatch.index + composeMatch[0].length - 1;
  const enricherParsed = extractBalancedArray(source, enricherArrayStart);
  if (!enricherParsed) {
    return null;
  }

  const afterEnrichers = source.slice(enricherParsed.arrayEnd);
  const sinkMatch = afterEnrichers.match(/,\s*\[/);
  if (!sinkMatch || sinkMatch.index === undefined) {
    return null;
  }

  const sinkArrayStart = enricherParsed.arrayEnd + sinkMatch.index + sinkMatch[0].length - 1;
  const sinkParsed = extractBalancedArray(source, sinkArrayStart);
  if (!sinkParsed) {
    return null;
  }

  const closingParenIndex = source.indexOf(")", sinkParsed.arrayEnd);
  if (closingParenIndex === -1) {
    return null;
  }

  return {
    enricherItems: enricherParsed.items,
    sinkItems: sinkParsed.items,
    matchStart: composeMatch.index,
    matchEnd: closingParenIndex + 1,
  };
}

function enricherAlreadyWired(source: string, meta: EnricherMeta): boolean {
  if (!meta.wireIntoInit) {
    return hasEnricherImport(source, meta);
  }

  const enrichersArray = extractNamedArray(source, "enrichers");
  if (enrichersArray && enricherInArrayItems(enrichersArray.items, meta)) {
    return true;
  }

  const composeArrays = extractComposeSinksArrays(source);
  if (composeArrays) {
    return enricherInArrayItems(composeArrays.enricherItems, meta);
  }

  return false;
}

function wireIntoEnrichersArray(source: string, meta: EnricherMeta): string | null {
  const enrichersArray = extractNamedArray(source, "enrichers");
  if (!enrichersArray) {
    return null;
  }

  if (enricherInArrayItems(enrichersArray.items, meta)) {
    return source;
  }

  const nextItems = [...enrichersArray.items, meta.enricherExpression];
  const body = nextItems.join(", ");
  return `${source.slice(0, enrichersArray.arrayStart)}${body}${source.slice(enrichersArray.arrayEnd)}`;
}

function ensureEnrichersKey(source: string): string {
  if (extractNamedArray(source, "enrichers")) {
    return source;
  }

  // Insert enrichers: [] before sinks: in init config.
  const sinksMatch = source.match(/(\n)([ \t]*)sinks:\s*/);
  if (!sinksMatch || sinksMatch.index === undefined) {
    return source;
  }

  const indent = sinksMatch[2] ?? "  ";
  const insert = `${sinksMatch[1]}${indent}enrichers: [],`;
  return `${source.slice(0, sinksMatch.index)}${insert}${source.slice(sinksMatch.index)}`;
}

function wireEnricherIntoInit(source: string, meta: EnricherMeta): string {
  // Preferred: native init({ enrichers })
  let next = ensureEnrichersKey(source);
  const viaEnrichers = wireIntoEnrichersArray(next, meta);
  if (viaEnrichers !== null) {
    return viaEnrichers;
  }

  // Legacy fallback: composeSinks([...enrichers], [...sinks])
  const composeArrays = extractComposeSinksArrays(next);
  if (composeArrays) {
    if (enricherInArrayItems(composeArrays.enricherItems, meta)) {
      return next;
    }

    const nextEnrichers = [...composeArrays.enricherItems, meta.enricherExpression];
    const nextEnricherBody = nextEnrichers.join(", ");
    const nextSinkBody = composeArrays.sinkItems.join(", ");
    const replacement = `composeSinks([${nextEnricherBody}], [${nextSinkBody}])`;
    return `${next.slice(0, composeArrays.matchStart)}sinks: ${replacement}${next.slice(composeArrays.matchEnd)}`;
  }

  // Very old plain sinks without enrichers key insertion working — use composeSinks
  const plainSinks = extractNamedArray(next, "sinks");
  if (!plainSinks) {
    return next;
  }

  const withHelper = insertComposeSinksHelper(next);
  const plainMatch = withHelper.match(/sinks:\s*\[/);
  if (!plainMatch || plainMatch.index === undefined) {
    return withHelper;
  }

  const arrayStart = plainMatch.index + plainMatch[0].length - 1;
  const parsed = extractBalancedArray(withHelper, arrayStart);
  if (!parsed) {
    return withHelper;
  }

  const sinkBody = parsed.items.join(", ");
  const replacement = `composeSinks([${meta.enricherExpression}], [${sinkBody}])`;
  const sinksStart = plainMatch.index;
  const sinksEnd = parsed.arrayEnd + 1;

  return `${withHelper.slice(0, sinksStart)}sinks: ${replacement}${withHelper.slice(sinksEnd)}`;
}

export async function updateLoggerWithEnricher(
  loggerPath: string,
  enricherId: string,
): Promise<boolean> {
  const meta = ENRICHER_META[enricherId];
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

  if (enricherAlreadyWired(source, meta)) {
    return false;
  }

  const withImport = insertImport(source, meta);
  const updated = meta.wireIntoInit
    ? wireEnricherIntoInit(withImport, meta)
    : withImport;

  if (updated === source) {
    return false;
  }

  await fs.writeFile(loggerPath, updated, "utf8");
  return true;
}
