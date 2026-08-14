import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const ordinaryApplicationFiles = [
  "examples/basic/src/app.ts",
  "examples/basic/src/signup.ts",
  "examples/express-smoke/src/app.ts",
  "examples/express-smoke/src/auth.ts",
  "examples/fastify-smoke/src/app.ts",
  "examples/standalone/src/reconcile.ts",
];

describe("example application boundaries", () => {
  it.each(ordinaryApplicationFiles)(
    "keeps %s free of telemetry mechanism",
    async (relative) => {
      const source = await readFile(path.join(repoRoot, relative), "utf8");

      expect(source).not.toMatch(/@useamplio|(?:^|["'/])telemetry(?:["'/]|$)/m);
      expect(source).not.toMatch(/\b(?:getLogger|useLogger|logger)\b/);
      expect(source).not.toMatch(/\.(?:set|emit|capture)\s*\(/);
    },
  );
});
