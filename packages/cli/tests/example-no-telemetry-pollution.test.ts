import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const ORDINARY_APP_AND_DOMAIN_FILES = [
  "examples/basic/src/app.ts",
  "examples/basic/src/signup.ts",
  "examples/express-smoke/src/app.ts",
  "examples/express-smoke/src/auth.ts",
  "examples/fastify-smoke/src/app.ts",
  "examples/standalone/src/reconcile.ts",
] as const;

describe("example application/domain boundaries", () => {
  it.each(ORDINARY_APP_AND_DOMAIN_FILES)(
    "keeps %s free of telemetry manipulation",
    async (file) => {
      const source = await readFile(path.join(repoRoot, file), "utf8");

      expect(source).not.toMatch(/@useamplio|(?:^|\/)telemetry\//m);
      expect(source).not.toMatch(
        /\b(?:getLogger|useLogger|createRequestLogger|defineFact|defineOperation|defineWorkload)\b|\.(?:set|emit|capture)\s*\(/,
      );
    },
  );
});
