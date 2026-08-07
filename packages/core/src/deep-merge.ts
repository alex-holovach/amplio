const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  if (Object.keys(patch).length === 0) {
    return base;
  }

  if (Object.keys(base).length === 0) {
    for (const key of Object.keys(patch)) {
      if (patch[key] === undefined) {
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(patch)) {
          const value = patch[k];
          if (value !== undefined) {
            out[k] = value;
          }
        }
        return out;
      }
    }
    return patch;
  }

  let changed = false;
  let out: Record<string, unknown> | null = null;

  for (const key of Object.keys(patch)) {
    const next = patch[key];
    if (next === undefined) {
      continue;
    }
    const prev = base[key];

    if (isPlainObject(prev) && isPlainObject(next)) {
      const merged = deepMerge(prev, next);
      if (merged !== prev) {
        if (out === null) {
          out = { ...base };
        }
        out[key] = merged;
        changed = true;
      }
      continue;
    }

    if (!Object.is(prev, next)) {
      if (out === null) {
        out = { ...base };
      }
      out[key] = next;
      changed = true;
    }
  }

  return changed ? out! : base;
}
