import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const nextMiddlewarePath = path.resolve(
  import.meta.dirname,
  "../../../registry/middleware/next.ts",
);

describe("registry Next middleware ALS", () => {
  it("does not use module-scoped activeLogger; useRequestLogger delegates to useLogger", () => {
    const source = readFileSync(nextMiddlewarePath, "utf8");
    expect(source).not.toMatch(/\bactiveLogger\b/);
    expect(source).toMatch(/useLogger/);
    expect(source).toMatch(
      /export function useRequestLogger\(\)[\s\S]*return useLogger\(\)/,
    );
  });
});
