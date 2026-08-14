import fs from "node:fs/promises";
import { detectFramework } from "./detect-framework.js";

const STATIC_LOCAL_JS_IMPORT =
  /(^[ \t]*(?:(?:import|export)\b[^;]*?\bfrom\s*|import\s*))(["'])(\.{1,2}\/[^"'\r\n]+)\.js\2/gm;

export async function usesExtensionlessGeneratedImports(
  cwd: string,
): Promise<boolean> {
  return (await detectFramework(cwd)) === "next";
}

/**
 * Registry recipes stay NodeNext-correct at rest. Bundler projects receive the
 * same graph with only generated relative ESM specifiers made extensionless.
 */
export function normalizeGeneratedLocalImports(
  source: string,
  extensionless: boolean,
): string {
  if (!extensionless) return source;
  return source.replace(
    STATIC_LOCAL_JS_IMPORT,
    (_match, prefix: string, quote: string, specifier: string) =>
      `${prefix}${quote}${specifier}${quote}`,
  );
}

export async function normalizeGeneratedFileLocalImports(
  cwd: string,
  filePath: string,
): Promise<boolean> {
  if (!(await usesExtensionlessGeneratedImports(cwd))) return false;
  const source = await fs.readFile(filePath, "utf8");
  const normalized = normalizeGeneratedLocalImports(source, true);
  if (normalized === source) return false;
  await fs.writeFile(filePath, normalized, "utf8");
  return true;
}
