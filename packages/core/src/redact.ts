import type { JsonValue, LogRecord, RedactConfig } from "./types.js";

const REDACTED = "[REDACTED]";

const DEFAULT_FIELD_KEYS = new Set([
  "authorization",
  "cookie",
  "email",
  "set-cookie",
  "password",
  "secret",
  "token",
  "access_token",
  "refresh_token",
]);

const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const JWT_PATTERN =
  /\b(?:eyJ[A-Za-z0-9_-]*\.(?:eyJ[A-Za-z0-9_-]*\.)?[A-Za-z0-9_-]*)\b/g;
const CC_PATTERN =
  /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b/g;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9\-._~+/]+=*\b/gi;
const AUTH_HEADER_PATTERN = /\bAuthorization:\s*[^\s,]+/gi;

type GatedPattern = {
  test: (input: string) => boolean;
  pattern: RegExp;
};

const DEFAULT_GATED_PATTERNS: GatedPattern[] = [
  { test: (s) => s.includes("@"), pattern: EMAIL_PATTERN },
  { test: (s) => s.includes("eyJ"), pattern: JWT_PATTERN },
  { test: (s) => /\d{13,}/.test(s), pattern: CC_PATTERN },
  {
    test: (s) => s.includes("Bearer") || s.includes("bearer"),
    pattern: BEARER_PATTERN,
  },
  {
    test: (s) => s.includes("Authorization:") || s.includes("authorization:"),
    pattern: AUTH_HEADER_PATTERN,
  },
];

export type CompiledRedactConfig = {
  fieldKeys: Set<string>;
  gatedPatterns: GatedPattern[];
};

const compileGatedPatterns = (extra: RegExp[] = []): GatedPattern[] => {
  if (extra.length === 0) {
    return DEFAULT_GATED_PATTERNS;
  }
  return [
    ...DEFAULT_GATED_PATTERNS,
    ...extra.map((pattern) => ({ test: () => true, pattern })),
  ];
};

export function compileRedactConfig(config?: RedactConfig): CompiledRedactConfig | false {
  if (config === false) {
    return false;
  }

  const fieldKeys = new Set(DEFAULT_FIELD_KEYS);
  for (const key of config?.fields ?? []) {
    fieldKeys.add(key.toLowerCase());
  }

  return {
    fieldKeys,
    gatedPatterns: compileGatedPatterns(config?.patterns),
  };
}

const DEFAULT_COMPILED = compileRedactConfig(undefined) as CompiledRedactConfig;

let activeCompiled: CompiledRedactConfig | false | undefined;

export function setCompiledRedactFromConfig(redact?: RedactConfig): void {
  if (redact === false) {
    activeCompiled = false;
    return;
  }
  if (redact === undefined) {
    activeCompiled = DEFAULT_COMPILED;
    return;
  }
  activeCompiled = compileRedactConfig(redact);
}

export function resetCompiledRedactForTests(): void {
  activeCompiled = undefined;
}

export function getCompiledRedact(): CompiledRedactConfig | false {
  return activeCompiled ?? DEFAULT_COMPILED;
}

const fieldKeyRedacts = (fieldKey: string, fieldKeys: Set<string>): boolean => {
  if (fieldKeys.has(fieldKey)) {
    return true;
  }
  for (let index = 0; index < fieldKey.length; index += 1) {
    const code = fieldKey.charCodeAt(index);
    if (code >= 65 && code <= 90) {
      return fieldKeys.has(fieldKey.toLowerCase());
    }
  }
  return false;
};

const needsPatternScan = (input: string): boolean => {
  const len = input.length;
  if (len < 5) {
    return false;
  }
  if (len <= 48) {
    let safe = true;
    let safeDigitRun = 0;
    for (let index = 0; index < len; index += 1) {
      const ch = input.charCodeAt(index);
      if (ch >= 48 && ch <= 57) {
        safeDigitRun += 1;
        if (safeDigitRun >= 13) {
          return true;
        }
        continue;
      }
      safeDigitRun = 0;
      if (
        (ch >= 97 && ch <= 122) ||
        ch === 95 ||
        ch === 45 ||
        ch === 46 ||
        ch === 47 ||
        ch === 58
      ) {
        continue;
      }
      safe = false;
      break;
    }
    if (safe) {
      return false;
    }
  }
  let digitRun = 0;
  let hasE = false;
  for (let index = 0; index < len; index += 1) {
    const ch = input.charCodeAt(index);
    if (ch === 64) {
      return true;
    }
    if (ch >= 48 && ch <= 57) {
      digitRun += 1;
      if (digitRun >= 13) {
        return true;
      }
    } else {
      digitRun = 0;
    }
    if (ch === 69 || ch === 101) {
      hasE = true;
    }
  }
  if (hasE && input.includes("eyJ")) {
    return true;
  }
  if (len >= 6) {
    if (input.includes("earer") || input.includes("uthorization:")) {
      return true;
    }
  }
  return false;
};

const redactString = (input: string, gatedPatterns: GatedPattern[]): string => {
  let out = input;
  for (const { test, pattern } of gatedPatterns) {
    if (!test(out)) {
      continue;
    }
    const next = out.replace(pattern, REDACTED);
    if (next !== out) {
      out = next;
    }
  }
  return out === input ? input : out;
};

const redactStringValue = (
  fieldKey: string,
  str: string,
  fieldKeys: Set<string>,
  gatedPatterns: GatedPattern[],
): string => {
  if (fieldKeyRedacts(fieldKey, fieldKeys)) {
    return REDACTED;
  }
  if (!needsPatternScan(str)) {
    return str;
  }
  return redactString(str, gatedPatterns);
};

function redactArray(
  value: JsonValue[],
  fieldKey: string,
  fieldKeys: Set<string>,
  gatedPatterns: GatedPattern[],
): JsonValue[] {
  let out: JsonValue[] | null = null;
  for (let index = 0, len = value.length; index < len; index += 1) {
    const item = value[index] as JsonValue;
    const itemType = typeof item;

    if (itemType === "number" || itemType === "boolean" || item === null) {
      if (out !== null) {
        out.push(item);
      }
      continue;
    }

    if (itemType === "string") {
      const str = item as string;
      const next = redactStringValue(fieldKey, str, fieldKeys, gatedPatterns);
      if (next !== str) {
        if (out === null) {
          out = value.slice(0, index);
        }
        out.push(next);
      } else if (out !== null) {
        out.push(str);
      }
      continue;
    }

    if (itemType === "object") {
      const next = Array.isArray(item)
        ? redactValue(item, fieldKey, fieldKeys, gatedPatterns)
        : redactObject(item as Record<string, JsonValue>, fieldKeys, gatedPatterns);
      if (next !== item) {
        if (out === null) {
          out = value.slice(0, index);
        }
        out.push(next);
      } else if (out !== null) {
        out.push(item);
      }
    }
  }
  return out ?? value;
}

function redactObject(
  obj: Record<string, JsonValue>,
  fieldKeys: Set<string>,
  gatedPatterns: GatedPattern[],
): Record<string, JsonValue> {
  let out: Record<string, JsonValue> | null = null;
  for (const key in obj) {
    if (!Object.hasOwn(obj, key)) {
      continue;
    }
    const nested = obj[key];
    if (nested === undefined) {
      continue;
    }
    const nestedType = typeof nested;
    if (nestedType === "number" || nestedType === "boolean" || nested === null) {
      continue;
    }
    if (nestedType === "string") {
      const str = nested as string;
      const next = redactStringValue(key, str, fieldKeys, gatedPatterns);
      if (next !== str) {
        if (out === null) {
          out = { ...obj };
        }
        out[key] = next;
      }
      continue;
    }
    if (Array.isArray(nested)) {
      const next = redactValue(nested, key, fieldKeys, gatedPatterns);
      if (next !== nested) {
        if (out === null) {
          out = { ...obj };
        }
        out[key] = next;
      }
      continue;
    }
    if (nestedType === "object") {
      const next = redactObject(
        nested as Record<string, JsonValue>,
        fieldKeys,
        gatedPatterns,
      );
      if (next !== nested) {
        if (out === null) {
          out = { ...obj };
        }
        out[key] = next;
      }
    }
  }
  return out ?? obj;
}

function redactValue(
  value: JsonValue,
  fieldKey: string,
  fieldKeys: Set<string>,
  gatedPatterns: GatedPattern[],
): JsonValue {
  const valueType = typeof value;

  if (valueType === "string") {
    return redactStringValue(fieldKey, value as string, fieldKeys, gatedPatterns);
  }

  if (valueType === "number" || valueType === "boolean" || value === null) {
    return value;
  }

  if (Array.isArray(value)) {
    return redactArray(value, fieldKey, fieldKeys, gatedPatterns);
  }

  if (valueType === "object") {
    return redactObject(value as Record<string, JsonValue>, fieldKeys, gatedPatterns);
  }

  return value;
}

const redactRecordCompiled = (
  record: LogRecord,
  compiled: CompiledRedactConfig,
): LogRecord => {
  const { fieldKeys, gatedPatterns } = compiled;
  return redactObject(
    record as Record<string, JsonValue>,
    fieldKeys,
    gatedPatterns,
  ) as LogRecord;
};

export function redactRecord(record: LogRecord, config?: RedactConfig): LogRecord {
  const compiled =
    config !== undefined ? compileRedactConfig(config) : getCompiledRedact();
  if (compiled === false) {
    return record;
  }
  return redactRecordCompiled(record, compiled);
}
