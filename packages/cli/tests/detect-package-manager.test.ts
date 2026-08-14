import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  detectPackageManager,
  packageManagerLockfiles,
} from "../src/utils/detect-package-manager.js";

async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

describe("detectPackageManager", () => {
  it("rejects an unsupported injected package manager before lockfile discovery", () => {
    expect(() =>
      packageManagerLockfiles("amplio-test-missing-package-manager" as "pnpm"),
    ).toThrow(
      /dependencies.*aborted before writing.*unsupported package manager/i,
    );
  });

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

  it("uses the nearest workspace ancestor package manager", async () => {
    const root = await makeTempDir("amplio-pm-workspace-");
    const cwd = path.join(root, "apps/api");
    await mkdir(cwd, { recursive: true });
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        packageManager: "npm@10.9.7",
        workspaces: ["apps/*"],
      }),
    );
    await writeFile(path.join(root, "package-lock.json"), "{}");
    await writeFile(path.join(cwd, "package.json"), '{"name":"api"}\n');

    expect(await detectPackageManager(cwd)).toBe("npm");
  });
});
