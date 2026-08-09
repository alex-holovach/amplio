import { execFileSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import pkg from "../package.json" with { type: "json" };

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("package files", () => {
  it("ships dist + bundled registry for published installs", async () => {
    expect(pkg.type).toBe("module");
    expect(pkg.bin.amplio).toBe("./dist/cli.js");
    expect(pkg.files).toEqual(["dist", "registry", "README.md", "LICENSE", "ALPHA.md", "docs"]);

    for (const entry of pkg.files) {
      await access(path.join(packageRoot, entry));
    }

    const registryJson = path.join(packageRoot, "registry/registry.json");
    await access(registryJson);
    const parsed = JSON.parse(await readFile(registryJson, "utf8"));
    expect(Array.isArray(parsed.items)).toBe(true);
    expect(parsed.items.length).toBeGreaterThan(0);

    const stdout = execFileSync("npm", ["pack", "--json", "--dry-run"], {
      cwd: packageRoot,
      encoding: "utf8",
    });
    const packed = JSON.parse(stdout) as Array<{ files: Array<{ path: string }> }>;
    const tarballPaths = packed.flatMap((entry) => entry.files.map((file) => file.path));
    const forbidden = tarballPaths.filter(
      (tarballPath) =>
        tarballPath.includes(".registry-copy.lock") ||
        tarballPath.includes(".registry-staging-"),
    );
    expect(forbidden).toEqual([]);
    expect(tarballPaths).toContain("LICENSE");
    expect(tarballPaths).toContain("ALPHA.md");
    expect(tarballPaths.some((tarballPath) => tarballPath.startsWith("docs/"))).toBe(true);
  });
});
