import { execFileSync } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import pkg from "../package.json" with { type: "json" };

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

async function readDeclarationGraph(entry: string): Promise<string> {
  const visited = new Set<string>();
  const declarations: string[] = [];

  async function visit(filePath: string): Promise<void> {
    const resolved = path.resolve(filePath);
    if (visited.has(resolved)) return;
    visited.add(resolved);

    const source = await readFile(resolved, "utf8");
    declarations.push(source);

    for (const match of source.matchAll(
      /(?:from\s+|import\()["'](\.[^"']+)["']/g,
    )) {
      const specifier = match[1];
      const declarationSpecifier = specifier.endsWith(".js")
        ? `${specifier.slice(0, -3)}.d.ts`
        : specifier;
      await visit(path.resolve(path.dirname(resolved), declarationSpecifier));
    }
  }

  await visit(path.resolve(packageRoot, entry));
  return declarations.join("\n");
}

describe("package files", () => {
  it("declares sideEffects: false for tree-shaking", () => {
    expect(pkg.sideEffects).toBe(false);
  });

  it("declares ESM package entry", () => {
    expect(pkg.type).toBe("module");
    expect(pkg.main).toBe("./dist/index.js");
  });

  it('exports["."] points at dist ESM entry and types', () => {
    const root = pkg.exports["."];
    expect(root.import).toBe("./dist/index.js");
    expect(root.types).toBe("./dist/index.d.ts");
  });

  it("publishes Plugin authoring separately and quarantines compatibility under /legacy", () => {
    expect(pkg.exports).not.toHaveProperty("./events");
    expect(pkg.exports).toHaveProperty("./plugin");
    expect(pkg.exports).toHaveProperty("./legacy");
  });

  it("does not build the removed events subpath", async () => {
    const distFiles = await readdir(path.join(packageRoot, "dist"));
    expect(distFiles.filter((file) => /^events(?:\.|$)/.test(file))).toEqual([]);
  });

  it("keeps legacy logger declarations out of the main declaration graph", async () => {
    const mainGraph = await readDeclarationGraph("dist/index.d.ts");
    expect(mainGraph).not.toMatch(
      /\b(?:RequestLoggerOptions|LoggerFacade|EventLogger|LegacySink|LogRecord|EventShape|AmplioConfig|Enricher|createLogger|createRequestLogger|getLogger|useLogger|runWithLogger|canonicalKeyOnly)\b/,
    );
    expect(mainGraph).not.toMatch(/\binterface\s+Logger\b/);
    expect(mainGraph).not.toMatch(/^\s*(?:set|emit)\s*\(/m);

    const legacyGraph = await readDeclarationGraph("dist/legacy.d.ts");
    expect(legacyGraph).toMatch(/\binterface\s+Logger\b/);
    expect(legacyGraph).toMatch(/^\s*set\s*\(/m);
    expect(legacyGraph).toMatch(/^\s*emit\s*\(/m);
  });

  it('exports["./legacy"] points at the compatibility entry and types', () => {
    const legacy = pkg.exports["./legacy"];
    expect(legacy.import).toBe("./dist/legacy.js");
    expect(legacy.types).toBe("./dist/legacy.d.ts");
  });

  it('exports["./plugin"] points at the open-code authoring entry and types', () => {
    const plugin = pkg.exports["./plugin"];
    expect(plugin.import).toBe("./dist/plugin.js");
    expect(plugin.types).toBe("./dist/plugin.d.ts");
  });

  it("ships dist for published installs", async () => {
    expect(pkg.files).toEqual(["dist", "README.md", "LICENSE", "docs"]);

    for (const entry of pkg.files) {
      await access(path.join(packageRoot, entry));
    }

    const stdout = execFileSync("npm", ["pack", "--json", "--dry-run"], {
      cwd: packageRoot,
      encoding: "utf8",
    });
    const packed = JSON.parse(stdout) as Array<{
      files: Array<{ path: string }>;
    }>;
    const tarballPaths = packed.flatMap((entry) =>
      entry.files.map((file) => file.path),
    );

    expect(
      tarballPaths.some((tarballPath) => tarballPath.startsWith("dist/")),
    ).toBe(true);
    expect(tarballPaths).toContain("LICENSE");
    expect(tarballPaths).toContain("dist/plugin.js");
    expect(tarballPaths).toContain("dist/plugin.d.ts");
    expect(
      tarballPaths.some((tarballPath) => tarballPath.startsWith("docs/")),
    ).toBe(true);

    const forbidden = tarballPaths.filter(
      (tarballPath) =>
        tarballPath.includes(".registry-copy.lock") ||
        tarballPath.includes(".registry-staging-") ||
        tarballPath.endsWith(".lock") ||
        /(^|\/)\.[^/]*-staging-/.test(tarballPath),
    );
    expect(forbidden).toEqual([]);
  });
});
