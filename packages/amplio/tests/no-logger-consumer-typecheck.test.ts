import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const packageRoot = path.resolve(import.meta.dirname, "..");
const fixtureConfig = path.join(
  packageRoot,
  "tests/fixtures/no-logger-consumer/tsconfig.json",
);
const builtFixtureConfig = path.join(
  packageRoot,
  "tests/fixtures/built-consumer/tsconfig.json",
);

describe("no-logger consumer types", () => {
  it("typechecks as a strict consumer project", () => {
    execFileSync("pnpm", ["exec", "tsc", "-p", fixtureConfig], {
      cwd: packageRoot,
      env: { ...process.env, FORCE_COLOR: "0" },
      stdio: "pipe",
    });

    expect(true).toBe(true);
  });

  it("preserves generic inference through the built declaration surface", () => {
    execFileSync("pnpm", ["exec", "tsc", "-p", builtFixtureConfig], {
      cwd: packageRoot,
      env: { ...process.env, FORCE_COLOR: "0" },
      stdio: "pipe",
    });

    expect(true).toBe(true);
  });
});
