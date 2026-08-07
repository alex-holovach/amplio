import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("pnpm workspace", () => {
  it("includes packages/* and examples/* in root pnpm-workspace.yaml", () => {
    const workspacePath = path.join(repoRoot, "pnpm-workspace.yaml");
    const content = readFileSync(workspacePath, "utf8");

    const packages = [...content.matchAll(/^\s*-\s*"([^"]+)"/gm)].map((match) => match[1]);

    expect(packages).toContain("packages/*");
    expect(packages).toContain("examples/*");
  });
});
