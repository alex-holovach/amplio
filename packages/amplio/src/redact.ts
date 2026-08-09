import { getGlobalState } from "./global-state.js";
import type { JsonValue, LogRecord, RedactConfig } from "./types.js";

const REDACTED = "[REDACTED]";
const PERCENT_ENCODED = /%[0-9A-Fa-f]{2}/;

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
  "card",
  "card_number",
  "credit_card",
  "pan",
]);

const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const JWT_PATTERN =
  /\b(?:eyJ[A-Za-z0-9_-]*\.(?:eyJ[A-Za-z0-9_-]*\.)?[A-Za-z0-9_-]*)\b/g;
// Candidate PANs: 13–19 digits with optional single space/dash separators
// (real card data is very often "4111 1111 1111 1111"-grouped). Candidates are
// verified against brand prefixes + Luhn in redactCardCandidate so ordinary
// long numbers (timestamps, ids) do not get eaten.
const CC_PATTERN = /\b\d(?:[ -]?\d){12,18}\b/g;
const CC_VERIFY_PATTERN =
  /^(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})$/;
// 13+ digits allowing single space/dash separators between them.
const CC_GATE_PATTERN = /\d(?:[ -]?\d){12}/;
// Separator accepts `+` as well as whitespace: query strings form-encode
// spaces as `+` (NextRequest.nextUrl.search normalizes %20 to +), and
// decodeURIComponent does not turn `+` back into a space.
const BEARER_PATTERN = /\bBearer(?:\s|\+)+[A-Za-z0-9\-._~+/]+=*\b/gi;
const AUTH_HEADER_PATTERN = /\bAuthorization:\s*[^\s,]+/gi;

const luhnValid = (digits: string): boolean => {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = digits.charCodeAt(index) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
};

const redactCardCandidate = (match: string): string => {
  const digits = match.replace(/[ -]/g, "");
  if (!CC_VERIFY_PATTERN.test(digits) || !luhnValid(digits)) {
    return match;
  }
  return REDACTED;
};

type GatedPattern = {
  test: (input: string) => boolean;
  pattern: RegExp;
  replacement?: (match: string) => string;
};

const DEFAULT_GATED_PATTERNS: GatedPattern[] = [
  { test: (s) => s.includes("@"), pattern: EMAIL_PATTERN },
  { test: (s) => s.includes("eyJ"), pattern: JWT_PATTERN },
  {
    test: (s) => CC_GATE_PATTERN.test(s),
    pattern: CC_PATTERN,
    replacement: redactCardCandidate,
  },
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

export function setCompiledRedactFromConfig(redact?: RedactConfig): void {
  const state = getGlobalState();
  if (redact === false) {
    state.activeCompiled = false;
    return;
  }
  if (redact === undefined) {
    state.activeCompiled = DEFAULT_COMPILED;
    return;
  }
  state.activeCompiled = compileRedactConfig(redact);
}

export function resetCompiledRedactForTests(): void {
  getGlobalState().activeCompiled = undefined;
}

export function getCompiledRedact(): CompiledRedactConfig | false {
  return getGlobalState().activeCompiled ?? DEFAULT_COMPILED;
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
  if (PERCENT_ENCODED.test(input)) {
    return true;
  }
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
      // Space/dash/plus separators do not reset the digit run —
      // "4111-1111-1111-1111" and form-encoded "4111+1111+1111+1111" must
      // still reach the PAN pattern scan.
      if (ch !== 45 && ch !== 43) {
        safeDigitRun = 0;
      }
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
    } else if (ch !== 32 && ch !== 45 && ch !== 43) {
      // Spaced/dashed/plus-separated PANs keep counting: "4111 1111 1111 1111",
      // form-encoded "4111+1111+1111+1111".
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

const applyGatedPatterns = (input: string, gatedPatterns: GatedPattern[]): string => {
  let out = input;
  for (const { test, pattern, replacement } of gatedPatterns) {
    if (!test(out)) {
      continue;
    }
    const next = replacement
      ? out.replace(pattern, replacement)
      : out.replace(pattern, REDACTED);
    if (next !== out) {
      out = next;
    }
  }
  return out === input ? input : out;
};

// When a pattern only matches after decoding, the redacted value is stored in
// its DECODED form (and, if the match needed the form-decode pass, with `+`
// separators turned into spaces) — the stored string's encoding changes when
// redaction fires. Leaking beats shape stability; documented in the README
// redaction contract.
const redactString = (input: string, gatedPatterns: GatedPattern[]): string => {
  const raw = applyGatedPatterns(input, gatedPatterns);
  const percentEncoded = PERCENT_ENCODED.test(input);
  if (!percentEncoded && !input.includes("+")) {
    return raw;
  }
  try {
    const decoded = percentEncoded ? decodeURIComponent(input) : input;
    if (decoded !== input) {
      const decodedRedacted = applyGatedPatterns(decoded, gatedPatterns);
      if (decodedRedacted !== decoded) {
        return decodedRedacted;
      }
    }
    // Form-encoding pass: decodeURIComponent does not map `+` to a space, so
    // "Bearer+abc" / "4111+1111+1111+1111" in query strings would otherwise
    // slip past patterns that expect space or dash separators.
    const formDecoded = decoded.replace(/\+/g, " ");
    if (formDecoded !== decoded) {
      const formRedacted = applyGatedPatterns(formDecoded, gatedPatterns);
      if (formRedacted !== formDecoded) {
        return formRedacted;
      }
    }
  } catch {
    // malformed percent-encoding — fall back to raw-string result only
  }
  return raw;
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
