import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectPackageManager } from "../src/utils/detect-package-manager.js";

async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

describe("detectPackageManager", () => {
  it("reads packageManager field from package.json", async () => {
    const cwd = await makeTempDir("amplio-pm-field-");
    await writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({ packageManager: "npm@10.9.7" }),
    );
    expect(await detectPackageManager(cwd)).toBe("npm");
  });

  it("detects npm from package-lock.json", async () => {
    const cwd = await makeTempDir("amplio-pm-lock-npm-");
    await writeFile(path.join(cwd, "package-lock.json"), "{}");
    expect(await detectPackageManager(cwd)).toBe("npm");
  });

  it("detects pnpm from pnpm-lock.yaml", async () => {
    const cwd = await makeTempDir("amplio-pm-lock-pnpm-");
    await writeFile(path.join(cwd, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
    expect(await detectPackageManager(cwd)).toBe("pnpm");
  });

  it("defaults to pnpm when nothing matches", async () => {
    const cwd = await makeTempDir("amplio-pm-default-");
    expect(await detectPackageManager(cwd)).toBe("pnpm");
  });
});
