import { createHash } from "node:crypto";

const REGEX_PREFIX_KEYWORDS = new Set([
  "case",
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

const hash = (value) =>
  `sha256-${createHash("sha256").update(value, "utf8").digest("hex")}`;

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function contractError(plugin, detail) {
  return new Error(
    `Registry Plugin "${plugin.replace(/^plugin-/, "")}" ${detail}. No files were changed.`,
  );
}

function codeMask(source, plugin) {
  const output = source.split("");
  let state = "code";
  let canStartRegex = true;
  let regexCharacterClass = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
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
        const token = source.slice(index, end);
        canStartRegex =
          output[previous] !== "." && REGEX_PREFIX_KEYWORDS.has(token);
        index = end - 1;
      } else if (/[0-9]/.test(character)) {
        let end = index + 1;
        while (/[\w.]/.test(source[end] ?? "")) end += 1;
        canStartRegex = false;
        index = end - 1;
      } else if (")]}".includes(character) || character === ".") {
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
        throw contractError(
          plugin,
          "contains an unterminated regular expression",
        );
      }
      if (character === "\\") {
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
  if (state !== "code" && state !== "line") {
    throw contractError(plugin, `contains an unterminated ${state} token`);
  }
  return output.join("");
}

function importedBindings(source, moduleSpecifier, importedName) {
  const mask = codeMask(source, moduleSpecifier);
  const bindings = new Set();
  for (const token of mask.matchAll(/\bimport\b/g)) {
    const declaration = /^import\s+([^;]*?)\s+from\s*(["'])([^"'\r\n]+)\2/.exec(
      source.slice(token.index),
    );
    if (!declaration || declaration[3] !== moduleSpecifier) continue;
    const clause = declaration[1].trim();
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
  }
  return [...bindings];
}

function allImportedBindings(source, plugin) {
  const mask = codeMask(source, plugin);
  const bindings = new Set();
  for (const token of mask.matchAll(/\bimport\b/g)) {
    const declaration = /^import\s+([^;]*?)\s+from\s*(["'])([^"'\r\n]+)\2/.exec(
      source.slice(token.index),
    );
    if (!declaration) continue;
    const clause = declaration[1].trim().replace(/^type\s+/, "");
    const defaultName = /^([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(clause)?.[1];
    if (defaultName) bindings.add(defaultName);
    const namespace = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause)?.[1];
    if (namespace) bindings.add(namespace);
    const named = /\{([\s\S]*?)\}/.exec(clause)?.[1];
    for (const rawEntry of named?.split(",") ?? []) {
      const parsed =
        /^(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(
          rawEntry.trim(),
        );
      if (parsed) bindings.add(parsed[2] ?? parsed[1]);
    }
  }
  return bindings;
}

function findMatching(mask, openIndex, open, close, plugin) {
  let depth = 0;
  for (let index = openIndex; index < mask.length; index += 1) {
    if (mask[index] === open) depth += 1;
    else if (mask[index] === close) {
      depth -= 1;
      if (depth === 0) return index;
      if (depth < 0) break;
    }
  }
  throw contractError(plugin, `has an unbalanced ${open}${close} contract`);
}

function trimRange(source, start, end) {
  while (start < end && /\s/.test(source[start])) start += 1;
  while (end > start && /\s/.test(source[end - 1])) end -= 1;
  return { start, end };
}

function objectEntries(source, mask, open, close, plugin) {
  const segments = [];
  let braces = 1;
  let brackets = 0;
  let parentheses = 0;
  let start = open + 1;
  for (let index = start; index < close; index += 1) {
    const character = mask[index];
    if (
      character === "," &&
      braces === 1 &&
      brackets === 0 &&
      parentheses === 0
    ) {
      segments.push(trimRange(source, start, index));
      start = index + 1;
    } else if (character === "{") braces += 1;
    else if (character === "}") braces -= 1;
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets -= 1;
    else if (character === "(") parentheses += 1;
    else if (character === ")") parentheses -= 1;
  }
  segments.push(trimRange(source, start, close));

  const entries = [];
  for (const segment of segments) {
    if (segment.start === segment.end) continue;
    if (source.slice(segment.start, segment.start + 3) === "...") {
      throw contractError(
        plugin,
        "uses an unsupported spread in semantic metadata",
      );
    }
    let colon = -1;
    let innerBraces = 0;
    let innerBrackets = 0;
    let innerParentheses = 0;
    for (let index = segment.start; index < segment.end; index += 1) {
      const character = mask[index];
      if (
        character === ":" &&
        innerBraces === 0 &&
        innerBrackets === 0 &&
        innerParentheses === 0
      ) {
        colon = index;
        break;
      }
      if (character === "{") innerBraces += 1;
      else if (character === "}") innerBraces -= 1;
      else if (character === "[") innerBrackets += 1;
      else if (character === "]") innerBrackets -= 1;
      else if (character === "(") innerParentheses += 1;
      else if (character === ")") innerParentheses -= 1;
    }
    if (colon < 0) {
      const shorthand = source.slice(segment.start, segment.end).trim();
      const method =
        /^(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^>{}]*>)?\s*\(/.exec(
          shorthand,
        )?.[1];
      if (method) {
        entries.push({ key: method, value: segment });
        continue;
      }
      if (!/^[A-Za-z_$][\w$]*$/.test(shorthand)) {
        throw contractError(plugin, "uses unsupported semantic object syntax");
      }
      entries.push({
        key: shorthand,
        value: trimRange(source, segment.start, segment.end),
      });
      continue;
    }
    const rawKey = source.slice(segment.start, colon).trim();
    const identifier = /^([A-Za-z_$][\w$]*)$/.exec(rawKey)?.[1];
    const quoted = /^(?:"([^"\r\n]+)"|'([^'\r\n]+)')$/.exec(rawKey);
    const key = identifier ?? quoted?.[1] ?? quoted?.[2];
    if (!key) {
      throw contractError(plugin, "uses an unsupported computed semantic key");
    }
    entries.push({
      key,
      value: trimRange(source, colon + 1, segment.end),
    });
  }
  return entries;
}

function depths(mask) {
  const values = new Int32Array(mask.length + 1);
  let depth = 0;
  for (let index = 0; index < mask.length; index += 1) {
    values[index] = depth;
    const character = mask[index];
    if (character === "{" || character === "[" || character === "(") {
      depth += 1;
    } else if (")]}".includes(character)) {
      depth -= 1;
    }
  }
  values[mask.length] = depth;
  return values;
}

function declarations(source, mask, plugin) {
  const result = new Map();
  const nesting = depths(mask);
  const pattern =
    /\b(?:export\s+)?(?:declare\s+)?(const|let|var|function|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g;
  for (const match of mask.matchAll(pattern)) {
    if (nesting[match.index] !== 0) continue;
    const kind = match[1];
    const name = match[2];
    const start = match.index;
    let end = -1;
    if (["function", "class", "interface", "enum"].includes(kind)) {
      const open = mask.indexOf("{", match.index + match[0].length);
      if (open >= 0 && nesting[open] === 0) {
        end = findMatching(mask, open, "{", "}", plugin) + 1;
        if (source[end] === ";") end += 1;
      }
    } else {
      for (
        let index = match.index + match[0].length;
        index < mask.length;
        index += 1
      ) {
        if (mask[index] === ";" && nesting[index] === 0) {
          end = index + 1;
          break;
        }
      }
    }
    if (end < 0) {
      throw contractError(plugin, `cannot bound declaration ${name}`);
    }
    if (result.has(name)) {
      throw contractError(
        plugin,
        `has duplicate top-level declaration ${name}`,
      );
    }
    result.set(name, { name, start, end, kind });
  }
  return result;
}

function canonicalTokens(source, plugin) {
  const tokens = [];
  let canStartRegex = true;
  for (let index = 0; index < source.length;) {
    const character = source[index];
    const next = source[index + 1];
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === "/" && next === "/") {
      index = source.indexOf("\n", index + 2);
      if (index < 0) break;
      continue;
    }
    if (character === "/" && next === "*") {
      const close = source.indexOf("*/", index + 2);
      if (close < 0)
        throw contractError(plugin, "contains an unterminated block comment");
      index = close + 2;
      continue;
    }
    if (character === "'" || character === '"') {
      const quote = character;
      let end = index + 1;
      for (; end < source.length; end += 1) {
        if (source[end] === "\\") end += 1;
        else if (source[end] === quote) break;
        else if (source[end] === "\n" || source[end] === "\r") {
          throw contractError(plugin, "contains an unterminated string");
        }
      }
      if (end >= source.length)
        throw contractError(plugin, "contains an unterminated string");
      tokens.push({ kind: "literal", raw: source.slice(index, end + 1) });
      index = end + 1;
      canStartRegex = false;
      continue;
    }
    if (character === "`") {
      let end = index + 1;
      for (; end < source.length; end += 1) {
        if (source[end] === "\\") end += 1;
        else if (source[end] === "`") break;
      }
      if (end >= source.length)
        throw contractError(
          plugin,
          "contains an unterminated template literal",
        );
      tokens.push({ kind: "literal", raw: source.slice(index, end + 1) });
      index = end + 1;
      canStartRegex = false;
      continue;
    }
    if (character === "/" && canStartRegex) {
      let end = index + 1;
      let characterClass = false;
      for (; end < source.length; end += 1) {
        if (source[end] === "\\") end += 1;
        else if (source[end] === "[") characterClass = true;
        else if (source[end] === "]") characterClass = false;
        else if (source[end] === "/" && !characterClass) break;
        else if (source[end] === "\n" || source[end] === "\r") {
          throw contractError(
            plugin,
            "contains an unterminated regular expression",
          );
        }
      }
      if (end >= source.length)
        throw contractError(
          plugin,
          "contains an unterminated regular expression",
        );
      end += 1;
      while (/[A-Za-z]/.test(source[end] ?? "")) end += 1;
      tokens.push({ kind: "literal", raw: source.slice(index, end) });
      index = end;
      canStartRegex = false;
      continue;
    }
    if (/[A-Za-z_$]/.test(character)) {
      let end = index + 1;
      while (/[\w$]/.test(source[end] ?? "")) end += 1;
      const raw = source.slice(index, end);
      tokens.push({ kind: "identifier", raw });
      canStartRegex = REGEX_PREFIX_KEYWORDS.has(raw);
      index = end;
      continue;
    }
    if (/[0-9]/.test(character)) {
      let end = index + 1;
      while (/[\w.]/.test(source[end] ?? "")) end += 1;
      tokens.push({ kind: "number", raw: source.slice(index, end) });
      index = end;
      canStartRegex = false;
      continue;
    }
    tokens.push({ kind: "punctuation", raw: character });
    index += 1;
    canStartRegex = /[,;:?!~=&|+\-*%^<>{[(]/.test(character);
  }
  return tokens;
}

function canonicalCode(source, plugin) {
  return canonicalTokens(source, plugin)
    .map((token) => token.raw)
    .join("\u001f");
}

function closureMaterial(source, ranges, declarationMap, plugin) {
  const selected = new Map();
  const queue = ranges.map((range) => source.slice(range.start, range.end));
  while (queue.length > 0) {
    const fragment = queue.pop();
    for (const token of canonicalTokens(fragment, plugin)) {
      if (token.kind !== "identifier") continue;
      const declaration = declarationMap.get(token.raw);
      if (!declaration || selected.has(token.raw)) continue;
      selected.set(token.raw, declaration);
      queue.push(source.slice(declaration.start, declaration.end));
    }
  }
  return {
    material: [
      ...ranges.map((range) =>
        canonicalCode(source.slice(range.start, range.end), plugin),
      ),
      ...[...selected]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(
          ([name, range]) =>
            `${name}:${canonicalCode(source.slice(range.start, range.end), plugin)}`,
        ),
    ],
    ranges: [...selected.values()],
  };
}

function literalString(source, range) {
  const raw = source.slice(range.start, range.end).trim();
  return /^(?:"([^"\r\n]+)"|'([^'\r\n]+)')$/.exec(raw)?.slice(1).find(Boolean);
}

function literalVersion(source, range) {
  const raw = source.slice(range.start, range.end).trim();
  return /^\d+$/.test(raw) ? Number(raw) : undefined;
}

function extractEventDefinitions(source, sourceName, plugin) {
  const mask = codeMask(source, plugin);
  const declarationMap = declarations(source, mask, plugin);
  const definitions = [];
  for (const binding of importedBindings(
    source,
    "@useamplio/amplio",
    "event",
  )) {
    const pattern = new RegExp(
      `\\b${binding.replace(/[$]/g, "\\$")}\\s*\\(`,
      "g",
    );
    for (const match of mask.matchAll(pattern)) {
      const openParen = mask.indexOf("(", match.index);
      let objectOpen = openParen + 1;
      while (/\s/.test(mask[objectOpen] ?? "")) objectOpen += 1;
      if (mask[objectOpen] !== "{") {
        throw contractError(
          plugin,
          "requires event(...) to receive an inline object literal",
        );
      }
      const objectClose = findMatching(mask, objectOpen, "{", "}", plugin);
      const closeParen = findMatching(mask, openParen, "(", ")", plugin);
      const properties = new Map(
        objectEntries(source, mask, objectOpen, objectClose, plugin).map(
          (entry) => [entry.key, entry.value],
        ),
      );
      const id = properties.has("id")
        ? literalString(source, properties.get("id"))
        : undefined;
      const version = properties.has("version")
        ? literalVersion(source, properties.get("version"))
        : undefined;
      if (
        !id ||
        !Number.isInteger(version) ||
        version < 1 ||
        !properties.has("schema")
      ) {
        throw contractError(
          plugin,
          `has an Event in ${sourceName} without static id, positive version, and schema`,
        );
      }

      let declaredBinding;
      let declarationRange;
      for (const declaration of declarationMap.values()) {
        if (declaration.start > match.index || declaration.end < closeParen)
          continue;
        const prefix = source.slice(declaration.start, match.index);
        if (
          new RegExp(
            `\\b(?:const|let|var)\\s+${declaration.name.replace(/[$]/g, "\\$")}\\s*=\\s*$`,
          ).test(prefix)
        ) {
          declaredBinding = declaration.name;
          declarationRange = declaration;
          break;
        }
      }

      const semanticValueRanges = [
        properties.get("schema"),
        ...(properties.has("tree") ? [properties.get("tree")] : []),
        ...(properties.has("timing") ? [properties.get("timing")] : []),
        ...(properties.has("cardinality")
          ? [properties.get("cardinality")]
          : []),
      ];
      const closure = closureMaterial(
        source,
        semanticValueRanges,
        declarationMap,
        plugin,
      );
      definitions.push({
        id,
        version,
        source,
        sourceName,
        callStart: match.index,
        callEnd: closeParen + 1,
        binding: declaredBinding,
        semanticMaterial: {
          schema: canonicalCode(
            source.slice(
              properties.get("schema").start,
              properties.get("schema").end,
            ),
            plugin,
          ),
          tree: properties.has("tree")
            ? canonicalCode(
                source.slice(
                  properties.get("tree").start,
                  properties.get("tree").end,
                ),
                plugin,
              )
            : "{}",
          timing: properties.has("timing")
            ? canonicalCode(
                source.slice(
                  properties.get("timing").start,
                  properties.get("timing").end,
                ),
                plugin,
              )
            : '"duration"',
          cardinality: properties.has("cardinality")
            ? canonicalCode(
                source.slice(
                  properties.get("cardinality").start,
                  properties.get("cardinality").end,
                ),
                plugin,
              )
            : '"single"',
          closure: closure.material,
        },
        semanticRanges: [
          declarationRange ?? { start: match.index, end: closeParen + 1 },
          ...closure.ranges,
        ],
      });
    }
  }
  return { source, sourceName, mask, declarationMap, definitions };
}

function pluginEventPaths(extraction, item) {
  const { source, mask, definitions } = extraction;
  const paths = new Map();
  const semanticRanges = [];
  const pluginBindings = importedBindings(
    source,
    "@useamplio/amplio/plugin",
    "plugin",
  );
  const calls = [];
  for (const binding of pluginBindings) {
    const pattern = new RegExp(
      `\\b${binding.replace(/[$]/g, "\\$")}\\s*\\(`,
      "g",
    );
    for (const match of mask.matchAll(pattern)) {
      const openParen = mask.indexOf("(", match.index);
      let objectOpen = openParen + 1;
      while (/\s/.test(mask[objectOpen] ?? "")) objectOpen += 1;
      if (mask[objectOpen] !== "{") continue;
      calls.push({
        objectOpen,
        objectClose: findMatching(mask, objectOpen, "{", "}", item.name),
      });
    }
  }
  if (item.role === "contributor" && calls.length !== 1) {
    throw contractError(
      item.name,
      `must contain exactly one authenticated plugin({...}) contract; found ${calls.length}`,
    );
  }
  if (calls.length === 0) return { paths, semanticRanges };
  const pluginObject = objectEntries(
    source,
    mask,
    calls[0].objectOpen,
    calls[0].objectClose,
    item.name,
  );
  const events = pluginObject.find((entry) => entry.key === "events")?.value;
  if (!events)
    throw contractError(item.name, "plugin({...}) has no events tree");
  if (mask[events.start] !== "{") {
    throw contractError(item.name, "requires an inline Plugin events tree");
  }
  const eventsClose = findMatching(mask, events.start, "{", "}", item.name);
  semanticRanges.push({ start: events.start, end: eventsClose + 1 });

  const visit = (open, close, prefix) => {
    for (const entry of objectEntries(source, mask, open, close, item.name)) {
      const nextPath = [...prefix, entry.key];
      if (mask[entry.value.start] === "{") {
        visit(
          entry.value.start,
          findMatching(mask, entry.value.start, "{", "}", item.name),
          nextPath,
        );
        continue;
      }
      const raw = source.slice(entry.value.start, entry.value.end).trim();
      const definition = definitions.find(
        (candidate) =>
          (candidate.binding && raw === candidate.binding) ||
          (candidate.callStart >= entry.value.start &&
            candidate.callEnd <= entry.value.end),
      );
      if (!definition) {
        throw contractError(
          item.name,
          `cannot resolve Plugin events path ${nextPath.join(".")} to an Event definition`,
        );
      }
      const current = paths.get(definition.id) ?? [];
      current.push(nextPath.join("."));
      paths.set(definition.id, current);
    }
  };
  visit(events.start, eventsClose, []);
  return { paths, semanticRanges };
}

function collectContractItems(item, byName) {
  const output = [];
  const seen = new Set();
  const visit = (candidate) => {
    if (!candidate || seen.has(candidate.name)) return;
    seen.add(candidate.name);
    output.push(candidate);
    for (const dependency of candidate.registryDependencies ?? []) {
      visit(byName.get(dependency.replace(/^@useamplio\//, "")));
    }
  };
  visit(item);
  return output;
}

function sourceOf(item) {
  const file = item.files?.find(
    (candidate) => typeof candidate.content === "string",
  );
  return file?.content;
}

function derivePluginContracts(item, allItems) {
  if (
    !item.nativeTransform ||
    !Number.isInteger(item.nativeTransform.version) ||
    item.nativeTransform.version < 1
  ) {
    throw contractError(
      item.name,
      "requires nativeTransform.version as a positive integer",
    );
  }
  const byName = new Map(
    allItems.map((candidate) => [candidate.name, candidate]),
  );
  const contractItems = collectContractItems(item, byName);
  const extractions = contractItems.map((candidate) => {
    const source = sourceOf(candidate);
    if (source === undefined) {
      throw contractError(
        item.name,
        `cannot read contract source for ${candidate.name}`,
      );
    }
    return extractEventDefinitions(
      source,
      candidate.files[0]?.path ?? candidate.name,
      item.name,
    );
  });
  const pluginExtraction = extractions[0];
  const mapping = pluginEventPaths(pluginExtraction, item);
  const definitions = extractions.flatMap((entry) => entry.definitions);
  const manifestEvents = item.events ?? [];
  const hydratedEvents = manifestEvents.map((event) => {
    const candidates = definitions.filter(
      (definition) => definition.id === event.id,
    );
    if (candidates.length !== 1) {
      throw contractError(
        item.name,
        `must resolve Event ${event.id} exactly once; found ${candidates.length}`,
      );
    }
    const definition = candidates[0];
    if (definition.version !== event.version) {
      throw contractError(
        item.name,
        `declares Event ${event.id}@${event.version} but source defines @${definition.version}`,
      );
    }
    const semanticDigest = hash(
      stableJson({
        ...definition.semanticMaterial,
        paths: [...(mapping.paths.get(event.id) ?? [])].sort(),
      }),
    );
    if (event.semanticDigest && event.semanticDigest !== semanticDigest) {
      throw contractError(
        item.name,
        `has stale semanticDigest for Event ${event.id}`,
      );
    }
    return { ...event, semanticDigest };
  });
  if (
    hydratedEvents.length !== manifestEvents.length ||
    hydratedEvents.length === 0
  ) {
    throw contractError(
      item.name,
      "must declare at least one Event semantic contract",
    );
  }
  const semanticDigest = hash(
    stableJson(
      hydratedEvents
        .map(({ id, version, semanticDigest: digest }) => ({
          id,
          version,
          digest,
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    ),
  );
  if (item.semanticDigest && item.semanticDigest !== semanticDigest) {
    throw contractError(item.name, "has a stale aggregate semanticDigest");
  }

  const pluginSource = sourceOf(item);
  const maskedSource = pluginSource.split("");
  const pluginSemanticRanges = [
    ...pluginExtraction.definitions.flatMap(
      (definition) => definition.semanticRanges,
    ),
    ...mapping.semanticRanges,
  ].sort((left, right) => left.start - right.start);
  for (const range of pluginSemanticRanges) {
    for (let index = range.start; index < range.end; index += 1) {
      if (maskedSource[index] !== "\n" && maskedSource[index] !== "\r") {
        maskedSource[index] = " ";
      }
    }
  }
  const nativeDigest = hash(
    stableJson({
      role: item.role,
      placement: item.placement,
      provider: item.provider,
      wiringActions: item.wiringActions,
      source: canonicalCode(maskedSource.join(""), item.name),
    }),
  );
  if (
    item.nativeTransform.digest &&
    item.nativeTransform.digest !== nativeDigest
  ) {
    throw contractError(item.name, "has a stale nativeTransform.digest");
  }
  return {
    ...item,
    events: hydratedEvents,
    semanticDigest,
    nativeTransform: {
      version: item.nativeTransform.version,
      digest: nativeDigest,
    },
  };
}

export function hydrateRegistryPluginContracts(items) {
  return items.map((item) =>
    item.kind === "plugin" ? derivePluginContracts(item, items) : item,
  );
}
