import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("gitignore", () => {
  it("ignores node_modules and dist", () => {
    const content = readFileSync(path.join(repoRoot, ".gitignore"), "utf8");
    const lines = content.split("\n");

    expect(lines.some((line) => line.includes("node_modules"))).toBe(true);
    expect(lines.some((line) => line.includes("dist"))).toBe(true);
  });
});
