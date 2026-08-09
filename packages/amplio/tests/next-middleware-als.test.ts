import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const nextMiddlewarePath = path.resolve(
  import.meta.dirname,
  "../../../registry/middleware/next.ts",
);

describe("registry Next middleware ALS", () => {
  it("does not use module-scoped activeLogger; getRequestLogger delegates to getLogger", () => {
    const source = readFileSync(nextMiddlewarePath, "utf8");
    expect(source).not.toMatch(/\bactiveLogger\b/);
    expect(source).toMatch(/getLogger/);
    expect(source).toMatch(
      /export function getRequestLogger\(\)[\s\S]*return getLogger\(\)/,
    );
    // Fresh scaffolds must not ship the deprecated pre-rename alias — it only
    // ever existed for upgraders, and nobody has imported it from a new file.
    expect(source).not.toMatch(/useRequestLogger/);
  });
});
