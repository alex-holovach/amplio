import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const cliRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const tsconfigPath = path.join(
  cliRoot,
  "tests/fixtures/registry-strict-tsconfig.json",
);

describe("registry strict typecheck", () => {
  it("registry sources typecheck under create-t3-app-style strict tsconfig", () => {
    // Exercises only the public main + /plugin vNext entrypoints across Events,
    // Plugins, sinks, enrichers, and the shared runtime. /legacy is deliberately
    // absent from the path map so recipes cannot regress to the alpha API.
    execFileSync("pnpm", ["exec", "tsc", "--noEmit", "-p", tsconfigPath], {
      cwd: cliRoot,
      stdio: "pipe",
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    expect(true).toBe(true);
  });
});
