import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("prettierrc", () => {
  it("sets tabWidth = 2 and printWidth = 80", () => {
    const content = readFileSync(path.join(repoRoot, ".prettierrc"), "utf8");
    const config = JSON.parse(content) as { tabWidth?: number; printWidth?: number };

    expect(config.tabWidth).toBe(2);
    expect(config.printWidth).toBe(80);
  });
});
