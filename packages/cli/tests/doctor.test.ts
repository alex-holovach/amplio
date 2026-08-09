import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runDoctor } from "../src/commands/doctor.js";
import { runInit } from "../src/commands/init.js";

async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function setupDoctorProject(cwd: string, options?: { turboDev?: boolean }): Promise<void> {
  await writeFile(
    path.join(cwd, "package.json"),
    JSON.stringify({
      dependencies: {
        next: "^15.0.0",
        "@useamplio/amplio": "^0.1.0-alpha.7",
        zod: "^3.24.0",
      },
      ...(options?.turboDev
        ? { scripts: { dev: "next dev --turbo" } }
        : {}),
    }),
  );
  await writeFile(
    path.join(cwd, "amplio.json"),
    JSON.stringify({ telemetryDir: "telemetry", packageManager: "pnpm" }),
  );
  await mkdir(path.join(cwd, "telemetry/events"), { recursive: true });
  await mkdir(path.join(cwd, "src"), { recursive: true });
  await writeFile(
    path.join(cwd, "telemetry/logger.ts"),
    'import { init } from "@useamplio/amplio";\ninit({ service: "test", env: "test", sinks: [], enrichers: [] });\n',
  );
  await writeFile(
    path.join(cwd, "src/instrumentation.ts"),
    'export async function register() { await import("../telemetry/logger"); }\n',
  );
}

describe("runDoctor", () => {
  it("passes for a well-wired Next project", async () => {
    const cwd = await makeTempDir("amplio-doctor-good-");
    await writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({
        dependencies: { next: "^15.0.0", "@useamplio/amplio": "^0.1.0-alpha.7", zod: "^3.24.0" },
      }),
    );
    await mkdir(path.join(cwd, "src/app"), { recursive: true });
    await runInit({ cwd, skipInstall: true, middleware: "next", event: "none" });

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await runDoctor({ cwd });
    log.mockRestore();

    expect(code).toBe(0);
  });

  it("--strict exits 1 when warnings are present", async () => {
    const cwd = await makeTempDir("amplio-doctor-strict-warn-");
    await writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({
        dependencies: { next: "^15.0.0", "@useamplio/amplio": "^0.1.0-alpha.7" },
      }),
    );
    await mkdir(path.join(cwd, "src/app"), { recursive: true });
    await runInit({ cwd, skipInstall: true, middleware: "none", event: "none" });

    const badEventDir = path.join(cwd, "telemetry/events/email");
    await mkdir(badEventDir, { recursive: true });
    await writeFile(
      path.join(badEventDir, "email-sent.ts"),
      'export const EmailSent = defineEvent("email.sent", {} as never);',
    );

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await runDoctor({ cwd, strict: true });
    log.mockRestore();

    expect(code).toBe(1);
  });

  it("--strict exits 0 when no warnings or failures", async () => {
    const cwd = await makeTempDir("amplio-doctor-strict-ok-");
    await writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({
        dependencies: { "@useamplio/amplio": "^0.1.0-alpha.7", zod: "^3.24.0" },
      }),
    );
    await writeFile(
      path.join(cwd, "amplio.json"),
      JSON.stringify({ telemetryDir: "telemetry", packageManager: "pnpm" }),
    );
    await mkdir(path.join(cwd, "telemetry"), { recursive: true });
    await writeFile(
      path.join(cwd, "telemetry/logger.ts"),
      'import { init } from "@useamplio/amplio";\ninit({ service: "test", env: "test", sinks: [], enrichers: [] });\n',
    );

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await runDoctor({ cwd, strict: true });
    log.mockRestore();

    expect(code).toBe(0);
  });

  it("exits 0 with warnings for event path mismatch and missing instrumentation", async () => {
    const cwd = await makeTempDir("amplio-doctor-warn-");
    await writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({
        dependencies: { next: "^15.0.0", "@useamplio/amplio": "^0.1.0-alpha.7" },
      }),
    );
    await mkdir(path.join(cwd, "src/app"), { recursive: true });
    await runInit({ cwd, skipInstall: true, middleware: "none", event: "none" });

    const badEventDir = path.join(cwd, "telemetry/events/email");
    await mkdir(badEventDir, { recursive: true });
    await writeFile(
      path.join(badEventDir, "email-sent.ts"),
      'export const EmailSent = defineEvent("email.sent", {} as never);',
    );

    const logs: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });
    const code = await runDoctor({ cwd });
    log.mockRestore();

    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("path mismatch");
    expect(logs.join("\n")).toMatch(/instrumentation/i);
  });

  it("exits 1 when runtime and logger are missing", async () => {
    const cwd = await makeTempDir("amplio-doctor-fail-");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await runDoctor({ cwd });
    log.mockRestore();
    expect(code).toBe(1);
  });

  it("warns when scaffolded middleware export is never imported", async () => {
    const cwd = await makeTempDir("amplio-doctor-mw-unwired-");
    await writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({
        dependencies: { hono: "^4.0.0", "@useamplio/amplio": "^0.1.0-alpha.7", zod: "^3.24.0" },
      }),
    );
    await runInit({ cwd, skipInstall: true, middleware: "hono", event: "none" });

    const logs: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });
    const code = await runDoctor({ cwd });
    log.mockRestore();

    expect(code).toBe(0);
    expect(logs.join("\n")).toContain(
      "telemetry/middleware/hono.ts scaffolded but amplioMiddleware is never imported by app code",
    );
    expect(logs.join("\n")).toContain(
      "https://github.com/alex-holovach/amplio/blob/main/ALPHA.md",
    );
  });

  it("passes middleware wiring check when export is referenced in app code", async () => {
    const cwd = await makeTempDir("amplio-doctor-mw-wired-");
    await writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({
        dependencies: { hono: "^4.0.0", "@useamplio/amplio": "^0.1.0-alpha.7", zod: "^3.24.0" },
      }),
    );
    await mkdir(path.join(cwd, "src"), { recursive: true });
    await runInit({ cwd, skipInstall: true, middleware: "hono", event: "none" });
    await writeFile(
      path.join(cwd, "src/server.ts"),
      'import { amplioMiddleware } from "../telemetry/middleware/hono";\nexport { amplioMiddleware };\n',
    );

    const logs: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });
    const code = await runDoctor({ cwd });
    log.mockRestore();

    expect(code).toBe(0);
    expect(logs.join("\n")).not.toContain("amplioMiddleware is never imported");
  });

  it("warns when Next middleware lacks ../logger import for Turbopack", async () => {
    const cwd = await makeTempDir("amplio-doctor-turbo-warn-");
    await setupDoctorProject(cwd, { turboDev: true });
    await mkdir(path.join(cwd, "telemetry/middleware"), { recursive: true });
    await writeFile(
      path.join(cwd, "telemetry/middleware/next.ts"),
      "export function withAmplio() {}\n",
    );

    const logs: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });
    const code = await runDoctor({ cwd });
    log.mockRestore();

    expect(code).toBe(0);
    const output = logs.join("\n");
    expect(output).toContain('does not import "../logger"');
    expect(output).toContain("your dev script uses --turbo");
    expect(output).toContain("amplio add middleware next --force");
  });

  it("passes Turbopack check when middleware imports ../logger", async () => {
    const cwd = await makeTempDir("amplio-doctor-turbo-ok-");
    await setupDoctorProject(cwd);
    await mkdir(path.join(cwd, "telemetry/middleware"), { recursive: true });
    await writeFile(
      path.join(cwd, "telemetry/middleware/next.ts"),
      'import "../logger";\nexport function withAmplio() {}\n',
    );

    const logs: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });
    const code = await runDoctor({ cwd });
    log.mockRestore();

    expect(code).toBe(0);
    expect(logs.join("\n")).not.toContain('does not import "../logger"');
  });

  it("warns when event barrels are missing", async () => {
    const cwd = await makeTempDir("amplio-doctor-barrel-warn-");
    await setupDoctorProject(cwd);
    await mkdir(path.join(cwd, "telemetry/events/payment"), { recursive: true });
    await writeFile(
      path.join(cwd, "telemetry/events/payment/order-paid.ts"),
      'import { defineEvent } from "@useamplio/amplio";\nexport const PaymentOrderPaid = defineEvent("payment.order.paid", {} as never);\n',
    );

    const logs: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });
    const code = await runDoctor({ cwd });
    log.mockRestore();

    expect(code).toBe(0);
    const output = logs.join("\n");
    expect(output).toContain('Event "payment.order.paid" missing from barrel export(s)');
    expect(output).toContain("amplio doctor --fix");
  });

  it("--fix regenerates missing domain and root barrels", async () => {
    const cwd = await makeTempDir("amplio-doctor-barrel-fix-");
    await setupDoctorProject(cwd);
    await mkdir(path.join(cwd, "telemetry/events/payment"), { recursive: true });
    await writeFile(
      path.join(cwd, "telemetry/events/payment/order-paid.ts"),
      'import { defineEvent } from "@useamplio/amplio";\nexport const PaymentOrderPaid = defineEvent("payment.order.paid", {} as never);\n',
    );

    const logs: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });
    const code = await runDoctor({ cwd, fix: true });
    log.mockRestore();

    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("Fixed barrel exports for payment.order.paid");

    const domainBarrel = await readFile(
      path.join(cwd, "telemetry/events/payment/index.ts"),
      "utf8",
    );
    expect(domainBarrel).toContain("PaymentOrderPaid");
    expect(domainBarrel).toContain('./order-paid"');

    const rootBarrel = await readFile(path.join(cwd, "telemetry/events/index.ts"), "utf8");
    expect(rootBarrel).toContain("PaymentOrderPaid");
    expect(rootBarrel).toContain('./payment/index"');
  });
});
