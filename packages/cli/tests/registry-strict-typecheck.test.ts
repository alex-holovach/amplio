import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsconfigPath = path.join(cliRoot, "tests/fixtures/registry-strict-tsconfig.json");

describe("registry strict typecheck", () => {
  it("registry sources typecheck under create-t3-app-style strict tsconfig", () => {
    // Covers sinks, middleware, enrichers, events, logger, and the tRPC v11 no-cast
    // fixture (trpc-middleware-types.ts).
    // registry/integrations is excluded: better-auth subpath exports (better-auth/api,
    // better-auth/cookies) do not resolve reliably under path-mapped tsc, and Clerk/
    // Better Auth SDK types fail exactOptionalPropertyTypes without unrelated integration
    // refactors. SDK packages are still listed in @useamplio/cli devDependencies for
    // manual/editor resolution.
    execFileSync(
      "pnpm",
      ["exec", "tsc", "--noEmit", "-p", tsconfigPath],
      {
        cwd: cliRoot,
        stdio: "pipe",
        env: { ...process.env, FORCE_COLOR: "0" },
      },
    );

    expect(true).toBe(true);
  });
});
