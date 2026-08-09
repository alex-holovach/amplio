import fs from "node:fs/promises";
import path from "node:path";

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function writeFileIfMissing(
  filePath: string,
  content: string,
): Promise<"created" | "skipped"> {
  if (await pathExists(filePath)) {
    return "skipped";
  }
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, content, "utf8");
  return "created";
}

export async function writeFileOrSkip(
  filePath: string,
  content: string,
  force = false,
): Promise<"created" | "updated" | "skipped"> {
  const exists = await pathExists(filePath);
  if (exists && !force) {
    return "skipped";
  }
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, content, "utf8");
  return exists ? "updated" : "created";
}

function stripEmptyBarrelExport(content: string): string {
  return content
    .split("\n")
    .filter((line) => line.trim() !== "export {};")
    .join("\n")
    .replace(/\n+$/, "");
}

function barrelAlreadyExports(content: string, exportLine: string): boolean {
  if (content.includes(exportLine)) {
    return true;
  }
  // Treat any existing re-export of the same symbol as equivalent, so path
  // style changes (e.g. "./email/index" vs "./email") never create duplicates.
  const nameMatch = /export\s*\{\s*([A-Za-z0-9_$]+)\s*\}/.exec(exportLine);
  const exportedName = nameMatch?.[1];
  if (!exportedName) {
    return false;
  }
  return new RegExp(`export\\s*\\{[^}]*\\b${exportedName}\\b`).test(content);
}

const COALESCE_EXPORT_RE = /^\s*export\s*\{([^}]*)\}\s*from\s*(["'])(\.[^"']*)\2;?\s*$/;

/**
 * Merge repeated `export { A } from "./m";` statements pointing at the same
 * module into one `export { A, B } from "./m";`. The first statement keeps its
 * position; later duplicates are dropped. Non-export lines are untouched.
 */
export function coalesceBarrelExports(content: string): string {
  const lines = content.split("\n");
  const slotBySpecifier = new Map<string, number>();
  const entriesBySpecifier = new Map<string, string[]>();
  const out: (string | null)[] = [];
  let changed = false;

  for (const line of lines) {
    const match = COALESCE_EXPORT_RE.exec(line);
    if (!match) {
      out.push(line);
      continue;
    }
    const specifier = match[3]!;
    const entries = match[1]!
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);

    const existing = entriesBySpecifier.get(specifier);
    if (existing === undefined) {
      slotBySpecifier.set(specifier, out.length);
      entriesBySpecifier.set(specifier, entries);
      out.push(null);
      continue;
    }

    changed = true;
    for (const entry of entries) {
      if (!existing.includes(entry)) {
        existing.push(entry);
      }
    }
  }

  if (!changed) {
    return content;
  }

  for (const [specifier, slot] of slotBySpecifier) {
    const entries = entriesBySpecifier.get(specifier)!;
    out[slot] = `export { ${entries.join(", ")} } from "${specifier}";`;
  }

  return out.filter((line): line is string => line !== null).join("\n");
}

export async function upsertBarrelExport(
  barrelPath: string,
  exportLine: string,
): Promise<"created" | "updated" | "skipped"> {
  const exists = await pathExists(barrelPath);
  if (!exists) {
    await ensureDir(path.dirname(barrelPath));
    await fs.writeFile(barrelPath, `${exportLine}\n`, "utf8");
    return "created";
  }

  const current = await fs.readFile(barrelPath, "utf8");
  if (barrelAlreadyExports(current, exportLine)) {
    return "skipped";
  }

  const cleaned = stripEmptyBarrelExport(current);
  const appended = cleaned
    ? cleaned.endsWith("\n")
      ? `${cleaned}${exportLine}\n`
      : `${cleaned}\n${exportLine}\n`
    : `${exportLine}\n`;
  // Merge into an existing statement for the same module instead of
  // accumulating one export line per event.
  await fs.writeFile(barrelPath, coalesceBarrelExports(appended), "utf8");
  return "updated";
}
