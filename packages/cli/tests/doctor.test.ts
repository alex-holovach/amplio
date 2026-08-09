import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runDoctor } from "../src/commands/doctor.js";
import { runInit } from "../src/commands/init.js";

async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

describe("runDoctor", () => {
  it("passes for a well-wired Next project", async () => {
    const cwd = await makeTempDir("amplio-doctor-good-");
    await writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({
        dependencies: { next: "^15.0.0", "@useamplio/amplio": "^0.1.0-alpha.6", zod: "^3.24.0" },
      }),
    );
    await mkdir(path.join(cwd, "src/app"), { recursive: true });
    await runInit({ cwd, skipInstall: true, middleware: "next", event: "none" });

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await runDoctor({ cwd });
    log.mockRestore();

    expect(code).toBe(0);
  });

  it("exits 0 with warnings for event path mismatch and missing instrumentation", async () => {
    const cwd = await makeTempDir("amplio-doctor-warn-");
    await writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({
        dependencies: { next: "^15.0.0", "@useamplio/amplio": "^0.1.0-alpha.6" },
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
});
