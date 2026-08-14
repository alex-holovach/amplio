import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const cliRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const cliPath = path.join(cliRoot, "dist/cli.js");

function runCli(args: string[]) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: cliRoot,
    encoding: "utf8",
  });
}

beforeAll(() => {
  if (!existsSync(cliPath))
    throw new Error("build the CLI before CLI process tests");
});

describe("vNext CLI help and grammar", () => {
  it("teaches only the Event + Plugin surface", () => {
    const result = runCli(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Event + Plugin");
    expect(result.stdout).toContain("amplio add <kind> <id>");
    expect(result.stdout).toContain("amplio diff plugin <slug>");
    expect(result.stdout).toContain("amplio update plugin <slug>");
    expect(result.stdout).toContain("amplio remove plugin <slug>");
    expect(result.stdout).not.toMatch(
      /add component|add middleware|add integration/,
    );
  });

  it.each(["diff", "update", "remove"])(
    "documents the canonical %s Plugin lifecycle grammar",
    (command) => {
      const result = runCli([command, "--help"]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`amplio ${command} plugin <slug>`);
      expect(result.stdout).not.toMatch(/component|middleware|integration/);
    },
  );

  it("documents canonical init flags without alpha selectors", () => {
    const result = runCli(["init", "--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--yes");
    expect(result.stdout).toContain("--skip-install");
    expect(result.stdout).not.toMatch(/--component|--middleware|--wire/);
  });

  it("documents exactly Event, Plugin, sink, and enricher add kinds", () => {
    const result = runCli(["add", "--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("amplio add event <event-id>");
    expect(result.stdout).toContain("amplio add plugin resend --event");
    expect(result.stdout).toContain("--source-only");
    expect(result.stdout).toContain("--target <relative-source-file>");
    expect(result.stdout).toContain("--yes");
    expect(result.stdout).toMatch(/complete Plugin recipe dependency plan/i);
    expect(result.stdout).toMatch(/node_modules.*not reversible/i);
    expect(result.stdout).toContain("amplio add sink");
    expect(result.stdout).toContain("amplio add enricher service-metadata");
    expect(result.stdout).not.toMatch(/component|middleware|integration/);
  });

  it.each(["component", "middleware", "integration"])(
    "rejects retired add kind %s",
    (kind) => {
      const result = runCli(["add", kind, "example"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`Unknown add kind "${kind}"`);
      expect(result.stderr).toContain(
        "Valid kinds: event, plugin, sink, enricher",
      );
    },
  );

  it("rejects retired init flags as unknown options", () => {
    const result = runCli(["init", "--component", "order.placed"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown option");
  });

  it("allows --event only for contributor Plugin selection", () => {
    const result = runCli([
      "add",
      "event",
      "order.placed",
      "--event",
      "http.request",
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--event is only valid with add plugin");
  });

  it("rejects --target with the deliberately inert --source-only mode", () => {
    const result = runCli([
      "add",
      "plugin",
      "next",
      "--source-only",
      "--target",
      "app/api/health/route.ts",
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "--target selects an active Plugin seam and cannot be used with --source-only",
    );
  });

  it("lists only supported semantic recipe kinds as JSON", () => {
    const result = runCli(["list", "--json"]);
    expect(result.status).toBe(0);
    const items = JSON.parse(result.stdout) as Array<{
      kind: string;
      name: string;
    }>;
    expect(new Set(items.map((item) => item.kind))).toEqual(
      new Set(["event", "plugin", "sink", "enricher"]),
    );
    expect(items.some((item) => item.name === "plugin-resend")).toBe(true);
    expect(items.some((item) => item.name.startsWith("component-"))).toBe(
      false,
    );
  });

  it("prints help and exits non-zero without a command", () => {
    const result = runCli([]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("amplio init");
  });
});
