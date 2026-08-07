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
  if (current.includes(exportLine)) {
    return "skipped";
  }

  const next = current.endsWith("\n") ? `${current}${exportLine}\n` : `${current}\n${exportLine}\n`;
  await fs.writeFile(barrelPath, next, "utf8");
  return "updated";
}
