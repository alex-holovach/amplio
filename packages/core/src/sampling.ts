import type { JsonValue, KeepRule, LogRecord, SamplingConfig } from "./types.js";

const getPath = (record: LogRecord, path: string): JsonValue | undefined => {
  const parts = path.split(".");
  let current: JsonValue | undefined = record as JsonValue;

  for (const part of parts) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, JsonValue>)[part];
  }

  return current;
};

const matchesKeepRule = (record: LogRecord, rule: KeepRule): boolean => {
  const value = getPath(record, rule.field);
  if (value === undefined) {
    return false;
  }

  if (rule.equals !== undefined) {
    return Object.is(value, rule.equals);
  }

  if (rule.matches !== undefined && typeof value === "string") {
    return rule.matches.test(value);
  }

  const hasGte = rule.gte !== undefined;
  const hasLte = rule.lte !== undefined;
  if ((hasGte || hasLte) && typeof value === "number") {
    if (hasGte && value < rule.gte!) return false;
    if (hasLte && value > rule.lte!) return false;
    return hasGte || hasLte;
  }
  return false;
};

export function shouldSample(record: LogRecord, config?: SamplingConfig): boolean {
  if (!config) {
    return true;
  }

  for (const rule of config.keep ?? []) {
    if (matchesKeepRule(record, rule)) {
      return true;
    }
  }

  const rate = config.rate ?? 1;
  if (rate >= 1) {
    return true;
  }
  if (rate <= 0) {
    return false;
  }

  const seed = hashRecord(record);
  return seed < rate;
}

const hashRecord = (record: LogRecord): number => {
  const key = `${record.event ?? ""}:${record.request_id ?? ""}:${record.timestamp ?? ""}`;
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967296;
};
