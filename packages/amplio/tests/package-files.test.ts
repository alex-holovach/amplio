import { execFileSync } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import pkg from "../package.json" with { type: "json" };

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

  it('exports["./events"] points at dist ESM entry and types', () => {
    const events = pkg.exports["./events"];
    expect(events.import).toBe("./dist/events.js");
    expect(events.types).toBe("./dist/events.d.ts");
  });

  it("ships dist for published installs", async () => {
    expect(pkg.files).toEqual(["dist", "README.md", "LICENSE", "ALPHA.md", "docs"]);

    for (const entry of pkg.files) {
      await access(path.join(packageRoot, entry));
    }

    const stdout = execFileSync("npm", ["pack", "--json", "--dry-run"], {
      cwd: packageRoot,
      encoding: "utf8",
    });
    const packed = JSON.parse(stdout) as Array<{ files: Array<{ path: string }> }>;
    const tarballPaths = packed.flatMap((entry) => entry.files.map((file) => file.path));

    expect(tarballPaths.some((tarballPath) => tarballPath.startsWith("dist/"))).toBe(true);
    expect(tarballPaths).toContain("LICENSE");
    expect(tarballPaths).toContain("ALPHA.md");
    expect(tarballPaths.some((tarballPath) => tarballPath.startsWith("docs/"))).toBe(true);

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
