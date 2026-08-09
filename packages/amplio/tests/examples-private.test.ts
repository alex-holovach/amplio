import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("examples private flag", () => {
  it("each example package.json has private: true", () => {
    const examplesDir = path.join(repoRoot, "examples");
    const exampleDirs = readdirSync(examplesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    expect(exampleDirs.length).toBeGreaterThanOrEqual(1);

    for (const dir of exampleDirs) {
      const pkgPath = path.join(examplesDir, dir, "package.json");
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { private?: boolean };
      expect(pkg.private, `${dir}/package.json`).toBe(true);
    }
  });
});
