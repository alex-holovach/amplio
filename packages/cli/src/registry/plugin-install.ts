import fs from "node:fs/promises";
import path from "node:path";
import { validRange } from "semver";
import type { RegistryItem, RegistryPluginProvider } from "./types.js";
import {
  assertPluginStatePathsContained,
  planPluginState,
  pluginContractDigest,
  pluginDependencyDigest,
  pluginPrivacyDigest,
  type PluginInstallMetadata,
} from "./plugin-state.js";
import { assertDependencyCompatibility } from "../utils/dependency-compatibility.js";
import { detectFramework } from "../utils/detect-framework.js";
import { ensureDir, pathExists } from "../utils/fs.js";
import {
  isCanonicallyWithin,
  isPathWithin,
  isPortableAbsolute,
} from "../utils/path-containment.js";

interface PluginInstallOptions {
  cwd: string;
  telemetryDir: string;
  item: RegistryItem;
  eventId: string;
  pluginSource: string;
  recipePath?: string;
  dryRun?: boolean;
  allowMissingDependencies?: boolean;
  forceUntrackedSource?: boolean;
  target?: string;
}

interface BoundaryPluginWiringOptions {
  cwd: string;
  telemetryDir: string;
  item: RegistryItem;
  allowMissingDependencies?: boolean;
  allowPluginOverwrite?: boolean;
  /** Init validates its not-yet-written scaffold closure separately. */
  deferEventContractValidation?: boolean;
  target?: string;
}

export interface PluginInstallResult {
  pluginPath: string;
  eventPath: string;
  compositionPath: string;
  changed: boolean;
}

interface FileSnapshot {
  path: string;
  existed: boolean;
  content?: string;
}

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".next",
  "dist",
  "node_modules",
  "telemetry",
]);
const REGEX_PREFIX_KEYWORDS = new Set([
  "await",
  "case",
  "default",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function walkSourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (
        entry.isFile() &&
        SOURCE_EXTENSIONS.has(path.extname(entry.name))
      ) {
        files.push(absolute);
      }
    }
  };
  await visit(root);
  return files.sort();
}

async function selectedSourceFiles(
  cwd: string,
  target?: string,
): Promise<string[]> {
  if (target === undefined) return walkSourceFiles(cwd);
  const invalid = (): Error =>
    new Error(
      `Plugin target ${JSON.stringify(target)} must be a contained relative source file. No files were changed.`,
    );
  if (
    target.length === 0 ||
    target.includes("\\") ||
    isPortableAbsolute(target) ||
    path.posix.normalize(target) !== target ||
    target
      .split("/")
      .some(
        (segment) =>
          segment === "." ||
          segment === ".." ||
          SKIPPED_DIRECTORIES.has(segment),
      ) ||
    !SOURCE_EXTENSIONS.has(path.posix.extname(target))
  ) {
    throw invalid();
  }
  const root = path.resolve(cwd);
  const resolved = path.resolve(root, target);
  if (
    !isPathWithin(root, resolved) ||
    !(await isCanonicallyWithin(root, resolved))
  ) {
    throw invalid();
  }
  try {
    if (!(await fs.stat(resolved)).isFile()) throw invalid();
  } catch (error) {
    if (error instanceof Error && error.message.includes("Plugin target")) {
      throw error;
    }
    throw invalid();
  }
  return [resolved];
}

async function findEventFile(
  eventsDir: string,
  eventId: string,
): Promise<string> {
  if (!(await pathExists(eventsDir))) {
    throw new Error(
      `Event "${eventId}" is not installed under telemetry/events.`,
    );
  }
  const matches: string[] = [];
  for (const file of await walkSourceFiles(eventsDir)) {
    const source = await fs.readFile(file, "utf8");
    try {
      selectedEventTree(source, eventId);
      matches.push(file);
    } catch {
      // This file does not define the selected Event tree.
    }
  }
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one Event definition for "${eventId}"; found ${matches.length}.`,
    );
  }
  return matches[0]!;
}

function matchingBrace(mask: string, open: number): number | undefined {
  let depth = 0;
  for (let index = open; index < mask.length; index += 1) {
    if (mask[index] === "{") depth += 1;
    else if (mask[index] === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return undefined;
}

function objectPropertyValue(
  source: string,
  mask: string,
  objectOpen: number,
  objectClose: number,
  property: string,
): number | undefined {
  let braces = 1;
  let brackets = 0;
  let parentheses = 0;
  for (let index = objectOpen + 1; index < objectClose; index += 1) {
    const character = mask[index]!;
    if (character === "{") braces += 1;
    else if (character === "}") braces -= 1;
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets -= 1;
    else if (character === "(") parentheses += 1;
    else if (character === ")") parentheses -= 1;
    if (braces !== 1 || brackets !== 0 || parentheses !== 0) continue;
    if (!/[A-Za-z_$]/.test(character)) continue;
    const identifier = /^[A-Za-z_$][\w$]*/.exec(mask.slice(index))?.[0];
    if (!identifier) continue;
    const identifierEnd = index + identifier.length;
    let colon = identifierEnd;
    while (/\s/.test(mask[colon] ?? "")) colon += 1;
    if (identifier === property && mask[colon] === ":") {
      let value = colon + 1;
      while (/\s/.test(source[value] ?? "")) value += 1;
      return value;
    }
    index = identifierEnd - 1;
  }
  return undefined;
}

function selectedEventTree(
  source: string,
  eventId: string,
): {
  mask: string;
  callStart: number;
  treeOpen: number;
  treeClose: number;
} {
  const mask = codeMask(source);
  const matches: Array<{
    callStart: number;
    treeOpen: number;
    treeClose: number;
  }> = [];
  for (const call of importedEventCalls(source, mask)) {
    const objectOpen = call.objectOpen;
    const objectClose = matchingBrace(mask, objectOpen);
    if (objectClose === undefined) continue;
    const idValue = objectPropertyValue(
      source,
      mask,
      objectOpen,
      objectClose,
      "id",
    );
    if (idValue === undefined) continue;
    const literal = /^(?:"([^"]+)"|'([^']+)')/.exec(source.slice(idValue));
    if ((literal?.[1] ?? literal?.[2]) !== eventId) continue;
    const treeOpen = objectPropertyValue(
      source,
      mask,
      objectOpen,
      objectClose,
      "tree",
    );
    if (treeOpen === undefined || mask[treeOpen] !== "{") continue;
    const treeClose = matchingBrace(mask, treeOpen);
    if (treeClose !== undefined) {
      matches.push({ callStart: call.callStart, treeOpen, treeClose });
    }
  }
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one Event tree for "${eventId}"; found ${matches.length}. No files were changed.`,
    );
  }
  return { mask, ...matches[0]! };
}

export function eventDefinitionIds(source: string): string[] {
  const mask = codeMask(source);
  const ids: string[] = [];
  for (const call of importedEventCalls(source, mask)) {
    const objectOpen = call.objectOpen;
    const objectClose = matchingBrace(mask, objectOpen);
    if (objectClose === undefined) continue;
    const idValue = objectPropertyValue(
      source,
      mask,
      objectOpen,
      objectClose,
      "id",
    );
    if (idValue === undefined) continue;
    const literal = /^(?:"([^"]+)"|'([^']+)')/.exec(source.slice(idValue));
    const id = literal?.[1] ?? literal?.[2];
    if (id) ids.push(id);
  }
  return ids;
}

function importedEventCalls(
  source: string,
  mask: string,
): Array<{ callStart: number; objectOpen: number }> {
  const calls: Array<{ callStart: number; objectOpen: number }> = [];
  for (const binding of importedProviderBindings(
    source,
    "@useamplio/amplio",
    "event",
  )) {
    const pattern = new RegExp(
      `\\b${escapeRegExp(binding)}\\s*\\(\\s*\\{`,
      "g",
    );
    for (const match of mask.matchAll(pattern)) {
      const callStart = match.index!;
      let previous = callStart - 1;
      while (/\s/.test(mask[previous] ?? "")) previous -= 1;
      if (mask[previous] === ".") continue;
      const depth = delimiterDepth(mask, callStart);
      if (
        depth.braces !== 0 ||
        depth.brackets !== 0 ||
        depth.parentheses !== 0
      ) {
        continue;
      }
      const objectOpen = mask.indexOf("{", callStart);
      if (objectOpen >= 0) calls.push({ callStart, objectOpen });
    }
  }
  return calls;
}

export function hasEventTreePluginMount(options: {
  source: string;
  eventId: string;
  branch: string;
  pluginName: string;
}): boolean {
  let selected: ReturnType<typeof selectedEventTree>;
  try {
    selected = selectedEventTree(options.source, options.eventId);
  } catch {
    return false;
  }
  const value = objectPropertyValue(
    options.source,
    selected.mask,
    selected.treeOpen,
    selected.treeClose,
    options.branch,
  );
  return (
    value !== undefined &&
    new RegExp(`^${escapeRegExp(options.pluginName)}\\s*\\.\\s*events\\b`).test(
      selected.mask.slice(value, selected.treeClose),
    )
  );
}

function authenticatedLineMarkers(source: string, marker: string): number[] {
  const pattern = new RegExp(
    `^[ \\t]*(//[ \\t]*${escapeRegExp(marker)})[ \\t]*(?:\\r?\\n|$)`,
    "gm",
  );
  const offsets: number[] = [];
  for (const match of source.matchAll(pattern)) {
    const comment = match[1]!;
    const offset = match.index! + match[0].indexOf(comment);
    const sentinel = `A${"m".repeat(Math.max(0, comment.length - 1))}`;
    const candidate = `${source.slice(0, offset)}${sentinel}${source.slice(offset + comment.length)}`;
    if (
      codeMask(candidate).slice(offset, offset + comment.length) === sentinel
    ) {
      offsets.push(offset);
    }
  }
  return offsets;
}

function delimiterDepth(
  mask: string,
  end: number,
): {
  braces: number;
  brackets: number;
  parentheses: number;
} {
  let braces = 0;
  let brackets = 0;
  let parentheses = 0;
  for (let index = 0; index < end; index += 1) {
    if (mask[index] === "{") braces += 1;
    else if (mask[index] === "}") braces -= 1;
    else if (mask[index] === "[") brackets += 1;
    else if (mask[index] === "]") brackets -= 1;
    else if (mask[index] === "(") parentheses += 1;
    else if (mask[index] === ")") parentheses -= 1;
  }
  return { braces, brackets, parentheses };
}

function mountPlugin(
  source: string,
  eventId: string,
  pluginName: string,
  branch: string,
  importSpecifier: string,
): string {
  const importLine = `import { ${pluginName} } from "${importSpecifier}";`;
  const mountLine = `${branch}: ${pluginName}.events,`;
  const hasImport = hasGeneratedImport(source, importLine);
  const selected = selectedEventTree(source, eventId);
  const branchValue = objectPropertyValue(
    source,
    selected.mask,
    selected.treeOpen,
    selected.treeClose,
    branch,
  );
  const hasMount = hasEventTreePluginMount({
    source,
    eventId,
    branch,
    pluginName,
  });
  if (hasImport && hasMount) {
    return source;
  }
  if (branchValue !== undefined && !hasMount) {
    throw new Error(
      `Event tree branch "${branch}" is already used; no files were changed.`,
    );
  }
  const importMarkers = authenticatedLineMarkers(
    source,
    "amplio:plugin-imports",
  ).filter((offset) => {
    const depth = delimiterDepth(selected.mask, offset);
    return (
      depth.braces === 0 && depth.brackets === 0 && depth.parentheses === 0
    );
  });
  if (importMarkers.length !== 1) {
    throw new Error(
      `Selected Event requires exactly one authenticated top-level amplio:plugin-imports marker; found ${importMarkers.length}. No files were changed.`,
    );
  }
  const treeMarkers = authenticatedLineMarkers(source, "amplio:plugins").filter(
    (offset) => {
      if (offset <= selected.treeOpen || offset >= selected.treeClose)
        return false;
      const depth = delimiterDepth(
        selected.mask.slice(selected.treeOpen),
        offset - selected.treeOpen,
      );
      return (
        depth.braces === 1 && depth.brackets === 0 && depth.parentheses === 0
      );
    },
  );
  if (treeMarkers.length !== 1) {
    throw new Error(
      `Selected Event requires exactly one authenticated amplio:plugins marker inside its tree; found ${treeMarkers.length}. No files were changed.`,
    );
  }
  const importMarker = importMarkers[0]!;
  const treeMarker = treeMarkers[0]!;
  const withImport = `${source.slice(0, importMarker)}${hasImport ? "" : `${importLine}\n`}// amplio:plugin-imports${source.slice(importMarker + "// amplio:plugin-imports".length)}`;
  const adjustedTreeMarker = treeMarker + (withImport.length - source.length);
  const mounted = `${withImport.slice(0, adjustedTreeMarker)}${hasMount ? "" : `${mountLine}\n    `}// amplio:plugins${withImport.slice(adjustedTreeMarker + "// amplio:plugins".length)}`;
  if (
    !hasGeneratedImport(mounted, importLine) ||
    !hasEventTreePluginMount({
      source: mounted,
      eventId,
      branch,
      pluginName,
    })
  ) {
    throw new Error(
      "Plugin Event mount verification failed after transformation. No files were changed.",
    );
  }
  return mounted;
}

function addImport(source: string, importLine: string): string {
  if (hasGeneratedImport(source, importLine)) {
    return source;
  }
  const mask = codeMask(source);
  let insertionIndex = 0;
  for (const token of mask.matchAll(/\bimport\b/g)) {
    const start = token.index!;
    const tail = source.slice(start);
    const declaration =
      /^import\s+[^;]*?\s+from\s*(["'])[^"'\r\n]+\1\s*;?/.exec(tail) ??
      /^import\s*(["'])[^"'\r\n]+\1\s*;?/.exec(tail);
    if (!declaration) continue;
    let end = start + declaration[0].length;
    if (source[end] === "\r") end += 1;
    if (source[end] === "\n") end += 1;
    insertionIndex = Math.max(insertionIndex, end);
  }
  const prefix = source.slice(0, insertionIndex);
  const separator = prefix.length > 0 && !prefix.endsWith("\n") ? "\n" : "";
  return `${prefix}${separator}${importLine}\n${source.slice(insertionIndex)}`;
}

export function codeMask(source: string): string {
  const output = source.split("");
  let state:
    "code" | "single" | "double" | "template" | "line" | "block" | "regex" =
    "code";
  let canStartRegex = true;
  let regexCharacterClass = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    const next = source[index + 1];
    if (state === "code") {
      if (/\s/.test(character)) continue;
      if (character === "/" && next === "/") {
        output[index] = output[index + 1] = " ";
        index += 1;
        state = "line";
      } else if (character === "/" && next === "*") {
        output[index] = output[index + 1] = " ";
        index += 1;
        state = "block";
      } else if (character === "'") {
        output[index] = " ";
        state = "single";
      } else if (character === '"') {
        output[index] = " ";
        state = "double";
      } else if (character === "`") {
        output[index] = " ";
        state = "template";
      } else if (character === "/" && canStartRegex) {
        output[index] = " ";
        regexCharacterClass = false;
        state = "regex";
      } else if (/[A-Za-z_$]/.test(character)) {
        let end = index + 1;
        while (/[\w$]/.test(source[end] ?? "")) end += 1;
        let previous = index - 1;
        while (/\s/.test(output[previous] ?? "")) previous -= 1;
        const isProperty = output[previous] === ".";
        const token = source.slice(index, end);
        canStartRegex = !isProperty && REGEX_PREFIX_KEYWORDS.has(token);
        index = end - 1;
      } else if (/[0-9]/.test(character)) {
        let end = index + 1;
        while (/[\w.]/.test(source[end] ?? "")) end += 1;
        canStartRegex = false;
        index = end - 1;
      } else if (character === ")" || character === "]" || character === "}") {
        canStartRegex = false;
      } else if (character === ".") {
        canStartRegex = false;
      } else if (
        (character === "+" || character === "-") &&
        next === character
      ) {
        index += 1;
      } else if (character === "/") {
        canStartRegex = true;
      } else if (/[,;:?!~=&|+\-*%^<>{[(]/.test(character)) {
        canStartRegex = true;
      }
      continue;
    }

    if (character !== "\n" && character !== "\r") output[index] = " ";
    if (state === "line") {
      if (character === "\n") state = "code";
      continue;
    }
    if (state === "block") {
      if (character === "*" && next === "/") {
        output[index + 1] = " ";
        index += 1;
        state = "code";
      }
      continue;
    }
    if (state === "regex") {
      if (character === "\n" || character === "\r") {
        state = "code";
        canStartRegex = true;
      } else if (character === "\\") {
        if (next !== undefined) output[index + 1] = " ";
        index += 1;
      } else if (character === "[") {
        regexCharacterClass = true;
      } else if (character === "]") {
        regexCharacterClass = false;
      } else if (character === "/" && !regexCharacterClass) {
        let flag = index + 1;
        while (/[A-Za-z]/.test(source[flag] ?? "")) {
          output[flag] = " ";
          flag += 1;
        }
        index = flag - 1;
        state = "code";
        canStartRegex = false;
      }
      continue;
    }
    if (character === "\\") {
      if (next !== undefined) output[index + 1] = " ";
      index += 1;
      continue;
    }
    if (
      (state === "single" && character === "'") ||
      (state === "double" && character === '"') ||
      (state === "template" && character === "`")
    ) {
      state = "code";
      canStartRegex = false;
    }
  }
  return output.join("");
}

export function importedProviderBindings(
  source: string,
  providerPackage: string,
  importedName: string,
  allowDefault = false,
): string[] {
  const mask = codeMask(source);
  const bindings = new Set<string>();
  for (const token of mask.matchAll(/\bimport\b/g)) {
    const start = token.index!;
    const declaration = /^import\s+([^;]*?)\s+from\s*(["'])([^"'\r\n]+)\2/.exec(
      source.slice(start),
    );
    if (!declaration || declaration[3] !== providerPackage) continue;
    const clause = declaration[1]!.trim();
    if (clause.startsWith("type ")) continue;

    const named = /\{([\s\S]*?)\}/.exec(clause)?.[1];
    for (const rawEntry of named?.split(",") ?? []) {
      const entry = rawEntry.trim();
      if (!entry || entry.startsWith("type ")) continue;
      const parsed = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(
        entry,
      );
      if (parsed?.[1] === importedName) {
        bindings.add(parsed[2] ?? parsed[1]);
      }
    }

    if (allowDefault) {
      const namedStart = clause.indexOf("{");
      const beforeNamed = namedStart < 0 ? clause : clause.slice(0, namedStart);
      const defaultBinding = /^([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(
        beforeNamed.trim(),
      )?.[1];
      if (defaultBinding) bindings.add(defaultBinding);
    }
  }
  return [...bindings];
}

export function hasLiveNamedImport(
  source: string,
  moduleSpecifier: string,
  importedName: string,
): boolean {
  return importedProviderBindings(
    source,
    moduleSpecifier,
    importedName,
  ).includes(importedName);
}

function hasGeneratedImport(source: string, importLine: string): boolean {
  const parsed =
    /^import\s*\{\s*([A-Za-z_$][\w$]*)\s*\}\s*from\s*"([^"]+)";$/.exec(
      importLine,
    );
  return parsed
    ? hasLiveNamedImport(source, parsed[2]!, parsed[1]!)
    : codeMask(source).includes(importLine);
}

function findMatchingDelimiter(
  mask: string,
  openIndex: number,
  open: string,
  close: string,
): number {
  let depth = 0;
  for (let index = openIndex; index < mask.length; index += 1) {
    if (mask[index] === open) depth += 1;
    else if (mask[index] === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function skipWhitespace(source: string, start: number): number {
  let index = start;
  while (/\s/.test(source[index] ?? "")) index += 1;
  return index;
}

interface NativeCallRoot {
  path: string;
  source: string;
  objectOpen: number;
  objectClose: number;
}

async function findNativeCallRoot(
  cwd: string,
  factory: string,
  providerPackage: string,
  target?: string,
): Promise<NativeCallRoot> {
  const matches: NativeCallRoot[] = [];
  for (const file of await selectedSourceFiles(cwd, target)) {
    const source = await fs.readFile(file, "utf8");
    const mask = codeMask(source);
    const bindings = importedProviderBindings(source, providerPackage, factory);
    for (const binding of bindings) {
      const pattern = new RegExp(`\\b${escapeRegExp(binding)}\\s*\\(`, "g");
      for (const match of mask.matchAll(pattern)) {
        const openParen = mask.indexOf("(", match.index);
        const objectOpen = skipWhitespace(mask, openParen + 1);
        if (mask[objectOpen] !== "{") {
          throw new Error(
            `${factory}(...) must receive an inline object literal for safe Plugin wiring. No files were changed.`,
          );
        }
        const objectClose = findMatchingDelimiter(mask, objectOpen, "{", "}");
        if (objectClose < 0) {
          throw new Error(
            `Could not parse the ${factory}(...) composition root. No files were changed.`,
          );
        }
        matches.push({ path: file, source, objectOpen, objectClose });
      }
    }
  }
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one unambiguous ${factory}(...) composition root bound to a provider import from "${providerPackage}"; found ${matches.length}. No files were changed.`,
    );
  }
  return matches[0]!;
}

interface ObjectSegment {
  start: number;
  end: number;
}

function topLevelObjectSegments(
  mask: string,
  objectOpen: number,
  objectClose: number,
): ObjectSegment[] {
  const segments: ObjectSegment[] = [];
  let braces = 1;
  let brackets = 0;
  let parentheses = 0;
  let start = objectOpen + 1;
  for (let index = objectOpen + 1; index < objectClose; index += 1) {
    const character = mask[index]!;
    if (
      character === "," &&
      braces === 1 &&
      brackets === 0 &&
      parentheses === 0
    ) {
      segments.push({ start, end: index });
      start = index + 1;
    } else if (character === "{") braces += 1;
    else if (character === "}") braces -= 1;
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets -= 1;
    else if (character === "(") parentheses += 1;
    else if (character === ")") parentheses -= 1;
  }
  segments.push({ start, end: objectClose });
  return segments;
}

function ambiguousBetterAuthConfig(reason: string): never {
  throw new Error(
    `Ambiguous Better Auth config (${reason}); rerun with --source-only and compose BetterAuthPlugin() explicitly. No files were changed.`,
  );
}

function findBetterAuthPluginsProperty(
  source: string,
  mask: string,
  objectOpen: number,
  objectClose: number,
): { colon: number } | undefined {
  const explicit: Array<{ colon: number }> = [];
  for (const segment of topLevelObjectSegments(mask, objectOpen, objectClose)) {
    const masked = mask.slice(segment.start, segment.end).trim();
    if (!masked) continue;
    const original = source.slice(segment.start, segment.end).trim();
    if (masked.startsWith("...")) {
      ambiguousBetterAuthConfig("object spread may override plugins");
    }
    if (masked.startsWith("[")) {
      ambiguousBetterAuthConfig("computed property may override plugins");
    }
    if (/^["'`]plugins["'`]\s*:/.test(original)) {
      ambiguousBetterAuthConfig("quoted plugins property is unsupported");
    }
    const property = /^plugins\s*:/.exec(masked);
    if (property) {
      const propertyOffset = mask
        .slice(segment.start, segment.end)
        .indexOf("plugins");
      const colon = skipWhitespace(
        mask,
        segment.start + propertyOffset + "plugins".length,
      );
      explicit.push({ colon });
      continue;
    }
    if (/^(?:(?:get|set)\s+)?plugins\b/.test(masked)) {
      ambiguousBetterAuthConfig("shorthand or accessor plugins property");
    }
  }
  if (explicit.length > 1) {
    ambiguousBetterAuthConfig("duplicate plugins properties");
  }
  return explicit[0];
}

function topLevelArraySegments(
  mask: string,
  arrayOpen: number,
  arrayClose: number,
): ObjectSegment[] {
  const segments: ObjectSegment[] = [];
  let braces = 0;
  let brackets = 1;
  let parentheses = 0;
  let start = arrayOpen + 1;
  for (let index = arrayOpen + 1; index < arrayClose; index += 1) {
    const character = mask[index]!;
    if (
      character === "," &&
      braces === 0 &&
      brackets === 1 &&
      parentheses === 0
    ) {
      segments.push({ start, end: index });
      start = index + 1;
    } else if (character === "{") braces += 1;
    else if (character === "}") braces -= 1;
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets -= 1;
    else if (character === "(") parentheses += 1;
    else if (character === ")") parentheses -= 1;
  }
  segments.push({ start, end: arrayClose });
  return segments;
}

/**
 * Verifies the exact native seam shape emitted by the contributor installer.
 * Both provider and Plugin identifiers must be bound to live imports.
 */
export function hasActiveContributorProviderWiring(options: {
  source: string;
  provider: RegistryPluginProvider;
  pluginModuleSpecifiers: string[];
}): boolean {
  const { source, provider, pluginModuleSpecifiers } = options;
  const mask = codeMask(source);
  const pluginBindings = [
    ...new Set(
      pluginModuleSpecifiers.flatMap((specifier) =>
        importedProviderBindings(source, specifier, provider.instrumenter),
      ),
    ),
  ];
  if (pluginBindings.length === 0) return false;

  if (provider.seam === undefined || provider.seam === "constructor") {
    const constructorBindings = importedProviderBindings(
      source,
      provider.package,
      provider.constructor,
    );
    const constructions: Array<{ index: number }> = [];
    for (const binding of constructorBindings) {
      const pattern = new RegExp(
        `\\bnew\\s+${escapeRegExp(binding)}(?:\\s*<[^;\\n]+>)?\\s*\\(`,
        "g",
      );
      for (const match of mask.matchAll(pattern)) {
        constructions.push({ index: match.index! });
      }
    }
    if (constructions.length !== 1) return false;
    const prefix = mask.slice(0, constructions[0]!.index);
    return pluginBindings.some((binding) =>
      new RegExp(`\\b${escapeRegExp(binding)}\\s*\\(\\s*$`).test(prefix),
    );
  }

  if (provider.seam === "better-auth-plugin") {
    const factoryBindings = importedProviderBindings(
      source,
      provider.package,
      provider.factory,
    );
    const roots: Array<{ objectOpen: number; objectClose: number }> = [];
    let factoryCalls = 0;
    for (const binding of factoryBindings) {
      const pattern = new RegExp(`\\b${escapeRegExp(binding)}\\s*\\(`, "g");
      for (const match of mask.matchAll(pattern)) {
        factoryCalls += 1;
        const openParen = mask.indexOf("(", match.index);
        const objectOpen = skipWhitespace(mask, openParen + 1);
        if (mask[objectOpen] !== "{") continue;
        const objectClose = findMatchingDelimiter(mask, objectOpen, "{", "}");
        if (objectClose >= 0) roots.push({ objectOpen, objectClose });
      }
    }
    if (factoryCalls !== 1 || roots.length !== 1) return false;
    const root = roots[0]!;
    try {
      const property = findBetterAuthPluginsProperty(
        source,
        mask,
        root.objectOpen,
        root.objectClose,
      );
      if (!property) return false;
      const arrayOpen = skipWhitespace(mask, property.colon + 1);
      if (mask[arrayOpen] !== "[") return false;
      const arrayClose = findMatchingDelimiter(mask, arrayOpen, "[", "]");
      if (arrayClose < 0 || arrayClose > root.objectClose) return false;
      return topLevelArraySegments(mask, arrayOpen, arrayClose).some(
        (segment) => {
          const entry = mask.slice(segment.start, segment.end).trim();
          return pluginBindings.some((binding) =>
            new RegExp(`^${escapeRegExp(binding)}\\s*\\(\\s*\\)$`).test(entry),
          );
        },
      );
    } catch {
      return false;
    }
  }

  if (provider.seam === "telemetry-registration") {
    const registrarBindings = importedProviderBindings(
      source,
      provider.package,
      provider.registrar,
    );
    let registrations = 0;
    for (const registrar of registrarBindings) {
      for (const pluginBinding of pluginBindings) {
        const pattern = new RegExp(
          `\\b${escapeRegExp(registrar)}\\s*\\(\\s*${escapeRegExp(pluginBinding)}\\s*\\(\\s*\\)\\s*\\)`,
          "g",
        );
        for (const match of mask.matchAll(pattern)) {
          const depth = delimiterDepth(mask, match.index!);
          if (
            depth.braces === 0 &&
            depth.brackets === 0 &&
            depth.parentheses === 0
          ) {
            registrations += 1;
          }
        }
      }
    }
    return registrations === 1;
  }

  if (provider.seam !== "trpc-middleware") return false;
  const initializerBindings = importedProviderBindings(
    source,
    provider.package,
    provider.initializer,
  );
  const roots: string[] = [];
  for (const binding of initializerBindings) {
    const pattern = new RegExp(
      `\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${escapeRegExp(binding)}\\b[^;]*?\\.create\\s*\\([^;]*?\\)\\s*;`,
      "g",
    );
    for (const match of mask.matchAll(pattern)) roots.push(match[1]!);
  }
  if (roots.length !== 1) return false;
  const root = roots[0]!;
  const middlewareBindings: string[] = [];
  for (const pluginBinding of pluginBindings) {
    const pattern = new RegExp(
      `\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${escapeRegExp(root)}\\.middleware\\s*\\(\\s*${escapeRegExp(pluginBinding)}\\s*\\(\\s*\\)\\s*\\)\\s*;`,
      "g",
    );
    for (const match of mask.matchAll(pattern)) {
      middlewareBindings.push(match[1]!);
    }
  }
  if (middlewareBindings.length !== 1) return false;
  const procedurePattern = new RegExp(
    `\\b${escapeRegExp(root)}\\.procedure\\b`,
    "g",
  );
  const procedures = [...mask.matchAll(procedurePattern)];
  if (procedures.length === 0) return false;
  const middleware = middlewareBindings[0]!;
  return procedures.every((match) =>
    new RegExp(`^\\s*\\.use\\s*\\(\\s*${escapeRegExp(middleware)}\\s*\\)`).test(
      mask.slice(match.index! + match[0].length),
    ),
  );
}

function lineIndent(source: string, index: number): string {
  const lineStart = source.lastIndexOf("\n", index - 1) + 1;
  return /^\s*/.exec(source.slice(lineStart, index))?.[0] ?? "";
}

function propertyIndent(
  source: string,
  objectOpen: number,
  objectClose: number,
): string {
  const firstContent = skipWhitespace(source, objectOpen + 1);
  if (
    firstContent < objectClose &&
    source.slice(objectOpen, firstContent).includes("\n")
  ) {
    return lineIndent(source, firstContent);
  }
  return `${lineIndent(source, objectOpen)}  `;
}

function wireBetterAuthPlugin(
  root: NativeCallRoot,
  instrumenter: string,
  importSpecifier: string,
): string {
  const { source, objectOpen, objectClose } = root;
  const mask = codeMask(source);
  const property = findBetterAuthPluginsProperty(
    source,
    mask,
    objectOpen,
    objectClose,
  );
  const importLine = `import { ${instrumenter} } from "${importSpecifier}";`;
  if (!property) {
    const indent = propertyIndent(source, objectOpen, objectClose);
    const insertion = `\n${indent}plugins: [${instrumenter}()],`;
    return addImport(
      `${source.slice(0, objectOpen + 1)}${insertion}${source.slice(objectOpen + 1)}`,
      importLine,
    );
  }

  const arrayOpen = skipWhitespace(mask, property.colon + 1);
  if (mask[arrayOpen] !== "[") {
    throw new Error(
      "Better Auth plugins must be an inline array for safe Plugin wiring. No files were changed.",
    );
  }
  const arrayClose = findMatchingDelimiter(mask, arrayOpen, "[", "]");
  if (arrayClose < 0 || arrayClose > objectClose) {
    throw new Error(
      "Could not parse the Better Auth plugins array. No files were changed.",
    );
  }
  const contents = source.slice(arrayOpen + 1, arrayClose);
  if (
    new RegExp(`\\b${escapeRegExp(instrumenter)}\\s*\\(`).test(
      codeMask(contents),
    )
  ) {
    return addImport(source, importLine);
  }
  const nextContents = contents.trim()
    ? `${contents.replace(/\s*$/, "")}, ${instrumenter}()${contents.match(/\s*$/)?.[0] ?? ""}`
    : `${instrumenter}()`;
  return addImport(
    `${source.slice(0, arrayOpen + 1)}${nextContents}${source.slice(arrayClose)}`,
    importLine,
  );
}

interface TrpcCompositionRoot {
  path: string;
  source: string;
  variable: string;
  assignmentEnd: number;
}

async function findTrpcCompositionRoot(
  cwd: string,
  initializer: string,
  providerPackage: string,
  target?: string,
): Promise<TrpcCompositionRoot> {
  const matches: TrpcCompositionRoot[] = [];
  for (const file of await selectedSourceFiles(cwd, target)) {
    const source = await fs.readFile(file, "utf8");
    const mask = codeMask(source);
    const bindings = importedProviderBindings(
      source,
      providerPackage,
      initializer,
    );
    for (const binding of bindings) {
      const pattern = new RegExp(
        `\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${escapeRegExp(binding)}\\b[^;]*?\\.create\\s*\\([^;]*?\\)\\s*;`,
        "g",
      );
      for (const match of mask.matchAll(pattern)) {
        matches.push({
          path: file,
          source,
          variable: match[1]!,
          assignmentEnd: match.index + match[0].length,
        });
      }
    }
  }
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one unambiguous ${initializer}.create() composition root bound to a provider import from "${providerPackage}"; found ${matches.length}. No files were changed.`,
    );
  }
  const root = matches[0]!;
  const procedurePattern = new RegExp(
    `\\b${escapeRegExp(root.variable)}\\.procedure\\b`,
  );
  const procedureFiles: string[] = [];
  for (const file of await walkSourceFiles(cwd)) {
    const source = await fs.readFile(file, "utf8");
    if (procedurePattern.test(codeMask(source))) procedureFiles.push(file);
  }
  if (procedureFiles.length > 1) {
    throw new Error(
      `The tRPC direct procedure bases span ${procedureFiles.length} files, so activation is ambiguous. Rerun with --source-only and compose explicitly. No files were changed.`,
    );
  }
  return root;
}

function wireTrpcMiddleware(
  root: TrpcCompositionRoot,
  instrumenter: string,
  importSpecifier: string,
): string {
  const { source, variable, assignmentEnd } = root;
  const mask = codeMask(source);
  const declaration = `const amplioMiddleware = ${variable}.middleware(${instrumenter}());`;
  const generatedDeclaration = new RegExp(
    `\\bconst\\s+amplioMiddleware\\s*=\\s*${escapeRegExp(variable)}\\.middleware\\s*\\(\\s*${escapeRegExp(instrumenter)}\\s*\\(\\s*\\)\\s*\\)\\s*;`,
  );
  const alreadyDeclared = generatedDeclaration.test(mask);
  if (/\bamplioMiddleware\b/.test(mask) && !alreadyDeclared) {
    throw new Error(
      'The identifier "amplioMiddleware" is already used in the tRPC composition root. No files were changed.',
    );
  }

  const procedurePattern = new RegExp(
    `\\b${escapeRegExp(variable)}\\.procedure\\b`,
    "g",
  );
  const procedures = [...mask.matchAll(procedurePattern)];
  if (procedures.length === 0) {
    throw new Error(
      `The tRPC (${variable}) composition root has no direct ${variable}.procedure bases to instrument. No files were changed.`,
    );
  }

  let nextSource = source;
  for (const match of [...procedures].reverse()) {
    const end = match.index + match[0].length;
    const suffix = mask.slice(end);
    if (/^\s*\.use\s*\(\s*amplioMiddleware\s*\)/.test(suffix)) continue;
    nextSource = `${nextSource.slice(0, end)}.use(amplioMiddleware)${nextSource.slice(end)}`;
  }
  if (!alreadyDeclared) {
    nextSource = `${nextSource.slice(0, assignmentEnd)}\n${declaration}${nextSource.slice(assignmentEnd)}`;
  }
  return addImport(
    nextSource,
    `import { ${instrumenter} } from "${importSpecifier}";`,
  );
}

interface AssignedCompositionRoot {
  path: string;
  source: string;
  variable: string;
  assignmentEnd: number;
}

async function findAssignedCompositionRoot(
  cwd: string,
  label: string,
  providerPackage: string,
  importedName: string,
  allowDefault: boolean,
  patternForBinding: (binding: string) => RegExp,
  target?: string,
): Promise<AssignedCompositionRoot> {
  const matches: AssignedCompositionRoot[] = [];
  for (const file of await selectedSourceFiles(cwd, target)) {
    const source = await fs.readFile(file, "utf8");
    const mask = codeMask(source);
    const bindings = importedProviderBindings(
      source,
      providerPackage,
      importedName,
      allowDefault,
    );
    for (const binding of bindings) {
      for (const match of mask.matchAll(patternForBinding(binding))) {
        matches.push({
          path: file,
          source,
          variable: match[1]!,
          assignmentEnd: match.index + match[0].length,
        });
      }
    }
  }
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one unambiguous ${label} application boundary bound to a provider import from "${providerPackage}"; found ${matches.length}. Rerun with --source-only to copy inert source. No files were changed.`,
    );
  }
  return matches[0]!;
}

function wireBoundaryRegistration(
  root: AssignedCompositionRoot,
  exportName: string,
  importSpecifier: string,
  registration: (variable: string) => string,
  isRegistered: (mask: string, variable: string) => boolean,
): string {
  const statement = registration(root.variable);
  const importLine = `import { ${exportName} } from "${importSpecifier}";`;
  if (isRegistered(codeMask(root.source), root.variable)) {
    return addImport(root.source, importLine);
  }
  return addImport(
    `${root.source.slice(0, root.assignmentEnd)}\n${statement}${root.source.slice(root.assignmentEnd)}`,
    importLine,
  );
}

function localPluginModuleSpecifiers(
  compositionPath: string,
  pluginPath: string,
): string[] {
  let relative = path
    .relative(path.dirname(compositionPath), pluginPath)
    .replace(/\\/g, "/")
    .replace(/\.[cm]?[jt]sx?$/, "");
  if (!relative.startsWith(".")) relative = `./${relative}`;
  return [relative, `${relative}.js`];
}

function stableRouteLiteral(
  source: string,
  openParen: number,
): string | undefined {
  const value = skipWhitespace(source, openParen + 1);
  const literal = /^(?:"([^"\r\n]+)"|'([^'\r\n]+)')/.exec(source.slice(value));
  const route = literal?.[1] ?? literal?.[2];
  return route?.startsWith("/") && !/[?#]/.test(route) ? route : undefined;
}

function topLevelCallSegments(
  mask: string,
  openParen: number,
  closeParen: number,
): ObjectSegment[] {
  const segments: ObjectSegment[] = [];
  let parentheses = 1;
  let braces = 0;
  let brackets = 0;
  let start = openParen + 1;
  for (let index = start; index < closeParen; index += 1) {
    const character = mask[index]!;
    if (
      character === "," &&
      parentheses === 1 &&
      braces === 0 &&
      brackets === 0
    ) {
      segments.push({ start, end: index });
      start = index + 1;
    } else if (character === "(") parentheses += 1;
    else if (character === ")") parentheses -= 1;
    else if (character === "{") braces += 1;
    else if (character === "}") braces -= 1;
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets -= 1;
  }
  segments.push({ start, end: closeParen });
  return segments;
}

function expressApplicationBindings(source: string, mask: string): string[] {
  const roots = new Set<string>();
  const defaultBindings = importedProviderBindings(
    source,
    "express",
    "express",
    true,
  );
  const routerBindings = importedProviderBindings(source, "express", "Router");
  for (const binding of defaultBindings) {
    const pattern = new RegExp(
      "\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*" +
        escapeRegExp(binding) +
        "(?:\\s*\\.\\s*Router)?\\s*\\(",
      "g",
    );
    for (const match of mask.matchAll(pattern)) roots.add(match[1]!);
  }
  for (const binding of routerBindings) {
    const pattern = new RegExp(
      "\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*" +
        escapeRegExp(binding) +
        "\\s*\\(",
      "g",
    );
    for (const match of mask.matchAll(pattern)) roots.add(match[1]!);
  }
  return [...roots];
}

function hasExpressRouteActivation(options: {
  source: string;
  pluginBindings: string[];
}): boolean {
  const mask = codeMask(options.source);
  for (const root of expressApplicationBindings(options.source, mask)) {
    const routePattern = new RegExp(
      "\\b" +
        escapeRegExp(root) +
        "\\s*\\.\\s*(?:all|delete|get|head|options|patch|post|put)\\s*\\(",
      "g",
    );
    for (const match of mask.matchAll(routePattern)) {
      const openParen = mask.indexOf("(", match.index);
      const closeParen = findMatchingDelimiter(mask, openParen, "(", ")");
      if (openParen < 0 || closeParen < 0) continue;
      const route = stableRouteLiteral(options.source, openParen);
      if (!route) continue;
      const segments = topLevelCallSegments(mask, openParen, closeParen);
      for (const segment of segments.slice(1)) {
        const segmentMask = mask.slice(segment.start, segment.end).trim();
        for (const binding of options.pluginBindings) {
          const spread = new RegExp(
            "^\\.\\.\\.\\s*" + escapeRegExp(binding) + "\\s*\\(",
          ).exec(segmentMask);
          if (!spread) continue;
          const bindingOffset = mask
            .slice(segment.start, segment.end)
            .indexOf(binding);
          const wrapperOpen = mask.indexOf(
            "(",
            segment.start + bindingOffset + binding.length,
          );
          if (stableRouteLiteral(options.source, wrapperOpen) === route) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

export function hasAdoptedBoundaryActivation(options: {
  plugin: string;
  source: string;
  compositionPath: string;
  pluginPath: string;
  exportName: string;
}): boolean {
  const mask = codeMask(options.source);
  const bindings = localPluginModuleSpecifiers(
    options.compositionPath,
    options.pluginPath,
  ).flatMap((specifier) =>
    importedProviderBindings(options.source, specifier, options.exportName),
  );
  if (options.plugin === "express") {
    return hasExpressRouteActivation({
      source: options.source,
      pluginBindings: bindings,
    });
  }
  if (options.plugin !== "next") return false;
  for (const binding of bindings) {
    const pattern = new RegExp(
      "\\bexport\\s+const\\s+(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\\s*=\\s*" +
        escapeRegExp(binding) +
        "\\s*\\(",
      "g",
    );
    for (const match of mask.matchAll(pattern)) {
      const openParen = mask.indexOf("(", match.index);
      const closeParen = findMatchingDelimiter(mask, openParen, "(", ")");
      const segments =
        openParen >= 0 && closeParen >= 0
          ? topLevelCallSegments(mask, openParen, closeParen)
          : [];
      if (
        stableRouteLiteral(options.source, openParen) &&
        segments.length === 2 &&
        mask.slice(segments[1]!.start, segments[1]!.end).trim().length > 0
      ) {
        return true;
      }
    }
  }
  return false;
}

export async function planBoundaryPluginWiring(
  options: BoundaryPluginWiringOptions,
): Promise<{
  compositionPath: string;
  compositionSource: string;
  ownership?: "managed" | "adopted";
  anchor?: string;
}> {
  const { cwd, telemetryDir, item } = options;
  const slug = item.name.replace(/^plugin-/, "");
  const exportName = item.wiringActions?.find(
    (action) =>
      action.type === "register-boundary" || action.type === "wrap-boundary",
  )?.export;
  if (!exportName) {
    throw new Error(
      `Boundary Plugin "${slug}" has no deterministic registration export. Rerun with --source-only. No files were changed.`,
    );
  }
  const providerPackage = Object.keys(item.providerRanges ?? {})[0];
  if (!providerPackage) {
    throw new Error(
      `Boundary Plugin "${slug}" has no provider compatibility metadata. No files were changed.`,
    );
  }
  const packageJson = JSON.parse(
    await fs.readFile(path.join(cwd, "package.json"), "utf8"),
  ) as Record<string, unknown>;
  await assertProviderCompatibility(
    cwd,
    packageJson,
    item,
    providerPackage,
    options.allowMissingDependencies,
  );
  if (!options.deferEventContractValidation) {
    await assertBoundaryEventContract(cwd, telemetryDir, item);
  }

  const pluginPath = path.join(cwd, telemetryDir, "plugins", `${slug}.ts`);
  if ((await pathExists(pluginPath)) && !options.allowPluginOverwrite) {
    const existingPlugin = await fs.readFile(pluginPath, "utf8");
    const exportPattern = new RegExp(
      `\\bexport\\s+(?:(?:async\\s+)?function|const|let|var)\\s+${escapeRegExp(exportName)}\\b`,
    );
    if (!exportPattern.test(codeMask(existingPlugin))) {
      throw new Error(
        `${path.relative(cwd, pluginPath)} exists but does not export ${exportName}; no files were changed.`,
      );
    }
  }
  const extensionlessImports = (await detectFramework(cwd)) === "next";
  if (slug === "next") {
    if (!options.target) {
      throw new Error(
        'Boundary Plugin "next" requires --target <relative-source-file> after attaching withAmplio() to the intended route export. No files were changed.',
      );
    }
    const compositionPath = (
      await selectedSourceFiles(cwd, options.target)
    )[0]!;
    const compositionSource = await fs.readFile(compositionPath, "utf8");
    if (
      !hasAdoptedBoundaryActivation({
        plugin: slug,
        source: compositionSource,
        compositionPath,
        pluginPath,
        exportName,
      })
    ) {
      throw new Error(
        `The selected Next source ${path.relative(cwd, compositionPath)} does not export an HTTP handler through ${exportName}("/stable/route", handler) imported from the tracked Plugin. No files were changed.`,
      );
    }
    return {
      compositionPath,
      compositionSource,
      ownership: "adopted",
      anchor: exportName,
    };
  }
  if (slug === "express") {
    if (!options.target) {
      throw new Error(
        'Boundary Plugin "express" requires --target <relative-source-file> after spreading withAmplioRoute() into the intended Express route. No files were changed.',
      );
    }
    const compositionPath = (
      await selectedSourceFiles(cwd, options.target)
    )[0]!;
    const compositionSource = await fs.readFile(compositionPath, "utf8");
    if (
      !hasAdoptedBoundaryActivation({
        plugin: slug,
        source: compositionSource,
        compositionPath,
        pluginPath,
        exportName,
      })
    ) {
      throw new Error(
        `The selected Express source ${path.relative(cwd, compositionPath)} does not spread ${exportName}("/stable/route", ...handlers) into a matching authenticated Express route. No files were changed.`,
      );
    }
    return {
      compositionPath,
      compositionSource,
      ownership: "adopted",
      anchor: exportName,
    };
  }
  if (slug === "hono") {
    const root = await findAssignedCompositionRoot(
      cwd,
      "new Hono(...)",
      providerPackage,
      "Hono",
      false,
      (binding) =>
        new RegExp(
          `\\b(?:export\\s+)?(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*new\\s+${escapeRegExp(binding)}(?:\\s*<[^;]+>)?\\s*\\([^;]*?\\)\\s*;`,
          "g",
        ),
      options.target,
    );
    return {
      compositionPath: root.path,
      compositionSource: wireBoundaryRegistration(
        root,
        exportName,
        relativeImport(root.path, pluginPath, extensionlessImports),
        (variable) => `${variable}.use("*", ${exportName}());`,
        (mask, variable) =>
          new RegExp(
            `\\b${escapeRegExp(variable)}\\.use\\s*\\(\\s*,\\s*${escapeRegExp(exportName)}\\s*\\(\\s*\\)\\s*\\)`,
          ).test(mask),
      ),
    };
  }
  if (slug === "fastify") {
    const root = await findAssignedCompositionRoot(
      cwd,
      "Fastify(...)",
      providerPackage,
      "fastify",
      true,
      (binding) =>
        new RegExp(
          `\\b(?:export\\s+)?(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${escapeRegExp(binding)}\\s*\\([^;]*?\\)\\s*;`,
          "g",
        ),
      options.target,
    );
    return {
      compositionPath: root.path,
      compositionSource: wireBoundaryRegistration(
        root,
        exportName,
        relativeImport(root.path, pluginPath, extensionlessImports),
        (variable) => `${variable}.register(${exportName});`,
        (mask, variable) =>
          new RegExp(
            `\\b${escapeRegExp(variable)}\\.register\\s*\\(\\s*${escapeRegExp(exportName)}\\s*\\)`,
          ).test(mask),
      ),
    };
  }
  throw new Error(
    `Boundary Plugin "${slug}" requires application-specific wiring. Rerun with --source-only, then attach ${exportName} at the intended native boundary. No files were changed.`,
  );
}

async function assertBoundaryEventContract(
  cwd: string,
  telemetryDir: string,
  item: RegistryItem,
): Promise<void> {
  if (!item.events?.some((event) => event.id === "http.request")) return;
  const eventPath = await findEventFile(
    path.join(cwd, telemetryDir, "events"),
    "http.request",
  );
  const source = await fs.readFile(eventPath, "utf8");
  if (!hasHttpRequestBoundaryContract(source)) {
    throw new Error(
      `The selected Event module ${path.relative(cwd, eventPath)} must export HttpRequest and resolveRequestId for boundary Plugin activation. Restore the generated contract or reinstall the root Event. No files were changed.`,
    );
  }
}

export function hasHttpRequestBoundaryContract(source: string): boolean {
  let selected: ReturnType<typeof selectedEventTree>;
  try {
    selected = selectedEventTree(source, "http.request");
  } catch {
    return false;
  }
  const beforeCall = selected.mask.slice(0, selected.callStart);
  const exportsSelectedHttpRequest =
    /\bexport\s+const\s+HttpRequest\s*=\s*$/.test(beforeCall);
  const exportsRequestIdResolver =
    /\bexport\s+function\s+resolveRequestId\s*\(/.test(selected.mask) ||
    /\bexport\s+const\s+resolveRequestId(?:\s*:[^=;\n]+)?\s*=\s*(?:(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>|function(?:\s+[A-Za-z_$][\w$]*)?\s*\()/.test(
      selected.mask,
    );
  return exportsSelectedHttpRequest && exportsRequestIdResolver;
}

function wrapProviderConstruction(
  source: string,
  constructorBinding: string,
  constructorName: string,
  instrumenter: string,
  importSpecifier: string,
): string {
  const mask = codeMask(source);
  const constructionPattern = new RegExp(
    `\\bnew\\s+${escapeRegExp(constructorBinding)}\\s*\\([^()\\n]*\\)`,
    "g",
  );
  const matches = [...mask.matchAll(constructionPattern)];
  if (matches.length === 0) {
    throw new Error(
      `Could not safely wrap the ${constructorName} construction root. Rerun with --source-only and compose ${instrumenter}(...) explicitly. No files were changed.`,
    );
  }
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one unambiguous ${constructorName} construction root; found ${matches.length}. No files were changed.`,
    );
  }
  const match = matches[0]!;
  const start = match.index!;
  const before = mask.slice(0, start);
  const alreadyWrapped = new RegExp(
    `${escapeRegExp(instrumenter)}\\s*\\(\\s*$`,
  ).test(before);
  const importLine = `import { ${instrumenter} } from "${importSpecifier}";`;
  if (alreadyWrapped) {
    return addImport(source, importLine);
  }
  const construction = source.slice(start, start + match[0].length);
  const wrapped = `${instrumenter}(${construction})`;
  return addImport(
    `${source.slice(0, start)}${wrapped}${source.slice(start + construction.length)}`,
    importLine,
  );
}

async function findCompositionRoot(
  cwd: string,
  constructorName: string,
  providerPackage: string,
  target?: string,
): Promise<{ path: string; source: string; binding: string }> {
  const matches: Array<{ path: string; source: string; binding: string }> = [];
  for (const file of await selectedSourceFiles(cwd, target)) {
    const source = await fs.readFile(file, "utf8");
    const mask = codeMask(source);
    const bindings = importedProviderBindings(
      source,
      providerPackage,
      constructorName,
    );
    for (const binding of bindings) {
      const constructorPattern = new RegExp(
        `\\bnew\\s+${escapeRegExp(binding)}\\s*\\(`,
        "g",
      );
      for (const _match of mask.matchAll(constructorPattern)) {
        matches.push({ path: file, source, binding });
      }
    }
  }
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one unambiguous ${constructorName} composition root bound to a provider import from "${providerPackage}"; found ${matches.length}. No files were changed.`,
    );
  }
  return matches[0]!;
}

function relativeImport(
  fromFile: string,
  toFile: string,
  extensionless = false,
): string {
  const relative = path
    .relative(path.dirname(fromFile), toFile)
    .replace(/\\/g, "/")
    .replace(/\.ts$/, extensionless ? "" : ".js");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

async function snapshot(filePath: string): Promise<FileSnapshot> {
  const existed = await pathExists(filePath);
  return {
    path: filePath,
    existed,
    ...(existed ? { content: await fs.readFile(filePath, "utf8") } : {}),
  };
}

async function restore(snapshots: FileSnapshot[]): Promise<void> {
  for (const entry of [...snapshots].reverse()) {
    if (entry.existed) {
      await fs.writeFile(entry.path, entry.content!, "utf8");
    } else {
      await fs.rm(entry.path, { force: true });
    }
  }
}

async function assertProviderCompatibility(
  cwd: string,
  packageJson: Record<string, unknown>,
  item: RegistryItem,
  providerPackage: string,
  allowMissing = false,
): Promise<void> {
  const coreRange = item.coreRange;
  if (!coreRange || validRange(coreRange) === null) {
    throw new Error(
      `Plugin "${item.name.replace(/^plugin-/, "")}" has invalid core compatibility metadata. No files were changed.`,
    );
  }
  await assertDependencyCompatibility({
    cwd,
    packageJson,
    dependencyName: "@useamplio/amplio",
    supportedRange: coreRange,
    label: "Core",
    allowMissing,
  });

  const supportedRange = item.providerRanges?.[providerPackage];
  if (!supportedRange || validRange(supportedRange) === null) {
    throw new Error(
      `Plugin "${item.name.replace(/^plugin-/, "")}" has invalid provider compatibility metadata for "${providerPackage}". No files were changed.`,
    );
  }
  await assertDependencyCompatibility({
    cwd,
    packageJson,
    dependencyName: providerPackage,
    supportedRange,
    label: "Provider",
    allowMissing,
  });
}

export async function assertPluginCompatibility(options: {
  cwd: string;
  item: RegistryItem;
  allowMissing?: boolean;
}): Promise<void> {
  const providerPackages = Object.keys(options.item.providerRanges ?? {});
  const providerPackage =
    options.item.provider?.package ??
    (providerPackages.length === 1 ? providerPackages[0] : undefined);
  if (!providerPackage) {
    throw new Error(
      `Plugin "${options.item.name.replace(/^plugin-/, "")}" has no unambiguous provider compatibility metadata. No files were changed.`,
    );
  }
  const packageJson = JSON.parse(
    await fs.readFile(path.join(options.cwd, "package.json"), "utf8"),
  ) as Record<string, unknown>;
  await assertProviderCompatibility(
    options.cwd,
    packageJson,
    options.item,
    providerPackage,
    options.allowMissing,
  );
}

async function planProviderWiring(
  cwd: string,
  provider: NonNullable<RegistryItem["provider"]>,
  pluginPath: string,
  extensionlessImports: boolean,
  target?: string,
): Promise<{ path: string; source: string }> {
  if (
    (provider.seam === undefined || provider.seam === "constructor") &&
    "constructor" in provider
  ) {
    const composition = await findCompositionRoot(
      cwd,
      provider.constructor,
      provider.package,
      target,
    );
    return {
      path: composition.path,
      source: wrapProviderConstruction(
        composition.source,
        composition.binding,
        provider.constructor,
        provider.instrumenter,
        relativeImport(composition.path, pluginPath, extensionlessImports),
      ),
    };
  }
  if (provider.seam === "better-auth-plugin") {
    const composition = await findNativeCallRoot(
      cwd,
      provider.factory,
      provider.package,
      target,
    );
    return {
      path: composition.path,
      source: wireBetterAuthPlugin(
        composition,
        provider.instrumenter,
        relativeImport(composition.path, pluginPath, extensionlessImports),
      ),
    };
  }
  if (provider.seam === "trpc-middleware") {
    const composition = await findTrpcCompositionRoot(
      cwd,
      provider.initializer,
      provider.package,
      target,
    );
    return {
      path: composition.path,
      source: wireTrpcMiddleware(
        composition,
        provider.instrumenter,
        relativeImport(composition.path, pluginPath, extensionlessImports),
      ),
    };
  }
  if (provider.seam === "telemetry-registration") {
    const compositionPath = path.resolve(
      path.dirname(pluginPath),
      "..",
      "runtime.ts",
    );
    const relativeCompositionPath = path
      .relative(cwd, compositionPath)
      .replace(/\\/g, "/");
    if (target !== undefined && target !== relativeCompositionPath) {
      throw new Error(
        `AI SDK telemetry registration target must be ${relativeCompositionPath}. No files were changed.`,
      );
    }
    if (!(await pathExists(compositionPath))) {
      throw new Error(
        `AI SDK telemetry registration requires ${relativeCompositionPath}. Run amplio init first. No files were changed.`,
      );
    }
    const source = await fs.readFile(compositionPath, "utf8");
    const pluginSpecifier = relativeImport(
      compositionPath,
      pluginPath,
      extensionlessImports,
    );
    if (
      hasActiveContributorProviderWiring({
        source,
        provider,
        pluginModuleSpecifiers: [pluginSpecifier],
      })
    ) {
      return { path: compositionPath, source };
    }
    const withProviderImport = addImport(
      source,
      `import { ${provider.registrar} } from "${provider.package}";`,
    );
    const withPluginImport = addImport(
      withProviderImport,
      `import { ${provider.instrumenter} } from "${pluginSpecifier}";`,
    );
    const wired = `${withPluginImport.trimEnd()}\n\n${provider.registrar}(${provider.instrumenter}());\n`;
    if (
      !hasActiveContributorProviderWiring({
        source: wired,
        provider,
        pluginModuleSpecifiers: [pluginSpecifier],
      })
    ) {
      throw new Error(
        "AI SDK telemetry registration verification failed after transformation. No files were changed.",
      );
    }
    return { path: compositionPath, source: wired };
  }
  throw new Error(
    `Plugin wiring seam "${provider.seam}" is not implemented; use --source-only. No files were changed.`,
  );
}

export async function installContributorPlugin(
  options: PluginInstallOptions,
): Promise<PluginInstallResult> {
  const { cwd, telemetryDir, item, eventId, pluginSource } = options;
  if (item.kind !== undefined && item.kind !== "plugin") {
    throw new Error(`Registry item "${item.name}" is not a Plugin.`);
  }
  if (item.role !== undefined && item.role !== "contributor") {
    throw new Error(`Plugin "${item.name}" is not a contributor Plugin.`);
  }
  const branch = item.placement?.branch;
  const provider = item.provider;
  if (!branch || !provider) {
    throw new Error(`Plugin "${item.name}" is missing composition metadata.`);
  }

  const configPath = path.join(cwd, "amplio.json");
  const packagePath = path.join(cwd, "package.json");
  const packageJson = JSON.parse(
    await fs.readFile(packagePath, "utf8"),
  ) as Record<string, unknown>;
  await assertProviderCompatibility(
    cwd,
    packageJson,
    item,
    provider.package,
    options.allowMissingDependencies,
  );

  const eventPath = await findEventFile(
    path.join(cwd, telemetryDir, "events"),
    eventId,
  );
  const pluginPath = path.join(
    cwd,
    telemetryDir,
    "plugins",
    `${item.name.replace(/^plugin-/, "")}.ts`,
  );
  const extensionlessImports = (await detectFramework(cwd)) === "next";
  const composition = await planProviderWiring(
    cwd,
    provider,
    pluginPath,
    extensionlessImports,
    options.target,
  );

  const eventSource = await fs.readFile(eventPath, "utf8");
  const nextEvent = mountPlugin(
    eventSource,
    eventId,
    provider.instrumenter,
    branch,
    relativeImport(eventPath, pluginPath, extensionlessImports),
  );
  const nextComposition = composition.source;
  const compositionBefore = await fs.readFile(composition.path, "utf8");

  const pluginExists = await pathExists(pluginPath);
  const existingPlugin = pluginExists
    ? await fs.readFile(pluginPath, "utf8")
    : undefined;
  const config = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<
    string,
    unknown
  >;
  const slug = item.name.replace(/^plugin-/, "");
  const existingMetadata = (
    config.plugins as Record<string, PluginInstallMetadata> | undefined
  )?.[slug];
  const ownsWiring = existingMetadata && existingMetadata.sourceOnly !== true;
  if (!ownsWiring) {
    if (nextEvent === eventSource || nextComposition === compositionBefore) {
      throw new Error(
        `Plugin "${slug}" appears to have customer-owned Event or provider wiring already. Remove that wiring or keep the Plugin source-only; refusing to record no-op lifecycle hashes. No files were changed.`,
      );
    }
  }
  if (
    existingPlugin !== undefined &&
    existingMetadata === undefined &&
    existingPlugin !== pluginSource &&
    !options.forceUntrackedSource
  ) {
    throw new Error(
      `${path.relative(cwd, pluginPath)} is an untracked Plugin source that differs from the registry recipe. Rerun with --force to overwrite it transactionally. No files were changed.`,
    );
  }
  const compositionRoot = path
    .relative(cwd, composition.path)
    .replace(/\\/g, "/");
  if (existingMetadata) {
    if (
      existingMetadata.event !== eventId ||
      existingMetadata.branch !== branch
    ) {
      throw new Error(
        `Plugin "${slug}" is already active for Event "${existingMetadata.event}" under "${existingMetadata.branch}". Remove it before selecting a different root Event. No files were changed.`,
      );
    }
    if (
      existingMetadata.sourceOnly !== true &&
      existingMetadata.compositionRoot !== compositionRoot
    ) {
      throw new Error(
        `Plugin "${slug}" is already active at ${existingMetadata.compositionRoot}; refusing to retarget its provider seam. No files were changed.`,
      );
    }
    if (
      JSON.stringify(existingMetadata.events) !==
        JSON.stringify(item.events ?? []) ||
      existingMetadata.semanticDigest !== item.semanticDigest ||
      existingMetadata.dependencyDigest !== pluginDependencyDigest(item) ||
      existingMetadata.nativeTransform?.version !==
        item.nativeTransform?.version ||
      existingMetadata.nativeTransform?.digest !==
        item.nativeTransform?.digest ||
      existingMetadata.privacyDigest !== pluginPrivacyDigest(item) ||
      existingMetadata.contractDigest !== pluginContractDigest(item)
    ) {
      throw new Error(
        `Plugin "${slug}" registry contract changed since installation. Run amplio diff plugin ${slug} and migrate it explicitly before activation. No files were changed.`,
      );
    }
  }
  const promotesSourceOnly = existingMetadata?.sourceOnly === true;
  const statePlan =
    existingMetadata?.recipeDigest &&
    existingMetadata.baseArchive &&
    existingMetadata.stateArchive &&
    !promotesSourceOnly
      ? undefined
      : planPluginState({
          cwd,
          slug,
          item,
          role: "contributor",
          sourcePath: pluginPath,
          recipePath: options.recipePath ?? `plugins/${slug}.ts`,
          recipeSource: pluginSource,
          event: eventId,
          branch,
          compositionRoot,
          wiring: [
            {
              file: path.relative(cwd, eventPath).replace(/\\/g, "/"),
              kind: "event-mount",
              anchor: `${eventId}.tree.${branch}`,
              before: eventSource,
              installed: nextEvent,
            },
            {
              file: path.relative(cwd, composition.path).replace(/\\/g, "/"),
              kind: "provider-construction",
              anchor: provider.instrumenter,
              before: compositionBefore,
              installed: nextComposition,
            },
          ],
        });
  if (statePlan) {
    await assertPluginStatePathsContained(cwd, statePlan);
  }
  const metadata = statePlan?.metadata ?? existingMetadata!;
  const plugins = {
    ...((config.plugins as Record<string, unknown> | undefined) ?? {}),
    [slug]: metadata,
  };
  const nextConfig = `${JSON.stringify({ ...config, plugins }, null, 2)}\n`;

  const installedPluginSource =
    existingPlugin !== undefined &&
    (existingMetadata !== undefined || !options.forceUntrackedSource)
      ? existingPlugin
      : pluginSource;
  const writes = [
    { path: pluginPath, content: installedPluginSource },
    { path: eventPath, content: nextEvent },
    { path: composition.path, content: nextComposition },
    ...(statePlan
      ? [
          {
            path: statePlan.baseArchivePath,
            content: statePlan.baseArchiveContent,
          },
          {
            path: statePlan.stateArchivePath,
            content: statePlan.stateArchiveContent,
          },
        ]
      : []),
    { path: configPath, content: nextConfig },
  ];
  const snapshots = await Promise.all(
    writes.map((entry) => snapshot(entry.path)),
  );
  const changed = writes.some(
    (entry, index) => snapshots[index]!.content !== entry.content,
  );
  if (!options.dryRun) {
    try {
      for (const entry of writes) {
        await ensureDir(path.dirname(entry.path));
        await fs.writeFile(entry.path, entry.content, "utf8");
      }
    } catch (error) {
      await restore(snapshots);
      throw error;
    }
  }

  return {
    pluginPath,
    eventPath,
    compositionPath: composition.path,
    changed,
  };
}
