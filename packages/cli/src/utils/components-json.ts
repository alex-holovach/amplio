import fs from "node:fs/promises";
import path from "node:path";
import { detectFramework } from "./detect-framework.js";
import { pathExists } from "./fs.js";
import { parseJsonc } from "./jsonc.js";

type PathAlias = { prefix: string; pattern: string };

const DEFAULT_ALIAS_PREFIX = "@";

const TAILWIND_CONFIG_CANDIDATES = [
  "tailwind.config.ts",
  "tailwind.config.js",
  "tailwind.config.mjs",
  "tailwind.config.cjs",
];

const TAILWIND_CSS_CANDIDATES = [
  "src/app/globals.css",
  "app/globals.css",
  "src/styles/globals.css",
  "styles/globals.css",
  "src/index.css",
];

function aliasesFromPrefix(prefix: string) {
  const base = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return {
    components: `${base}/components`,
    utils: `${base}/lib/utils`,
    ui: `${base}/components/ui`,
    lib: `${base}/lib`,
    hooks: `${base}/hooks`,
  };
}

function pickPathAlias(paths: Record<string, string[]> | undefined): PathAlias | null {
  if (!paths) {
    return null;
  }

  const wildcardEntries = Object.entries(paths).filter(([pattern]) => pattern.endsWith("/*"));
  if (wildcardEntries.length === 0) {
    return null;
  }

  const preferred = wildcardEntries.find(([pattern]) => pattern === "@/*");
  const [pattern] = preferred ?? wildcardEntries[0]!;
  const prefix = pattern.slice(0, -2);
  if (!prefix) {
    return null;
  }

  return { prefix, pattern };
}

async function readTsconfigPaths(cwd: string): Promise<PathAlias | null> {
  const tsconfigPath = path.join(cwd, "tsconfig.json");
  if (!(await pathExists(tsconfigPath))) {
    return null;
  }

  try {
    const raw = await fs.readFile(tsconfigPath, "utf8");
    const config = parseJsonc<{ compilerOptions?: { paths?: Record<string, string[]> } }>(raw);
    return pickPathAlias(config.compilerOptions?.paths);
  } catch {
    return null;
  }
}

async function firstExistingRelative(cwd: string, candidates: string[]): Promise<string> {
  for (const candidate of candidates) {
    if (await pathExists(path.join(cwd, candidate))) {
      return candidate;
    }
  }
  return "";
}

export async function deriveComponentsJsonOptions(cwd: string, registryUrl: string) {
  const alias = (await readTsconfigPaths(cwd))?.prefix ?? DEFAULT_ALIAS_PREFIX;
  const framework = await detectFramework(cwd);
  const hasTsconfig = await pathExists(path.join(cwd, "tsconfig.json"));

  return {
    $schema: "https://ui.shadcn.com/schema.json",
    style: "new-york",
    rsc: framework === "next",
    tsx: hasTsconfig ? true : true,
    tailwind: {
      config: await firstExistingRelative(cwd, TAILWIND_CONFIG_CANDIDATES),
      css: await firstExistingRelative(cwd, TAILWIND_CSS_CANDIDATES),
      baseColor: "neutral",
      cssVariables: true,
    },
    aliases: aliasesFromPrefix(alias),
    registries: {
      "@useamplio": registryUrl,
    },
  };
}

export async function upsertComponentsJson(
  cwd: string,
  registryUrl: string,
): Promise<"created" | "updated" | "skipped"> {
  const componentsPath = path.join(cwd, "components.json");

  if (!(await pathExists(componentsPath))) {
    const config = await deriveComponentsJsonOptions(cwd, registryUrl);
    await fs.writeFile(componentsPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    return "created";
  }

  const raw = await fs.readFile(componentsPath, "utf8");
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error("components.json exists but is not valid JSON.");
  }

  const registries =
    parsed.registries && typeof parsed.registries === "object"
      ? { ...(parsed.registries as Record<string, string>) }
      : {};

  if (registries["@useamplio"] === registryUrl) {
    return "skipped";
  }

  registries["@useamplio"] = registryUrl;
  parsed.registries = registries;

  await fs.writeFile(componentsPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  return "updated";
}

export function aliasPrefixFromComponentsJson(components: {
  aliases?: Record<string, string>;
}): string | null {
  const componentsAlias = components.aliases?.components;
  if (!componentsAlias) {
    return null;
  }
  const slash = componentsAlias.lastIndexOf("/");
  return slash > 0 ? componentsAlias.slice(0, slash) : componentsAlias;
}
