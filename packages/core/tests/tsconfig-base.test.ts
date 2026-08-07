import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("tsconfig.base.json", () => {
  it("sets strict = true and target = ES2022", () => {
    const content = readFileSync(path.join(repoRoot, "tsconfig.base.json"), "utf8");
    const config = JSON.parse(content) as {
      compilerOptions?: { strict?: boolean; target?: string };
    };

    expect(config.compilerOptions?.strict).toBe(true);
    expect(config.compilerOptions?.target).toBe("ES2022");
  });
});
