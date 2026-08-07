import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("editorconfig", () => {
  it("sets indent_size = 2 and insert_final_newline = true for *.{ts,...}", () => {
    const content = readFileSync(path.join(repoRoot, ".editorconfig"), "utf8");

    const sectionMatch = content.match(
      /^\[\*\.\{ts,[^\]]*\}]\n([\s\S]*?)(?=^\[|(?![\s\S]))/m,
    );
    expect(sectionMatch, "must have *.{ts,...} section").not.toBeNull();

    const sectionBody = sectionMatch![1];
    expect(sectionBody).toMatch(/^\s*indent_size\s*=\s*2\s*$/m);
    expect(sectionBody).toMatch(/^\s*insert_final_newline\s*=\s*true\s*$/m);
  });
});
