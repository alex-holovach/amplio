export interface MergeConflict {
  baseStart: number;
  baseEnd: number;
}

export type ThreeWayMergeResult =
  { ok: true; content: string } | { ok: false; conflicts: MergeConflict[] };

interface Hunk {
  baseStart: number;
  baseEnd: number;
  replacement: string[];
}

function lines(source: string): string[] {
  return source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function diffHunks(base: string[], changed: string[]): Hunk[] {
  const rows: Uint32Array[] = Array.from(
    { length: base.length + 1 },
    () => new Uint32Array(changed.length + 1),
  );
  for (let left = base.length - 1; left >= 0; left -= 1) {
    for (let right = changed.length - 1; right >= 0; right -= 1) {
      rows[left]![right] =
        base[left] === changed[right]
          ? rows[left + 1]![right + 1]! + 1
          : Math.max(rows[left + 1]![right]!, rows[left]![right + 1]!);
    }
  }

  const hunks: Hunk[] = [];
  let left = 0;
  let right = 0;
  let active: Hunk | undefined;
  const begin = (): Hunk => {
    active ??= { baseStart: left, baseEnd: left, replacement: [] };
    return active;
  };
  const finish = (): void => {
    if (active) hunks.push(active);
    active = undefined;
  };

  while (left < base.length || right < changed.length) {
    if (
      left < base.length &&
      right < changed.length &&
      base[left] === changed[right]
    ) {
      finish();
      left += 1;
      right += 1;
      continue;
    }
    if (
      right < changed.length &&
      (left === base.length ||
        rows[left]![right + 1]! > rows[left + 1]![right]!)
    ) {
      begin().replacement.push(changed[right]!);
      right += 1;
      continue;
    }
    begin().baseEnd += 1;
    left += 1;
  }
  finish();
  return hunks;
}

function sameHunk(left: Hunk, right: Hunk): boolean {
  return (
    left.baseStart === right.baseStart &&
    left.baseEnd === right.baseEnd &&
    left.replacement.join("") === right.replacement.join("")
  );
}

function overlaps(left: Hunk, right: Hunk): boolean {
  const leftInsertion = left.baseStart === left.baseEnd;
  const rightInsertion = right.baseStart === right.baseEnd;
  if (leftInsertion && rightInsertion) {
    return left.baseStart === right.baseStart;
  }
  if (leftInsertion) {
    return left.baseStart >= right.baseStart && left.baseStart <= right.baseEnd;
  }
  if (rightInsertion) {
    return right.baseStart >= left.baseStart && right.baseStart <= left.baseEnd;
  }
  return (
    Math.max(left.baseStart, right.baseStart) <
    Math.min(left.baseEnd, right.baseEnd)
  );
}

export function threeWayMerge(
  baseSource: string,
  localSource: string,
  incomingSource: string,
): ThreeWayMergeResult {
  if (localSource === baseSource) return { ok: true, content: incomingSource };
  if (incomingSource === baseSource) return { ok: true, content: localSource };
  if (localSource === incomingSource) return { ok: true, content: localSource };

  const base = lines(baseSource);
  const local = diffHunks(base, lines(localSource));
  const incoming = diffHunks(base, lines(incomingSource));
  const conflicts: MergeConflict[] = [];
  for (const localHunk of local) {
    for (const incomingHunk of incoming) {
      if (
        !sameHunk(localHunk, incomingHunk) &&
        overlaps(localHunk, incomingHunk)
      ) {
        conflicts.push({
          baseStart: Math.min(localHunk.baseStart, incomingHunk.baseStart),
          baseEnd: Math.max(localHunk.baseEnd, incomingHunk.baseEnd),
        });
      }
    }
  }
  if (conflicts.length > 0) return { ok: false, conflicts };

  const combined = [...local];
  for (const hunk of incoming) {
    if (!combined.some((existing) => sameHunk(existing, hunk)))
      combined.push(hunk);
  }
  combined.sort(
    (left, right) =>
      left.baseStart - right.baseStart || left.baseEnd - right.baseEnd,
  );
  const output: string[] = [];
  let cursor = 0;
  for (const hunk of combined) {
    output.push(...base.slice(cursor, hunk.baseStart), ...hunk.replacement);
    cursor = hunk.baseEnd;
  }
  output.push(...base.slice(cursor));
  return { ok: true, content: output.join("") };
}

export function renderUnifiedDiff(
  baseSource: string,
  changedSource: string,
  labels: { base: string; changed: string },
): string {
  const base = lines(baseSource);
  const hunks = diffHunks(base, lines(changedSource));
  if (hunks.length === 0) return "";
  const output = [`--- ${labels.base}`, `+++ ${labels.changed}`];
  let delta = 0;
  for (const hunk of hunks) {
    const removed = hunk.baseEnd - hunk.baseStart;
    const added = hunk.replacement.length;
    output.push(
      `@@ -${hunk.baseStart + 1},${removed} +${hunk.baseStart + delta + 1},${added} @@`,
    );
    for (const line of base.slice(hunk.baseStart, hunk.baseEnd)) {
      output.push(`-${line.replace(/\n$/, "")}`);
    }
    for (const line of hunk.replacement) {
      output.push(`+${line.replace(/\n$/, "")}`);
    }
    delta += added - removed;
    if (output.length >= 200) {
      output.length = 200;
      output.push("... diff truncated after 200 lines");
      break;
    }
  }
  return output.join("\n");
}
