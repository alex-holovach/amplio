import type { JsonValue, LogRecord, RedactConfig } from "./types.js";

const REDACTED = "[REDACTED]";

const DEFAULT_FIELD_KEYS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "password",
  "secret",
  "token",
  "access_token",
  "refresh_token",
]);

const DEFAULT_PATTERNS: RegExp[] = [
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  /\b(?:eyJ[A-Za-z0-9_-]*\.(?:eyJ[A-Za-z0-9_-]*\.)?[A-Za-z0-9_-]*)\b/g,
  /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b/g,
  /\bBearer\s+[A-Za-z0-9\-._~+/]+=*\b/gi,
  /\bAuthorization:\s*[^\s,]+/gi,
];

const redactString = (input: string, patterns: RegExp[]): string => {
  let out = input;
  for (const pattern of patterns) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
};

const redactValue = (
  value: JsonValue,
  fieldKey: string,
  fieldKeys: Set<string>,
  patterns: RegExp[],
): JsonValue => {
  if (typeof value === "string") {
    if (fieldKeys.has(fieldKey.toLowerCase())) {
      return REDACTED;
    }
    return redactString(value, patterns);
  }

  if (Array.isArray(value)) {
    return value.map((item, index) =>
      redactValue(item, `${fieldKey}[${index}]`, fieldKeys, patterns),
    );
  }

  if (value && typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = redactValue(nested, key, fieldKeys, patterns);
    }
    return out;
  }

  return value;
};

export function redactRecord(record: LogRecord, config?: RedactConfig): LogRecord {
  if (config === false) return record;

  const fieldKeys = new Set(DEFAULT_FIELD_KEYS);
  for (const key of config?.fields ?? []) {
    fieldKeys.add(key.toLowerCase());
  }

  const patterns = [...DEFAULT_PATTERNS, ...(config?.patterns ?? [])];
  const out: LogRecord = {};

  for (const [key, value] of Object.entries(record)) {
    out[key] = redactValue(value, key, fieldKeys, patterns);
  }

  return out;
}
