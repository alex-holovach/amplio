import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathExists } from "./fs.js";

export type Formatter = "biome" | "prettier";

const PRETTIER_CONFIG_FILES = [
  ".prettierrc",
  ".prettierrc.json",
  ".prettierrc.yml",
  ".prettierrc.yaml",
  ".prettierrc.js",
  ".prettierrc.cjs",
  ".prettierrc.mjs",
  "prettier.config.js",
  "prettier.config.cjs",
  "prettier.config.mjs",
];

export async function detectFormatter(cwd: string): Promise<Formatter | null> {
  if (
    (await pathExists(path.join(cwd, "biome.json"))) ||
    (await pathExists(path.join(cwd, "biome.jsonc")))
  ) {
    return "biome";
  }

  for (const file of PRETTIER_CONFIG_FILES) {
    if (await pathExists(path.join(cwd, file))) {
      return "prettier";
    }
  }

  const pkgPath = path.join(cwd, "package.json");
  if (await pathExists(pkgPath)) {
    try {
      const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8")) as {
        prettier?: unknown;
      };
      if (pkg.prettier !== undefined) {
        return "prettier";
      }
    } catch {
      // best effort
    }
  }

  return null;
}

async function localBin(cwd: string, name: string): Promise<string | null> {
  const bin = path.join(cwd, "node_modules", ".bin", name);
  return (await pathExists(bin)) ? bin : null;
}

/**
 * Best-effort: run the project's own formatter over freshly generated files so
 * scaffolded code passes the host repo's format/lint gate (tabs vs spaces,
 * import order). Failures are swallowed — generated code is still valid TS.
 */
export async function formatGeneratedFiles(
  cwd: string,
  targets: string[],
): Promise<Formatter | null> {
  const existing: string[] = [];
  for (const target of targets) {
    if (await pathExists(path.join(cwd, target))) {
      existing.push(target);
    }
  }
  if (existing.length === 0) {
    return null;
  }

  const formatter = await detectFormatter(cwd);
  if (formatter === "biome") {
    const bin = await localBin(cwd, "biome");
    if (!bin) {
      return null;
    }
    // check --write applies formatting + import organization; exit code may be
    // non-zero if unrelated diagnostics remain, so ignore it.
    spawnSync(bin, ["check", "--write", ...existing], { cwd, stdio: "ignore" });
    return "biome";
  }

  if (formatter === "prettier") {
    const bin = await localBin(cwd, "prettier");
    if (!bin) {
      return null;
    }
    spawnSync(bin, ["--write", ...existing.map((t) => `${t}`)], {
      cwd,
      stdio: "ignore",
    });
    return "prettier";
  }

  return null;
}
