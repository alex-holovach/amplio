import fs from "node:fs/promises";
import path from "node:path";
import { pathExists } from "./fs.js";
import { parseJsonc } from "./jsonc.js";

export function printTsconfigPathsHint(): void {
  console.log(
    "\nOptional: add to tsconfig.json compilerOptions.paths for shorter imports:",
  );
  console.log('  "~telemetry/*": ["./telemetry/*"]');
  console.log(
    '  Then import from "~telemetry/plugins/next" instead of relative paths.',
  );
  console.log("  Or run: amplio paths");
}

function tsconfigHasTelemetryAlias(raw: string, telemetryDir: string): boolean {
  try {
    const config = parseJsonc<{
      compilerOptions?: { paths?: Record<string, string[]> };
    }>(raw);
    const paths = config.compilerOptions?.paths ?? {};
    return paths["~telemetry/*"]?.includes(`./${telemetryDir}/*`) ?? false;
  } catch {
    return false;
  }
}

function detectEntryIndent(source: string, braceIndex: number): string {
  const afterBrace = source.slice(braceIndex + 1);
  const lineMatch = /^\s*\n(\s+)\S/.exec(afterBrace);
  return lineMatch?.[1] ?? "    ";
}

/** "," when the object already has entries after the insert point; "" when the
 * inserted entry would be the last one (a trailing comma is invalid JSON). */
function separatorAfterInsert(source: string, braceIndex: number): string {
  const nextNonWhitespace = /^\s*(\S)/.exec(source.slice(braceIndex + 1))?.[1];
  return nextNonWhitespace === "}" ? "" : ",";
}

export async function applyTsconfigPathsAlias(
  cwd: string,
  telemetryDir: string,
): Promise<"success" | "already" | "missing" | "failed"> {
  const tsconfigPath = path.join(cwd, "tsconfig.json");
  if (!(await pathExists(tsconfigPath))) {
    return "missing";
  }

  const raw = await fs.readFile(tsconfigPath, "utf8");
  if (tsconfigHasTelemetryAlias(raw, telemetryDir)) {
    return "already";
  }

  const aliasEntry = `"~telemetry/*": ["./${telemetryDir}/*"]`;
  let edited: string;

  const pathsKeyMatch = /(["'])paths\1\s*:\s*\{/.exec(raw);
  if (pathsKeyMatch && pathsKeyMatch.index !== undefined) {
    const braceIndex = raw.indexOf("{", pathsKeyMatch.index);
    const entryIndent = detectEntryIndent(raw, braceIndex);
    const insert = `\n${entryIndent}${aliasEntry}${separatorAfterInsert(raw, braceIndex)}`;
    edited = raw.slice(0, braceIndex + 1) + insert + raw.slice(braceIndex + 1);
  } else {
    const compilerOptionsMatch = /(["'])compilerOptions\1\s*:\s*\{/.exec(raw);
    if (!compilerOptionsMatch || compilerOptionsMatch.index === undefined) {
      return "failed";
    }
    const braceIndex = raw.indexOf("{", compilerOptionsMatch.index);
    const entryIndent = detectEntryIndent(raw, braceIndex);
    const pathsBlock = `\n${entryIndent}"paths": {\n${entryIndent}  ${aliasEntry}\n${entryIndent}}${separatorAfterInsert(raw, braceIndex)}`;
    edited =
      raw.slice(0, braceIndex + 1) + pathsBlock + raw.slice(braceIndex + 1);
  }

  try {
    const config = parseJsonc<{
      compilerOptions?: { paths?: Record<string, string[]> };
    }>(edited);
    const paths = config.compilerOptions?.paths ?? {};
    if (!paths["~telemetry/*"]?.includes(`./${telemetryDir}/*`)) {
      return "failed";
    }
  } catch {
    return "failed";
  }

  await fs.writeFile(tsconfigPath, edited, "utf8");
  return "success";
}

export async function writeTsconfigPathsAlias(
  cwd: string,
  telemetryDir: string,
): Promise<void> {
  const result = await applyTsconfigPathsAlias(cwd, telemetryDir);
  if (result === "success") {
    console.log("  ✓ tsconfig.json (~telemetry/* path alias)");
    return;
  }
  if (result === "already") {
    console.log("  · tsconfig.json already has ~telemetry/*");
    return;
  }
  if (result === "missing") {
    console.log("\ntsconfig.json not found — skipped path alias.");
    printTsconfigPathsHint();
    return;
  }
  printTsconfigPathsHint();
}
