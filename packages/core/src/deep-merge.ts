const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  let changed = false;
  const out: Record<string, unknown> = { ...base };

  for (const key of Object.keys(patch)) {
    const next = patch[key];
    if (next === undefined) {
      continue;
    }
    const prev = out[key];

    if (isPlainObject(prev) && isPlainObject(next)) {
      const merged = deepMerge(prev, next);
      if (merged !== prev) {
        out[key] = merged;
        changed = true;
      }
      continue;
    }

    if (!Object.is(prev, next)) {
      out[key] = next;
      changed = true;
    }
  }

  return changed ? out : base;
}
