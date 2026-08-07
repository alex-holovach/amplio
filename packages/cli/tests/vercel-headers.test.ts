import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

type VercelHeaderRule = {
  source: string;
  headers: Array<{ key: string; value: string }>;
};

type VercelConfig = {
  headers?: VercelHeaderRule[];
};

describe("vercel headers", () => {
  it("sets Access-Control-Allow-Origin on /r/(.*)", async () => {
    const vercelJsonPath = path.join(repoRoot, "vercel.json");
    const parsed = JSON.parse(await readFile(vercelJsonPath, "utf8")) as VercelConfig;

    const registryRule = parsed.headers?.find((rule) => rule.source === "/r/(.*)");
    expect(registryRule).toBeDefined();

    const corsHeader = registryRule!.headers.find(
      (header) => header.key === "Access-Control-Allow-Origin",
    );
    expect(corsHeader).toBeDefined();
    expect(corsHeader!.value).toBe("*");
  });
});
