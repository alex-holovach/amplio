import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("ci node version", () => {
  it("uses actions/setup-node with node-version: 22 in ci.yml", () => {
    const ciYaml = readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8");

    expect(ciYaml, "ci.yml must use actions/setup-node").toMatch(/uses:\s*actions\/setup-node@/);

    const nodeVersionMatch = ciYaml.match(/^\s*node-version:\s*([^\s]+)\s*$/m);
    expect(nodeVersionMatch, "ci.yml must set node-version:").not.toBeNull();

    expect(nodeVersionMatch![1]).toBe("22");
  });
});
