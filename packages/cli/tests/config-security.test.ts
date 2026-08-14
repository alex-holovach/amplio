import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runAddEvent } from "../src/commands/add.js";
import { runInit } from "../src/commands/init.js";
import { resolveRegistryPath } from "../src/utils/config.js";

const exists = (filePath: string): Promise<boolean> =>
  access(filePath).then(
    () => true,
    () => false,
  );

async function makeProject(): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), "amplio-config-security-"));
  await writeFile(
    path.join(cwd, "package.json"),
    `${JSON.stringify(
      {
        name: "secure-app",
        dependencies: {
          "@useamplio/amplio": "0.1.0-alpha.16",
          zod: "^3.24.2",
        },
      },
      null,
      2,
    )}\n`,
  );
  return cwd;
}

describe("amplio config containment", () => {
  it.each(["../outside", "./telemetry", "telemetry/../outside"])(
    "rejects non-normalized telemetryDir %s before add writes",
    async (telemetryDir) => {
      const cwd = await makeProject();
      const configPath = path.join(cwd, "amplio.json");
      const before = `${JSON.stringify({ telemetryDir }, null, 2)}\n`;
      await writeFile(configPath, before);

      await expect(runAddEvent("order.placed", { cwd })).rejects.toThrow(
        /telemetryDir.*normalized relative path.*no files/i,
      );

      expect(await readFile(configPath, "utf8")).toBe(before);
      expect(await exists(path.join(cwd, "telemetry"))).toBe(false);
      expect(await exists(path.resolve(cwd, telemetryDir))).toBe(false);
    },
  );

  it("rejects an absolute telemetryDir before init mutates the project", async () => {
    const cwd = await makeProject();
    const outside = path.join(path.dirname(cwd), "amplio-absolute-outside");
    const configPath = path.join(cwd, "amplio.json");
    const before = `${JSON.stringify({ telemetryDir: outside }, null, 2)}\n`;
    await writeFile(configPath, before);
    const packageBefore = await readFile(
      path.join(cwd, "package.json"),
      "utf8",
    );

    await expect(
      runInit({ cwd, yes: true, skipInstall: true }),
    ).rejects.toThrow(/telemetryDir.*normalized relative path.*no files/i);

    expect(await readFile(configPath, "utf8")).toBe(before);
    expect(await readFile(path.join(cwd, "package.json"), "utf8")).toBe(
      packageBefore,
    );
    expect(await exists(outside)).toBe(false);
  });

  it("rejects a telemetryDir symlink that resolves outside the project", async () => {
    const cwd = await makeProject();
    const outside = await mkdtemp(
      path.join(tmpdir(), "amplio-config-outside-"),
    );
    await symlink(outside, path.join(cwd, "telemetry"), "dir");
    await writeFile(
      path.join(cwd, "amplio.json"),
      `${JSON.stringify({ telemetryDir: "telemetry" }, null, 2)}\n`,
    );

    await expect(runAddEvent("order.placed", { cwd })).rejects.toThrow(
      /telemetryDir.*symlink.*outside the project.*no files/i,
    );

    expect(await exists(path.join(outside, "events/order-placed.ts"))).toBe(
      false,
    );
  });

  it("rejects the default telemetry directory when its symlink escapes", async () => {
    const cwd = await makeProject();
    const outside = await mkdtemp(
      path.join(tmpdir(), "amplio-default-telemetry-outside-"),
    );
    await symlink(outside, path.join(cwd, "telemetry"), "dir");

    await expect(runInit({ cwd, skipInstall: true })).rejects.toThrow(
      /telemetryDir.*symlink.*outside the project.*no files/i,
    );

    expect(await exists(path.join(cwd, "amplio.json"))).toBe(false);
    expect(await exists(path.join(outside, "runtime.ts"))).toBe(false);
  });

  it("allows a normalized nested telemetryDir that remains in the project", async () => {
    const cwd = await makeProject();
    await mkdir(path.join(cwd, "observability"));
    await writeFile(
      path.join(cwd, "amplio.json"),
      `${JSON.stringify(
        { telemetryDir: "observability/telemetry" },
        null,
        2,
      )}\n`,
    );

    await runAddEvent("order.placed", { cwd });

    expect(
      await exists(
        path.join(cwd, "observability/telemetry/events/order-placed.ts"),
      ),
    ).toBe(true);
  });

  it("fails closed when an explicitly configured registry is missing", async () => {
    const cwd = await makeProject();
    await writeFile(
      path.join(cwd, "amplio.json"),
      `${JSON.stringify(
        {
          telemetryDir: "telemetry",
          registry: "./missing/registry.json",
        },
        null,
        2,
      )}\n`,
    );

    await expect(resolveRegistryPath(cwd)).rejects.toThrow(
      /configured registry.*missing\/registry\.json.*not found/i,
    );
  });

  it("rejects an unrecognized configured package manager before writes", async () => {
    const cwd = await makeProject();
    const configPath = path.join(cwd, "amplio.json");
    const before = `${JSON.stringify(
      {
        telemetryDir: "telemetry",
        packageManager: "../../bin/host-command",
      },
      null,
      2,
    )}\n`;
    await writeFile(configPath, before);

    await expect(runAddEvent("order.placed", { cwd })).rejects.toThrow(
      /packageManager.*pnpm.*npm.*yarn.*bun.*no files/i,
    );

    expect(await readFile(configPath, "utf8")).toBe(before);
    expect(await exists(path.join(cwd, "telemetry"))).toBe(false);
  });
});
