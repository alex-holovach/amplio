import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";

const exists = async (filePath: string): Promise<boolean> =>
  access(filePath).then(
    () => true,
    () => false,
  );

describe.sequential("init transaction", () => {
  it("restores package.json and lockfiles when the CLI dependency phase fails", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-init-transaction-"));
    const packagePath = path.join(cwd, "package.json");
    const beforePackage = `${JSON.stringify(
      { name: "transaction-fixture", private: true, dependencies: {} },
      null,
      2,
    )}\n`;
    await writeFile(packagePath, beforePackage);

    const bin = path.join(cwd, "fake-bin");
    await mkdir(bin, { recursive: true });
    const npm = path.join(bin, "npm");
    await writeFile(
      npm,
      `#!/bin/sh
if printf '%s' "$*" | grep -q '@useamplio/cli'; then
  printf '{"lockfileVersion":3,"phase":"cli"}\n' > package-lock.json
  exit 31
fi
node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync("package.json","utf8"));p.dependencies={...p.dependencies,"@useamplio/amplio":"^0.1.0-alpha.17",zod:"^3.24.0"};fs.writeFileSync("package.json",JSON.stringify(p,null,2)+"\\n")'
printf '{"lockfileVersion":3,"phase":"runtime"}\n' > package-lock.json
`,
    );
    await chmod(npm, 0o755);

    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
    try {
      await expect(runInit({ cwd, packageManager: "npm" })).rejects.toThrow(
        "Runtime dependencies are not installed; init aborted before writing files.",
      );
    } finally {
      process.env.PATH = previousPath;
    }

    expect(await readFile(packagePath, "utf8")).toBe(beforePackage);
    expect(await exists(path.join(cwd, "package-lock.json"))).toBe(false);
    expect(await exists(path.join(cwd, "amplio.json"))).toBe(false);
    expect(await exists(path.join(cwd, "telemetry"))).toBe(false);
  });

  it("restores package and workspace lock changes when a later init write fails", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "amplio-init-workspace-transaction-"),
    );
    const cwd = path.join(workspace, "apps", "web");
    await mkdir(cwd, { recursive: true });
    await writeFile(
      path.join(workspace, "pnpm-workspace.yaml"),
      'packages:\n  - "apps/*"\n',
    );
    const lockPath = path.join(workspace, "pnpm-lock.yaml");
    const beforeLock = "lockfileVersion: '9.0'\nmarker: before\n";
    await writeFile(lockPath, beforeLock);
    const packagePath = path.join(cwd, "package.json");
    const beforePackage = `${JSON.stringify(
      { name: "workspace-app", private: true, dependencies: {} },
      null,
      2,
    )}\n`;
    await writeFile(packagePath, beforePackage);
    await mkdir(path.join(cwd, "amplio.json"));

    const bin = path.join(workspace, "fake-bin");
    await mkdir(bin, { recursive: true });
    const pnpm = path.join(bin, "pnpm");
    await writeFile(
      pnpm,
      `#!/bin/sh
node - "$*" <<'NODE'
const fs = require("fs");
const args = process.argv[2];
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
if (args.includes("@useamplio/cli")) {
  pkg.devDependencies = { ...pkg.devDependencies, "@useamplio/cli": "0.1.0-alpha.17" };
} else {
  pkg.dependencies = { ...pkg.dependencies, "@useamplio/amplio": "^0.1.0-alpha.17", zod: "^3.24.0" };
}
fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\\n");
fs.writeFileSync("../../pnpm-lock.yaml", "lockfileVersion: '9.0'\\nmarker: changed\\n");
NODE
`,
    );
    await chmod(pnpm, 0o755);

    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
    try {
      await expect(runInit({ cwd, packageManager: "pnpm" })).rejects.toThrow();
    } finally {
      process.env.PATH = previousPath;
    }

    expect(await readFile(packagePath, "utf8")).toBe(beforePackage);
    expect(await readFile(lockPath, "utf8")).toBe(beforeLock);
  });
});
