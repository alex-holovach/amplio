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
  const next = cleaned
    ? cleaned.endsWith("\n")
      ? `${cleaned}${exportLine}\n`
      : `${cleaned}\n${exportLine}\n`
    : `${exportLine}\n`;
  await fs.writeFile(barrelPath, next, "utf8");
  return "updated";
}
