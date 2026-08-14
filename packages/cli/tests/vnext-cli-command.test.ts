import { spawnSync } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const cliRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const cliPath = path.join(cliRoot, "dist/cli.js");
const sourceRegistry = path.resolve(
  cliRoot,
  "../../registry/registry.manifest.json",
);

function runCli(args: string[]) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: cliRoot,
    encoding: "utf8",
  });
}

describe("vNext public CLI command", () => {
  it("runs init --yes then add plugin resend --event http.request", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-vnext-cli-"));
    await writeFile(
      path.join(cwd, "package.json"),
      `${JSON.stringify(
        {
          name: "packed-hono-cli-app",
          private: true,
          type: "module",
          dependencies: {
            "@useamplio/amplio": "0.1.0-alpha.17",
            hono: "^4.7.4",
            resend: "^4.0.0",
            zod: "^3.24.2",
          },
        },
        null,
        2,
      )}\n`,
    );
    await mkdir(path.join(cwd, "src"), { recursive: true });
    await writeFile(
      path.join(cwd, "src/app.ts"),
      'import { Hono } from "hono";\n\nexport const app = new Hono();\n',
    );
    await writeFile(
      path.join(cwd, "src/email.ts"),
      `import { Resend } from "resend";\n\nexport const resend = new Resend(process.env.RESEND_API_KEY);\n`,
    );
    const backupEmail = `import { Resend } from "resend";\n\nexport const resend = new Resend(process.env.BACKUP_RESEND_API_KEY);\n`;
    await writeFile(path.join(cwd, "src/backup-email.ts"), backupEmail);

    const init = runCli(["init", "--yes", "--skip-install", "--cwd", cwd]);
    expect(init.status, init.stderr || init.stdout).toBe(0);

    const configPath = path.join(cwd, "amplio.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<
      string,
      unknown
    >;
    config.registry = sourceRegistry;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const add = runCli([
      "add",
      "plugin",
      "resend",
      "--event",
      "http.request",
      "--target",
      "src/email.ts",
      "--cwd",
      cwd,
    ]);
    expect(add.status, add.stderr || add.stdout).toBe(0);
    expect(add.stdout).toContain("mounted under email");
    expect(await readFile(path.join(cwd, "src/email.ts"), "utf8")).toContain(
      "ResendPlugin(new Resend(process.env.RESEND_API_KEY))",
    );
    await expect(
      readFile(path.join(cwd, "src/backup-email.ts"), "utf8"),
    ).resolves.toBe(backupEmail);

    const diff = runCli(["diff", "plugin", "resend", "--cwd", cwd]);
    expect(diff.status, diff.stderr || diff.stdout).toBe(0);
    expect(diff.stdout).toContain("registry source: current");

    const remove = runCli(["remove", "plugin", "resend", "--cwd", cwd]);
    expect(remove.status, remove.stderr || remove.stdout).toBe(0);
    expect(remove.stdout).toContain("provider dependencies were retained");
    await expect(
      readFile(path.join(cwd, "telemetry/plugins/resend.ts"), "utf8"),
    ).rejects.toThrow();
    const unwrapped = await readFile(path.join(cwd, "src/email.ts"), "utf8");
    expect(unwrapped).toContain("new Resend(process.env.RESEND_API_KEY)");
    expect(unwrapped).not.toContain("ResendPlugin");
  });

  it("rejects multiple Plugin slugs before activating the first", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-vnext-cli-atomic-"));
    await writeFile(
      path.join(cwd, "package.json"),
      `${JSON.stringify(
        {
          name: "plugin-cli-atomic-app",
          private: true,
          type: "module",
          dependencies: {
            "@useamplio/amplio": "0.1.0-alpha.17",
            resend: "^4.0.0",
            zod: "^3.24.2",
          },
        },
        null,
        2,
      )}\n`,
    );
    await mkdir(path.join(cwd, "src"), { recursive: true });
    const compositionPath = path.join(cwd, "src/email.ts");
    await writeFile(
      compositionPath,
      `import { Resend } from "resend";\n\nexport const resend = new Resend(process.env.RESEND_API_KEY);\n`,
    );
    const init = runCli(["init", "--skip-install", "--cwd", cwd]);
    expect(init.status, init.stderr || init.stdout).toBe(0);
    const configPath = path.join(cwd, "amplio.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<
      string,
      unknown
    >;
    config.registry = sourceRegistry;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const eventPath = path.join(cwd, "telemetry/events/http-request.ts");
    const tracked = [
      configPath,
      path.join(cwd, "package.json"),
      eventPath,
      compositionPath,
    ];
    const before = await Promise.all(
      tracked.map((file) => readFile(file, "utf8")),
    );

    const add = runCli([
      "add",
      "plugin",
      "resend",
      "typo",
      "--event",
      "http.request",
      "--cwd",
      cwd,
    ]);

    expect(add.status).toBe(1);
    expect(add.stderr).toContain("Expected one Plugin slug");
    await expect(
      Promise.all(tracked.map((file) => readFile(file, "utf8"))),
    ).resolves.toEqual(before);
    await expect(
      access(path.join(cwd, "telemetry/plugins/resend.ts")),
    ).rejects.toThrow();
  });
});
