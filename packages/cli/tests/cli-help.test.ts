import { execFileSync, spawnSync } from "node:child_process";
import { constants, existsSync, readFileSync } from "node:fs";
import { access, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const cliPackageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const cliPath = path.join(cliPackageRoot, "dist/cli.js");
const cliPackageVersion = (
  JSON.parse(
    readFileSync(path.join(cliPackageRoot, "package.json"), "utf8"),
  ) as { version: string }
).version;
const cliPackageRegistry = path.join(cliPackageRoot, "registry/registry.json");
const monorepoRegistry = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../registry/registry.json",
);

type CliResult = ReturnType<typeof runCli>;

function formatCliOutput(result: CliResult): string {
  const parts: string[] = [];
  if (result.stdout) parts.push(`stdout:\n${result.stdout}`);
  if (result.stderr) parts.push(`stderr:\n${result.stderr}`);
  return parts.length > 0 ? parts.join("\n\n") : "(no output)";
}

function expectCliStatus(
  result: CliResult,
  expectedStatus: number,
  label: string,
): void {
  if (result.status !== expectedStatus) {
    throw new Error(
      `${label}: expected exit ${expectedStatus}, got ${result.status ?? "null"}\n${formatCliOutput(result)}`,
    );
  }
}

async function assertRegistryExists(): Promise<string> {
  const candidates = [cliPackageRegistry, monorepoRegistry];
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.R_OK);
      return candidate;
    } catch {
      // try next candidate
    }
  }
  throw new Error(
    `Registry not readable. Checked:\n${candidates.map((p) => `  - ${p}`).join("\n")}`,
  );
}

async function initWithRegistry(cwd: string, service?: string): Promise<void> {
  const init = runCli([
    "init",
    "--cwd",
    cwd,
    ...(service ? ["--service", service] : []),
  ]);
  expect(init.status).toBe(0);

  const configPath = path.join(cwd, "amplio.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.registry = monorepoRegistry;
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}
`);
}

function runCli(args: string[]) {
  return spawnSync("node", [cliPath, ...args], {
    encoding: "utf8",
    cwd: cliPackageRoot,
  });
}

beforeAll(async () => {
  // Avoid tsup --clean racing other parallel vitest files that already imported dist/cli.js.
  if (!existsSync(cliPath)) {
    execFileSync("pnpm", ["run", "build"], {
      cwd: cliPackageRoot,
      stdio: "pipe",
    });
  }
  await assertRegistryExists();
});

describe("cli --help", () => {
  it("exits 0 and mentions init and add", () => {
    const result = runCli(["--help"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("init");
    expect(result.stdout).toContain("add");
    expect(result.stdout).toContain("list");
    expect(result.stdout).toContain("doctor");
  });

  it("global help is compact and points to per-command help", () => {
    const result = runCli(["--help"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("amplio <command> --help");
    expect(result.stdout).not.toContain("--package-manager");
  });

  it("init --help shows init-specific flags", () => {
    const result = runCli(["init", "--help"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--service");
    expect(result.stdout).toContain("--package-manager");
    expect(result.stdout).toContain("--no-typescript");
    expect(result.stdout).toContain("--middleware");
    expect(result.stdout).toContain("--event");
    expect(result.stdout).toContain("--yes");
    expect(result.stdout).toContain("--skip-install");
    expect(result.stdout).toContain("--paths");
    expect(result.stdout).toContain("amplio init --yes");
    expect(result.stdout).not.toContain("amplio add middleware");
  });

  it("add --help shows kinds and --force", () => {
    const result = runCli(["add", "--help"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("post.created");
    expect(result.stdout).toContain("auth.user.signed_up");
    expect(result.stdout).toContain("domain.action or domain.entity.action");
    expect(result.stdout).toContain("--force");
    expect(result.stdout).toContain("amplio add middleware hono");
  });

  it("doctor --help shows --fix and --strict", () => {
    const result = runCli(["doctor", "--help"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--fix");
    expect(result.stdout).toContain("--strict");
    expect(result.stdout).toContain("Exit non-zero on warnings");
    expect(result.stdout).toContain("amplio doctor --strict");
  });

  it("list --help shows kinds and --json", () => {
    const result = runCli(["list", "--help"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("event, middleware, sink");
    expect(result.stdout).toContain("--json");
    expect(result.stdout).toContain("amplio list sink --json");
  });

  it("exits 0 and mentions init and add with -h", () => {
    const result = runCli(["-h"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("init");
    expect(result.stdout).toContain("add");
    expect(result.stdout).toContain("list");
  });

  it("shows help mentioning init/add with no args (exit non-zero)", () => {
    const result = runCli([]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("init");
    expect(result.stdout).toContain("add");
  });
});

describe("cli add unknown kind", () => {
  it("exits non-zero with Unknown add kind for widget", () => {
    const result = runCli(["add", "widget", "foo"]);
    expect(result.status).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toContain("Unknown add kind");
    expect(`${result.stderr}${result.stdout}`).toContain(
      "Valid kinds: event, middleware, sink, enricher, integration",
    );
  });

  it("exits non-zero with Unknown add kind for banana without id", () => {
    const result = runCli(["add", "banana"]);
    expect(result.status).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toContain('Unknown add kind "banana"');
    expect(`${result.stderr}${result.stdout}`).not.toContain("Missing add name");
  });
});

describe("cli unknown command", () => {
  it("exits non-zero with Unknown command", () => {
    const result = runCli(["foobar"]);
    expect(result.status).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toContain("Unknown command");
  });
});


describe("cli unknown option", () => {
  it("exits 1 with Unknown option for --not-a-real-flag", () => {
    const result = runCli(["list", "--not-a-real-flag"]);
    expect(result.status).toBe(1);
    expect(`${result.stderr}${result.stdout}`).toContain("Unknown option");
    expect(`${result.stderr}${result.stdout}`).toContain("--not-a-real-flag");
  });
});

describe("cli --force only with add", () => {
  it("exits 1 when --force is used with init", () => {
    const result = runCli(["init", "--force"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("error: --force is only valid with add");
  });

  it("exits 1 when --force is used with list", () => {
    const result = runCli(["list", "--force"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("error: --force is only valid with add");
  });
});

describe("cli --strict only with doctor", () => {
  it("exits 1 when --strict is used with init", () => {
    const result = runCli(["init", "--strict"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("error: --strict is only valid with doctor");
  });

  it("exits 1 when --strict is used with list", () => {
    const result = runCli(["list", "--strict"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("error: --strict is only valid with doctor");
  });
});

describe("cli --json only with list", () => {
  it("exits 1 when --json is used with init", () => {
    const result = runCli(["init", "--json"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("error: --json is only valid with list");
  });

  it("exits 1 when --json is used with add", () => {
    const result = runCli(["add", "sink", "console", "--json"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("error: --json is only valid with list");
  });
});

describe("cli --fix only with doctor", () => {
  it("exits 1 when --fix is used with init", () => {
    const result = runCli(["init", "--fix"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("error: --fix is only valid with doctor");
  });

  it("exits 1 when --fix is used with add", () => {
    const result = runCli(["add", "event", "auth.user.signed_up", "--fix"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("error: --fix is only valid with doctor");
  });
});

describe("cli --paths only with init", () => {
  it("exits 1 when --paths is used with doctor", () => {
    const result = runCli(["doctor", "--paths"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("error: --paths is only valid with init");
  });

  it("exits 1 when --paths is used with add", () => {
    const result = runCli(["add", "sink", "console", "--paths"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("error: --paths is only valid with init");
  });
});

describe("cli init --paths", () => {
  it("adds alias to existing paths block while preserving JSONC comments", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-init-paths-jsonc-"));
    await writeFile(
      path.join(cwd, "tsconfig.json"),
      `{
  // create-t3-app style comment
  "compilerOptions": {
    "target": "es2017",
    "paths": {
      "@/*": ["./src/*"]
    }
  }
}
`,
    );
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({ name: "paths-app" }));

    const result = runCli(["init", "--cwd", cwd, "--skip-install", "--paths"]);
    expectCliStatus(result, 0, "init --paths with existing paths");

    const tsconfig = await readFile(path.join(cwd, "tsconfig.json"), "utf8");
    expect(tsconfig).toContain("// create-t3-app style comment");
    expect(tsconfig).toContain('"~telemetry/*": ["./telemetry/*"]');
    expect(tsconfig).toContain('"@/*": ["./src/*"]');
    expect(result.stdout).toContain("✓ tsconfig.json (~telemetry/* path alias)");
  });

  it("inserts paths block when compilerOptions has no paths", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-init-paths-new-"));
    await writeFile(
      path.join(cwd, "tsconfig.json"),
      `{
  "compilerOptions": {
    "target": "es2017"
  }
}
`,
    );
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({ name: "paths-new" }));

    const result = runCli(["init", "--cwd", cwd, "--skip-install", "--paths"]);
    expectCliStatus(result, 0, "init --paths without paths block");

    const tsconfig = await readFile(path.join(cwd, "tsconfig.json"), "utf8");
    expect(tsconfig).toContain('"paths": {');
    expect(tsconfig).toContain('"~telemetry/*": ["./telemetry/*"]');
    expect(result.stdout).toContain("✓ tsconfig.json (~telemetry/* path alias)");
  });

  it("is idempotent on second run", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-init-paths-idempotent-"));
    await writeFile(
      path.join(cwd, "tsconfig.json"),
      `{
  "compilerOptions": {
    "paths": {
      "@/*": ["./src/*"]
    }
  }
}
`,
    );
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({ name: "paths-idem" }));

    const first = runCli(["init", "--cwd", cwd, "--skip-install", "--paths"]);
    expectCliStatus(first, 0, "first init --paths");
    const afterFirst = await readFile(path.join(cwd, "tsconfig.json"), "utf8");

    const second = runCli(["init", "--cwd", cwd, "--skip-install", "--paths"]);
    expectCliStatus(second, 0, "second init --paths");
    expect(second.stdout).toContain("· tsconfig.json already has ~telemetry/*");
    expect(await readFile(path.join(cwd, "tsconfig.json"), "utf8")).toBe(afterFirst);
  });

  it("prints hint when tsconfig.json is missing", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-init-paths-missing-"));
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({ name: "no-tsconfig" }));

    const result = runCli(["init", "--cwd", cwd, "--skip-install", "--paths"]);
    expectCliStatus(result, 0, "init --paths without tsconfig");
    expect(result.stdout).toContain("tsconfig.json not found");
    expect(result.stdout).toContain("amplio init --paths");
  });

  it("suppresses ~telemetry paths hint on Next src layout when --paths is passed", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-init-paths-no-hint-"));
    await writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({ dependencies: { next: "^15.0.0" } }),
    );
    await writeFile(
      path.join(cwd, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          paths: { "@/*": ["./src/*"] },
        },
      }),
    );
    await mkdir(path.join(cwd, "src/app"), { recursive: true });

    const result = runCli(["init", "--cwd", cwd, "--skip-install", "--yes", "--paths"]);
    expectCliStatus(result, 0, "init --yes --paths on Next src layout");
    expect(result.stdout).toContain("✓ tsconfig.json (~telemetry/* path alias)");
    expect(result.stdout).not.toContain("Optional: add to tsconfig.json compilerOptions.paths");
  });
});

describe("cli init-only flags", () => {
  it("exits 1 when --service is used with add", () => {
    const result = runCli([
      "add",
      "event",
      "auth.user.signed_up",
      "--service",
      "my-svc",
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("error: --service is only valid with init");
  });

  it("exits 1 when --package-manager is used with list", () => {
    const result = runCli(["list", "--package-manager", "npm"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "error: --package-manager is only valid with init",
    );
  });

  it("exits 1 when --no-typescript is used with add", () => {
    const result = runCli([
      "add",
      "event",
      "auth.user.signed_up",
      "--no-typescript",
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "error: --no-typescript is only valid with init",
    );
  });

  it("ignores whitespace-only --package-manager on add sink console", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-init-only-pm-ws-"));
    const result = runCli([
      "add",
      "sink",
      "console",
      "--cwd",
      cwd,
      "--package-manager",
      "   ",
    ]);
    expectCliStatus(
      result,
      0,
      "add sink console with whitespace-only --package-manager",
    );
  });

  it("ignores whitespace-only --service on add sink console", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-init-only-svc-ws-"));
    const result = runCli([
      "add",
      "sink",
      "console",
      "--cwd",
      cwd,
      "--service",
      "   ",
    ]);
    expectCliStatus(
      result,
      0,
      "add sink console with whitespace-only --service",
    );
  });
});

describe("cli missing option value", () => {
  it("exits 1 with friendly message for --service without value", () => {
    const result = runCli(["init", "--service"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("error: Option '--service <value>' argument missing");
    expect(`${result.stderr}${result.stdout}`).not.toContain("ERR_PARSE_ARGS");
  });

  it("exits 1 with friendly message for --cwd without value", () => {
    const result = runCli(["list", "--cwd"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("error: Option '--cwd <value>' argument missing");
    expect(`${result.stderr}${result.stdout}`).not.toContain("ERR_PARSE_ARGS");
  });

  it("exits 1 with friendly message for --package-manager without value", () => {
    const result = runCli(["init", "--package-manager"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "error: Option '--package-manager <value>' argument missing",
    );
    expect(`${result.stderr}${result.stdout}`).not.toContain("ERR_PARSE_ARGS");
  });
});

describe("cli list", () => {
  it("lists registry items", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-list-"));
    await initWithRegistry(cwd);
    const result = runCli(["list", "--cwd", cwd]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("events:");
    expect(result.stdout).toContain("middleware-hono");
    expect(result.stdout).toContain("Total:");
  });

  it("trims padded command and runs list successfully", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-list-padded-cmd-"));
    await initWithRegistry(cwd);
    const result = runCli([" list", "--cwd", cwd]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("events:");
    expect(result.stdout).toContain("Total:");
  });

  it("lists registry items without prior init", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-list-no-init-"));
    const result = runCli(["list", "--cwd", cwd]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("events:");
    expect(result.stdout).toContain("middleware-hono");
    expect(result.stdout).toContain("Total:");
  });

  it("filters by kind", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-list-kind-"));
    await initWithRegistry(cwd);
    const result = runCli(["list", "sink", "--cwd", cwd]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("sinks:");
    expect(result.stdout).not.toContain("events:");
  });

  it("list trims padded kind", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-list-padded-kind-"));
    await initWithRegistry(cwd);
    const result = runCli(["list", "  event  ", "--cwd", cwd]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("events:");
    expect(result.stdout).not.toContain("sinks:");
  });

  it("list whitespace-only kind lists all (same as bare list)", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-list-ws-kind-"));
    await initWithRegistry(cwd);
    const bare = runCli(["list", "--cwd", cwd]);
    const result = runCli(["list", "   ", "--cwd", cwd]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("events:");
    expect(result.stdout).toContain("middleware-hono");
    expect(result.stdout).toContain("Total:");
    expect(result.stdout).toBe(bare.stdout);
  });

  it("list enricher only shows enrichers", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-list-enricher-"));
    await initWithRegistry(cwd);

    const registry = JSON.parse(await readFile(monorepoRegistry, "utf8")) as {
      items: Array<{ name: string }>;
    };
    const enricherCount = registry.items.filter((item) =>
      item.name.startsWith("enricher-"),
    ).length;

    const result = runCli(["list", "enricher", "--cwd", cwd]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("enrichers:");
    expect(result.stdout).toContain(
      "service-metadata — Service Metadata Enricher (enricher-service-metadata)",
    );
    expect(result.stdout).not.toContain("middlewares:");
    expect(result.stdout).not.toContain("middleware-hono");
    expect(result.stdout).toContain(`Total: ${enricherCount}`);
  });

  it("list sink only shows sinks", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-list-sink-"));
    await initWithRegistry(cwd);

    const registry = JSON.parse(await readFile(monorepoRegistry, "utf8")) as {
      items: Array<{ name: string }>;
    };
    const sinkCount = registry.items.filter((item) =>
      item.name.startsWith("sink-"),
    ).length;

    const result = runCli(["list", "sink", "--cwd", cwd]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("sinks:");
    expect(result.stdout).toContain("console — Console Sink (sink-console)");
    expect(result.stdout).not.toContain("middlewares:");
    expect(result.stdout).not.toContain("middleware-hono");
    expect(result.stdout).toContain(`Total: ${sinkCount}`);
    expect(sinkCount).toBe(3);
  });

  it("list event only shows events", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-list-event-"));
    await initWithRegistry(cwd);

    const registry = JSON.parse(await readFile(monorepoRegistry, "utf8")) as {
      items: Array<{ name: string; title?: string }>;
    };
    const eventCount = registry.items.filter((item) =>
      item.name.startsWith("event-"),
    ).length;

    const signedUp = registry.items.find(
      (item) => item.name === "event-auth-user-signed-up",
    );
    expect(signedUp).toBeDefined();
    expect(signedUp!.title).toBe("Auth User Signed Up");
    const shortId = signedUp!.name.slice("event-".length);
    expect(shortId).toBe("auth-user-signed-up");
    const formattedLine = `${shortId} — ${signedUp!.title} (${signedUp!.name})`;

    const result = runCli(["list", "event", "--cwd", cwd]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("events:");
    expect(result.stdout).toContain(formattedLine);
    expect(result.stdout).not.toContain("middlewares:");
    expect(result.stdout).not.toContain("middleware-hono");
    expect(result.stdout).toContain(`Total: ${eventCount}`);
  });

  it("list events (plural) works like list event", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-list-events-"));
    await initWithRegistry(cwd);

    const registry = JSON.parse(await readFile(monorepoRegistry, "utf8")) as {
      items: Array<{ name: string }>;
    };
    const eventCount = registry.items.filter((item) =>
      item.name.startsWith("event-"),
    ).length;

    const result = runCli(["list", "events", "--cwd", cwd]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("events:");
    expect(result.stdout).toContain(
      "auth-user-signed-up — Auth User Signed Up (event-auth-user-signed-up)",
    );
    expect(result.stdout).not.toContain("middlewares:");
    expect(result.stdout).not.toContain("middleware-hono");
    expect(result.stdout).toContain(`Total: ${eventCount}`);
  });


  it("list sinks (plural) works like list sink", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-list-sinks-"));
    await initWithRegistry(cwd);

    const registry = JSON.parse(await readFile(monorepoRegistry, "utf8")) as {
      items: Array<{ name: string }>;
    };
    const sinkCount = registry.items.filter((item) =>
      item.name.startsWith("sink-"),
    ).length;

    const result = runCli(["list", "sinks", "--cwd", cwd]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("sinks:");
    expect(result.stdout).toContain("console — Console Sink (sink-console)");
    expect(result.stdout).not.toContain("middlewares:");
    expect(result.stdout).not.toContain("middleware-hono");
    expect(result.stdout).toContain(`Total: ${sinkCount}`);
  });

  it("list enrichers (plural) works like list enricher", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-list-enrichers-"));
    await initWithRegistry(cwd);

    const registry = JSON.parse(await readFile(monorepoRegistry, "utf8")) as {
      items: Array<{ name: string }>;
    };
    const enricherCount = registry.items.filter((item) =>
      item.name.startsWith("enricher-"),
    ).length;

    const result = runCli(["list", "enrichers", "--cwd", cwd]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("enrichers:");
    expect(result.stdout).toContain(
      "service-metadata — Service Metadata Enricher (enricher-service-metadata)",
    );
    expect(result.stdout).not.toContain("middlewares:");
    expect(result.stdout).not.toContain("middleware-hono");
    expect(result.stdout).toContain(`Total: ${enricherCount}`);
  });

  it("list middlewares (plural) works like list middleware", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-list-middlewares-"));
    await initWithRegistry(cwd);

    const registry = JSON.parse(await readFile(monorepoRegistry, "utf8")) as {
      items: Array<{ name: string }>;
    };
    const middlewareCount = registry.items.filter((item) =>
      item.name.startsWith("middleware-"),
    ).length;

    const result = runCli(["list", "middlewares", "--cwd", cwd]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("middlewares:");
    expect(result.stdout).toContain("hono — Hono Middleware (middleware-hono)");
    expect(result.stdout).not.toContain("sinks:");
    expect(result.stdout).not.toContain("sink-console");
    expect(result.stdout).toContain(`Total: ${middlewareCount}`);
  });

  it("list integrations (plural) works like list integration", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-list-integrations-"));
    await initWithRegistry(cwd);

    const registry = JSON.parse(await readFile(monorepoRegistry, "utf8")) as {
      items: Array<{ name: string }>;
    };
    const integrationCount = registry.items.filter((item) =>
      item.name.startsWith("integration-"),
    ).length;

    const result = runCli(["list", "integrations", "--cwd", cwd]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("integrations:");
    expect(result.stdout).toContain(
      "better-auth — Better Auth Integration (integration-better-auth)",
    );
    expect(result.stdout).not.toContain("middlewares:");
    expect(result.stdout).not.toContain("middleware-hono");
    expect(result.stdout).toContain(`Total: ${integrationCount}`);
  });

  it("list integration only shows integrations", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-list-integration-"));
    await initWithRegistry(cwd);

    const registry = JSON.parse(await readFile(monorepoRegistry, "utf8")) as {
      items: Array<{ name: string }>;
    };
    const integrationCount = registry.items.filter((item) =>
      item.name.startsWith("integration-"),
    ).length;

    const result = runCli(["list", "integration", "--cwd", cwd]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("integrations:");
    expect(result.stdout).toContain(
      "better-auth — Better Auth Integration (integration-better-auth)",
    );
    expect(result.stdout).not.toContain("middlewares:");
    expect(result.stdout).not.toContain("middleware-hono");
    expect(result.stdout).toContain(`Total: ${integrationCount}`);
    expect(integrationCount).toBe(4);
  });

  it("list middleware only shows middlewares", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-list-middleware-"));
    await initWithRegistry(cwd);

    const registry = JSON.parse(await readFile(monorepoRegistry, "utf8")) as {
      items: Array<{ name: string }>;
    };
    const middlewareCount = registry.items.filter((item) =>
      item.name.startsWith("middleware-"),
    ).length;

    const result = runCli(["list", "middleware", "--cwd", cwd]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("middlewares:");
    expect(result.stdout).toContain("hono — Hono Middleware (middleware-hono)");
    expect(result.stdout).not.toContain("sinks:");
    expect(result.stdout).not.toContain("sink-console");
    expect(result.stdout).toContain(`Total: ${middlewareCount}`);
    expect(middlewareCount).toBe(5);
  });

  it("fails clearly for unknown kind", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-list-unknown-kind-"));
    await initWithRegistry(cwd);
    const result = runCli(["list", "boguskind", "--cwd", cwd]);
    expect(result.status).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toContain("Unknown kind");
  });

  it("list --json prints machine-readable array", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-list-json-"));
    await initWithRegistry(cwd);
    const result = runCli(["list", "sink", "--cwd", cwd, "--json"]);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("Total:");
    expect(result.stdout).not.toContain("sinks:");

    const items = JSON.parse(result.stdout) as Array<{
      id: string;
      kind: string;
      name: string;
      title?: string;
    }>;
    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((item) => item.kind === "sink")).toBe(true);
    expect(items.some((item) => item.id === "console" && item.name === "sink-console")).toBe(true);
  });
});

describe("cli add event provenance", () => {
  it("prints matched registry event for auth.user.signed_up", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-add-event-registry-prov-"));
    await initWithRegistry(cwd);
    const result = runCli(["add", "event", "auth.user.signed_up", "--cwd", cwd]);
    expectCliStatus(result, 0, "add event auth.user.signed_up");
    expect(result.stdout).toContain("matched registry event event-auth-user-signed-up");
  });

  it("prints generated starter schema when no registry template", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-add-event-fallback-prov-"));
    await initWithRegistry(cwd);
    const result = runCli(["add", "event", "foo.bar.baz", "--cwd", cwd]);
    expectCliStatus(result, 0, "add event foo.bar.baz");
    expect(result.stdout).toContain("generated starter schema (no registry template for foo.bar.baz)");
  });
});

describe("cli init auth event default", () => {
  it("does not auto-scaffold auth.user.signed_up without auth dependency", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-init-no-auth-event-"));
    await writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({ dependencies: { next: "^15.0.0" } }),
    );

    const result = runCli(["init", "--cwd", cwd, "--skip-install", "--yes"]);
    expectCliStatus(result, 0, "init --yes without auth dep");
    expect(result.stdout).toContain("No starter event scaffolded");
    expect(result.stdout).toContain("add event post.created");
    expect(existsSync(path.join(cwd, "telemetry/events/auth/user-signed-up.ts"))).toBe(false);
    expect(existsSync(path.join(cwd, "telemetry/middleware/next.ts"))).toBe(true);
  });

  it("auto-scaffolds auth.user.signed_up when better-auth is present", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-init-auth-event-"));
    await writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({
        dependencies: { next: "^15.0.0", "better-auth": "^1.0.0" },
      }),
    );

    const result = runCli(["init", "--cwd", cwd, "--skip-install", "--yes"]);
    expectCliStatus(result, 0, "init --yes with better-auth");
    expect(result.stdout).not.toContain("No starter event scaffolded");
    expect(existsSync(path.join(cwd, "telemetry/events/auth/user-signed-up.ts"))).toBe(true);
  });
});

describe("cli init --service", () => {
  it("writes telemetry/logger.ts with the given service name", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-init-service-"));

    const result = runCli(["init", "--cwd", cwd, "--service", "my-svc"]);
    expectCliStatus(result, 0, "init --service my-svc");

    const loggerSource = await readFile(
      path.join(cwd, "telemetry/logger.ts"),
      "utf8",
    );
    expect(loggerSource).toContain("my-svc");
  });

  it("init --cwd nonexistent nested path exits 0 and creates amplio.json (mkdir -p)", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "amplio-init-mkdirp-"));
    const cwd = path.join(parent, "nested", "deep", "project");
    expect(existsSync(cwd)).toBe(false);

    const result = runCli(["init", "--cwd", cwd, "--service", "x"]);
    expectCliStatus(result, 0, "init --cwd nonexistent nested path --service x");

    expect(existsSync(path.join(cwd, "amplio.json"))).toBe(true);
  });

  it("init with padded --cwd writes amplio.json to the trimmed path", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-init-padded-cwd-"));
    const paddedCwd = `  ${cwd}  `;

    const result = runCli(["init", "--cwd", paddedCwd, "--service", "x"]);
    expectCliStatus(result, 0, "init with padded --cwd");

    expect(existsSync(path.join(cwd, "amplio.json"))).toBe(true);
    expect(existsSync(path.join(paddedCwd, "amplio.json"))).toBe(false);
  });

  it("writes telemetry/logger.ts with default service my-app when --service omitted", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-init-default-service-"));

    const result = runCli(["init", "--cwd", cwd]);
    expectCliStatus(result, 0, "init without --service");

    const loggerSource = await readFile(
      path.join(cwd, "telemetry/logger.ts"),
      "utf8",
    );
    expect(loggerSource).toContain('service: "my-app"');
  });

  it("defaults --service to package.json name (strips scope)", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-init-pkg-service-"));
    await writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({ name: "@acme/checkout-api" }),
    );

    const result = runCli(["init", "--cwd", cwd, "--skip-install"]);
    expectCliStatus(result, 0, "init with package.json name");

    const loggerSource = await readFile(
      path.join(cwd, "telemetry/logger.ts"),
      "utf8",
    );
    expect(loggerSource).toContain('service: "checkout-api"');
  });

  it("falls back to my-app when package.json has no name", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-init-no-pkg-name-"));
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({ private: true }));

    const result = runCli(["init", "--cwd", cwd, "--skip-install"]);
    expectCliStatus(result, 0, "init without package.json name");

    const loggerSource = await readFile(
      path.join(cwd, "telemetry/logger.ts"),
      "utf8",
    );
    expect(loggerSource).toContain('service: "my-app"');
  });

  it("writes telemetry/logger.ts with default service my-app when --service is empty", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-init-empty-service-"));

    const result = runCli(["init", "--cwd", cwd, "--service", ""]);
    expectCliStatus(result, 0, 'init --service ""');

    const loggerSource = await readFile(
      path.join(cwd, "telemetry/logger.ts"),
      "utf8",
    );
    expect(loggerSource).toContain('service: "my-app"');
  });

  it("trims padded --service and writes my-svc", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-init-padded-service-"));

    const result = runCli(["init", "--cwd", cwd, "--service", "  my-svc  "]);
    expectCliStatus(result, 0, "init --service '  my-svc  '");

    const loggerSource = await readFile(
      path.join(cwd, "telemetry/logger.ts"),
      "utf8",
    );
    expect(loggerSource).toContain('service: "my-svc"');
    expect(loggerSource).not.toContain('service: "  my-svc  "');
  });

  it("writes telemetry/logger.ts with default service my-app when --service is whitespace-only", async () => {
    const cwd = await mkdtemp(
      path.join(tmpdir(), "amplio-init-ws-service-"),
    );

    const result = runCli(["init", "--cwd", cwd, "--service", "   "]);
    expectCliStatus(result, 0, "init --service '   '");

    const loggerSource = await readFile(
      path.join(cwd, "telemetry/logger.ts"),
      "utf8",
    );
    expect(loggerSource).toContain('service: "my-app"');
    expect(loggerSource).not.toContain('service: "   "');
  });
});


describe("cli init --package-manager", () => {
  it("writes amplio.json with packageManager npm", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-init-pm-npm-"));

    const result = runCli([
      "init",
      "--cwd",
      cwd,
      "--package-manager",
      "npm",
    ]);
    expectCliStatus(result, 0, "init --package-manager npm");

    const config = JSON.parse(
      await readFile(path.join(cwd, "amplio.json"), "utf8"),
    );
    expect(config.packageManager).toBe("npm");
  });

  it("rejects unknown package manager", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-init-pm-bogus-"));

    const result = runCli([
      "init",
      "--cwd",
      cwd,
      "--package-manager",
      "bogus",
    ]);
    expectCliStatus(result, 1, "init --package-manager bogus");
    expect(result.stderr).toContain("Unknown package manager");
  });

  it("accepts padded package manager", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-init-pm-padded-"));

    const result = runCli([
      "init",
      "--cwd",
      cwd,
      "--package-manager",
      "  pnpm  ",
    ]);
    expectCliStatus(result, 0, "init --package-manager padded pnpm");

    const config = JSON.parse(
      await readFile(path.join(cwd, "amplio.json"), "utf8"),
    );
    expect(config.packageManager).toBe("pnpm");
  });

  it("accepts uppercase package manager", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-init-pm-upper-"));

    const result = runCli([
      "init",
      "--cwd",
      cwd,
      "--package-manager",
      "PNPM",
    ]);
    expectCliStatus(result, 0, "init --package-manager PNPM");

    const config = JSON.parse(
      await readFile(path.join(cwd, "amplio.json"), "utf8"),
    );
    expect(config.packageManager).toBe("pnpm");
  });

  it("defaults when package manager is whitespace-only", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-init-pm-blank-"));

    const result = runCli([
      "init",
      "--cwd",
      cwd,
      "--package-manager",
      "   ",
    ]);
    expectCliStatus(result, 0, "init --package-manager whitespace-only");

    const config = JSON.parse(
      await readFile(path.join(cwd, "amplio.json"), "utf8"),
    );
    expect(config.packageManager).toBe("pnpm");
  });
});


describe("cli init --no-typescript", () => {
  it("writes amplio.json with typescript false", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-init-no-ts-"));

    const result = runCli(["init", "--cwd", cwd, "--no-typescript"]);
    expectCliStatus(result, 0, "init --no-typescript");

    const config = JSON.parse(
      await readFile(path.join(cwd, "amplio.json"), "utf8"),
    );
    expect(config.typescript).toBe(false);
  });
});

describe("cli init idempotency", () => {
  it("second init exits 0 and preserves events from add event", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-init-idempotent-"));

    const first = runCli(["init", "--cwd", cwd, "--service", "test-app"]);
    expect(first.status).toBe(0);

    const add = runCli(["add", "event", "auth.user.signed_up", "--cwd", cwd]);
    expect(add.status).toBe(0);

    const eventPath = path.join(cwd, "telemetry/events/auth/user-signed-up.ts");
    const eventBefore = await readFile(eventPath, "utf8");
    expect(eventBefore).toContain("AuthUserSignedUp");

    const second = runCli(["init", "--cwd", cwd, "--service", "other-service"]);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("Existing files were left unchanged");

    const eventAfter = await readFile(eventPath, "utf8");
    expect(eventAfter).toBe(eventBefore);

    const loggerAfter = await readFile(path.join(cwd, "telemetry/logger.ts"), "utf8");
    expect(loggerAfter).toContain("test-app");
    expect(loggerAfter).not.toContain("other-service");
  });
});

describe("cli add event idempotency", () => {
  it("second add auth.user.signed_up exits 0 and preserves file (registry)", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-add-idempotent-"));
    await initWithRegistry(cwd, "test-app");

    const first = runCli(["add", "event", "auth.user.signed_up", "--cwd", cwd]);
    expectCliStatus(first, 0, "first add event auth.user.signed_up");

    const eventPath = path.join(cwd, "telemetry/events/auth/user-signed-up.ts");
    const before = await readFile(eventPath, "utf8");
    const edited = `${before}
// user edit
`;
    await writeFile(eventPath, edited);

    const second = runCli(["add", "event", "auth.user.signed_up", "--cwd", cwd]);
    expectCliStatus(second, 0, "second add event auth.user.signed_up");
    expect(second.stdout).toContain("skipped existing event file");
    expect(await readFile(eventPath, "utf8")).toBe(edited);
  });
});

describe("cli add event invalid name", () => {
  it("reports lowercase requirement for Post.Created", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-add-upper-event-"));
    await initWithRegistry(cwd);
    const result = runCli(["add", "event", "Post.Created", "--cwd", cwd]);
    expect(result.status).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toContain(
      'Event names must be lowercase (got "Post.Created"; try "post.created")',
    );
  });

  it.each(["BadName", "Checkout", "auth..user", ".auth.user", "auth.user.", "auth", "1auth.user", "auth_user.signed_up", "auth.user-signed"])(
    "rejects invalid event name %s after init",
    async (eventName) => {
      const cwd = await mkdtemp(path.join(tmpdir(), "amplio-add-invalid-event-"));
      await initWithRegistry(cwd);
      const result = runCli(["add", "event", eventName, "--cwd", cwd]);
      expect(result.status).not.toBe(0);
      expect(`${result.stderr}${result.stdout}`).toMatch(
        /Invalid event name|Event names must be lowercase/,
      );
    },
  );
});

describe("cli add event not in registry", () => {
  it("scaffolds template for valid dotted name missing from registry", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-add-event-unknown-"));
    await initWithRegistry(cwd);

    const eventName = "foo.bar.baz";
    const result = runCli(["add", "event", eventName, "--cwd", cwd]);
    expectCliStatus(result, 0, `add event ${eventName}`);
    expect(result.stdout).toContain(`amplio add event ${eventName}`);
    expect(result.stdout).toContain("generated starter schema (no registry template for foo.bar.baz)");
    expect(result.stdout).toContain("telemetry/events/foo/bar-baz.ts");

    const eventSource = await readFile(
      path.join(cwd, "telemetry/events/foo/bar-baz.ts"),
      "utf8",
    );
    expect(eventSource).toContain("FooBarBaz");
    expect(eventSource).toContain(eventName);
  });
});

describe("cli add missing name", () => {
  it("bare add exits non-zero with Missing add target", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-add-bare-"));
    await initWithRegistry(cwd);
    const result = runCli(["add", "--cwd", cwd]);
    expectCliStatus(result, 1, "bare add");
    expect(`${result.stderr}${result.stdout}`).toContain("Missing add target");
  });

  it("add event without name exits non-zero with Missing add name", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-add-event-no-name-"));
    await initWithRegistry(cwd);
    const result = runCli(["add", "event", "--cwd", cwd]);
    expectCliStatus(result, 1, "add event without name");
    expect(`${result.stderr}${result.stdout}`).toContain(
      "Missing add name. Example: amplio add event post.created",
    );
  });

  it("add sink without name exits non-zero with Missing add name", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-add-sink-no-name-"));
    await initWithRegistry(cwd);
    const result = runCli(["add", "sink", "--cwd", cwd]);
    expectCliStatus(result, 1, "add sink without name");
    expect(`${result.stderr}${result.stdout}`).toContain(
      "Missing add name. Example: amplio add sink console",
    );
  });

  it("add middleware without name exits non-zero with Missing add name", async () => {
    const cwd = await mkdtemp(
      path.join(tmpdir(), "amplio-add-middleware-no-name-"),
    );
    await initWithRegistry(cwd);
    const result = runCli(["add", "middleware", "--cwd", cwd]);
    expectCliStatus(result, 1, "add middleware without name");
    expect(`${result.stderr}${result.stdout}`).toContain(
      "Missing add name. Example: amplio add middleware hono",
    );
  });

  it("add enricher without name exits non-zero with Missing add name", async () => {
    const cwd = await mkdtemp(
      path.join(tmpdir(), "amplio-add-enricher-no-name-"),
    );
    await initWithRegistry(cwd);
    const result = runCli(["add", "enricher", "--cwd", cwd]);
    expectCliStatus(result, 1, "add enricher without name");
    expect(`${result.stderr}${result.stdout}`).toContain(
      "Missing add name. Example: amplio add enricher service-metadata",
    );
  });

  it("add integration without name exits non-zero with Missing add name", async () => {
    const cwd = await mkdtemp(
      path.join(tmpdir(), "amplio-add-integration-no-name-"),
    );
    await initWithRegistry(cwd);
    const result = runCli(["add", "integration", "--cwd", cwd]);
    expectCliStatus(result, 1, "add integration without name");
    expect(`${result.stderr}${result.stdout}`).toContain(
      "Missing add name. Example: amplio add integration better-auth",
    );
  });

  it("add sink with whitespace-only name exits non-zero with Missing add name", async () => {
    const cwd = await mkdtemp(
      path.join(tmpdir(), "amplio-add-sink-ws-name-"),
    );
    await initWithRegistry(cwd);
    const result = runCli(["add", "sink", "   ", "--cwd", cwd]);
    expectCliStatus(result, 1, "add sink whitespace-only name");
    expect(`${result.stderr}${result.stdout}`).toContain(
      "Missing add name. Example: amplio add sink console",
    );
  });
});

describe("cli add event force", () => {
  it("add with --force overwrites auth.user.signed_up with registry content", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-add-force-"));
    await initWithRegistry(cwd, "test-app");

    const first = runCli(["add", "event", "auth.user.signed_up", "--cwd", cwd]);
    expect(first.status).toBe(0);

    const eventPath = path.join(cwd, "telemetry/events/auth/user-signed-up.ts");
    const template = await readFile(eventPath, "utf8");
    await writeFile(eventPath, `${template}
// user edit
`);

    const forced = runCli([
      "add",
      "event",
      "auth.user.signed_up",
      "--cwd",
      cwd,
      "--force",
    ]);
    expect(forced.status).toBe(0);
    expect(forced.stdout).not.toContain("skipped existing event file");

    const after = await readFile(eventPath, "utf8");
    expect(after).toBe(template);
    expect(after).not.toContain("// user edit");
    expect(after).toContain("auth.user.signed_up");
    expect(after).toContain("AuthUserSignedUp");
    expect(after).toContain("signup");
  });
});

describe("cli add middleware idempotency", () => {
  it("second add hono exits 0 and preserves file (registry)", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-add-mw-idempotent-"));
    await initWithRegistry(cwd, "test-app");

    const first = runCli(["add", "middleware", "hono", "--cwd", cwd]);
    expectCliStatus(first, 0, "first add middleware hono");

    const middlewarePath = path.join(cwd, "telemetry/middleware/hono.ts");
    const before = await readFile(middlewarePath, "utf8");
    const edited = `${before}
// user edit
`;
    await writeFile(middlewarePath, edited);

    const second = runCli(["add", "middleware", "hono", "--cwd", cwd]);
    expectCliStatus(second, 0, "second add middleware hono");
    expect(second.stdout).toContain("skipped existing middleware file");
    expect(await readFile(middlewarePath, "utf8")).toBe(edited);
  });
});

describe("cli add middleware force", () => {
  it("add with --force overwrites hono with registry content", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-add-mw-force-"));
    await initWithRegistry(cwd, "test-app");

    const first = runCli(["add", "middleware", "hono", "--cwd", cwd]);
    expectCliStatus(first, 0, "first add middleware hono");

    const middlewarePath = path.join(cwd, "telemetry/middleware/hono.ts");
    const template = await readFile(middlewarePath, "utf8");
    await writeFile(middlewarePath, `${template}
// user edit
`);

    const forced = runCli([
      "add",
      "middleware",
      "hono",
      "--cwd",
      cwd,
      "--force",
    ]);
    expectCliStatus(forced, 0, "add middleware hono --force");
    expect(forced.stdout).not.toContain("skipped existing middleware file");

    const after = await readFile(middlewarePath, "utf8");
    expect(after).toBe(template);
    expect(after).not.toContain("// user edit");
    expect(after).toContain("amplioMiddleware");
    expect(after).toContain("MiddlewareHandler");
  });
});

describe("cli add middleware unknown", () => {
  it("fails clearly for unknown middleware", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-add-unknown-middleware-"));
    await initWithRegistry(cwd);
    const result = runCli(["add", "middleware", "nope", "--cwd", cwd]);
    expect(result.status).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toContain("Unknown middleware");
  });
});

describe("cli add sink idempotency", () => {
  it("second add console exits 0 and preserves file (registry)", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-add-sink-idempotent-"));
    await initWithRegistry(cwd, "test-app");

    const first = runCli(["add", "sink", "console", "--cwd", cwd]);
    expectCliStatus(first, 0, "first add sink console");

    const sinkPath = path.join(cwd, "telemetry/sinks/console.ts");
    const before = await readFile(sinkPath, "utf8");
    const edited = `${before}
// user edit
`;
    await writeFile(sinkPath, edited);

    const second = runCli(["add", "sink", "console", "--cwd", cwd]);
    expectCliStatus(second, 0, "second add sink console");
    expect(second.stdout).toContain("skipped existing sink file");
    expect(await readFile(sinkPath, "utf8")).toBe(edited);
  });
});

describe("cli add sink force", () => {
  it("add with --force overwrites console with registry content", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-add-sink-force-"));
    await initWithRegistry(cwd, "test-app");
    const first = runCli(["add", "sink", "console", "--cwd", cwd]);
    expectCliStatus(first, 0, "first add sink console");
    const sinkPath = path.join(cwd, "telemetry/sinks/console.ts");
    const template = await readFile(sinkPath, "utf8");
    await writeFile(sinkPath, `${template}\n// user edit\n`);
    const forced = runCli(["add", "sink", "console", "--cwd", cwd, "--force"]);
    expectCliStatus(forced, 0, "add sink console --force");
    expect(forced.stdout).not.toContain("skipped existing sink file");
    const after = await readFile(sinkPath, "utf8");
    expect(after).toBe(template);
    expect(after).not.toContain("// user edit");
    expect(after).toContain("consoleSink");
    expect(after).toContain("LogRecord");
  });
});


describe("cli add sink unknown", () => {
  it("fails clearly for unknown sink", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-add-unknown-sink-"));
    await initWithRegistry(cwd);
    const result = runCli(["add", "sink", "not-a-real-sink", "--cwd", cwd]);
    expect(result.status).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toContain("Unknown sink");
  });
});


describe("cli add sink otlp without init", () => {
  it("add sink otlp without prior init creates telemetry/sinks/otlp.ts", async () => {
    const cwd = await mkdtemp(
      path.join(tmpdir(), "amplio-add-sink-otlp-no-init-"),
    );

    const result = runCli(["add", "sink", "otlp", "--cwd", cwd]);
    expectCliStatus(result, 0, "add sink otlp without init");

    const sinkPath = path.join(cwd, "telemetry/sinks/otlp.ts");
    await access(sinkPath);
    const source = await readFile(sinkPath, "utf8");
    expect(source).toContain("otlpSink");
  });
});


describe("cli add sink console nested cwd", () => {
  it("add sink console --cwd nonexistent nested path exits 0 and creates the sink file (mkdir -p)", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "amplio-add-sink-mkdirp-"));
    const cwd = path.join(parent, "nested", "deep", "project");
    expect(existsSync(cwd)).toBe(false);

    const result = runCli(["add", "sink", "console", "--cwd", cwd]);
    expectCliStatus(result, 0, "add sink console --cwd nonexistent nested path");

    expect(existsSync(path.join(cwd, "telemetry/sinks/console.ts"))).toBe(true);
  });
});

describe("cli add enricher idempotency", () => {
  it("second add service-metadata exits 0 and preserves file (registry)", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-add-enricher-idempotent-"));
    await initWithRegistry(cwd, "test-app");

    const first = runCli(["add", "enricher", "service-metadata", "--cwd", cwd]);
    expectCliStatus(first, 0, "first add enricher service-metadata");

    const enricherPath = path.join(cwd, "telemetry/enrichers/service-metadata.ts");
    const before = await readFile(enricherPath, "utf8");
    const edited = `${before}
// user edit
`;
    await writeFile(enricherPath, edited);

    const second = runCli(["add", "enricher", "service-metadata", "--cwd", cwd]);
    expectCliStatus(second, 0, "second add enricher service-metadata");
    expect(second.stdout).toContain("skipped existing enricher file");
    expect(await readFile(enricherPath, "utf8")).toBe(edited);
  });
});

describe("cli add enricher force", () => {
  it("add with --force overwrites service-metadata with registry content", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-add-enricher-force-"));
    await initWithRegistry(cwd, "test-app");

    const first = runCli(["add", "enricher", "service-metadata", "--cwd", cwd]);
    expectCliStatus(first, 0, "first add enricher service-metadata");

    const enricherPath = path.join(cwd, "telemetry/enrichers/service-metadata.ts");
    const template = await readFile(enricherPath, "utf8");
    await writeFile(enricherPath, `${template}
// user edit
`);

    const forced = runCli([
      "add",
      "enricher",
      "service-metadata",
      "--cwd",
      cwd,
      "--force",
    ]);
    expectCliStatus(forced, 0, "add enricher service-metadata --force");
    expect(forced.stdout).not.toContain("skipped existing enricher file");

    const after = await readFile(enricherPath, "utf8");
    expect(after).toBe(template);
    expect(after).not.toContain("// user edit");
    expect(after).toContain("serviceMetadata");
    expect(after).toContain("LogRecord");
  });
});


describe("cli add enricher unknown", () => {
  it("fails clearly for unknown enricher", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-add-unknown-enricher-"));
    await initWithRegistry(cwd);
    const result = runCli(["add", "enricher", "not-a-real-enricher", "--cwd", cwd]);
    expect(result.status).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toContain("Unknown enricher");
  });
});


describe("cli add integration resend without init", () => {
  it("add integration resend without prior init creates the integration file", async () => {
    const cwd = await mkdtemp(
      path.join(tmpdir(), "amplio-add-integration-resend-no-init-"),
    );

    const result = runCli(["add", "integration", "resend", "--cwd", cwd]);
    expectCliStatus(result, 0, "add integration resend without init");

    const integrationPath = path.join(cwd, "telemetry/integrations/resend.ts");
    const source = await readFile(integrationPath, "utf8");
    expect(source).toContain("trackResendEmail");
    expect(source).toContain("handleResendWebhook");
  });
});


describe("cli add integration clerk without init", () => {
  it("add integration clerk without prior init creates the integration file", async () => {
    const cwd = await mkdtemp(
      path.join(tmpdir(), "amplio-add-integration-clerk-no-init-"),
    );

    const result = runCli(["add", "integration", "clerk", "--cwd", cwd]);
    expectCliStatus(result, 0, "add integration clerk without init");

    const integrationPath = path.join(cwd, "telemetry/integrations/clerk.ts");
    const source = await readFile(integrationPath, "utf8");
    expect(source).toContain("trackClerkUserCreated");
    expect(source).toContain("handleClerkWebhook");
  });
});


describe("cli add integration polar without init", () => {
  it("add integration polar without prior init creates the integration file", async () => {
    const cwd = await mkdtemp(
      path.join(tmpdir(), "amplio-add-integration-polar-no-init-"),
    );

    const result = runCli(["add", "integration", "polar", "--cwd", cwd]);
    expectCliStatus(result, 0, "add integration polar without init");

    const integrationPath = path.join(cwd, "telemetry/integrations/polar.ts");
    const source = await readFile(integrationPath, "utf8");
    expect(source).toContain("trackPolarOrderPaid");
    expect(source).toContain("handlePolarWebhook");
  });
});

describe("cli add integration idempotency", () => {
  it("second add resend exits 0 and preserves file (registry)", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-add-integration-idempotent-"));
    await initWithRegistry(cwd, "test-app");

    const first = runCli(["add", "integration", "resend", "--cwd", cwd]);
    expectCliStatus(first, 0, "first add integration resend");

    const integrationPath = path.join(cwd, "telemetry/integrations/resend.ts");
    const before = await readFile(integrationPath, "utf8");
    const edited = `${before}
// user edit
`;
    await writeFile(integrationPath, edited);

    const second = runCli(["add", "integration", "resend", "--cwd", cwd]);
    expectCliStatus(second, 0, "second add integration resend");
    expect(second.stdout).toContain("skipped existing integration file");
    expect(await readFile(integrationPath, "utf8")).toBe(edited);
  });
});

describe("cli add integration resend force", () => {
  it("add with --force overwrites resend with registry content", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-add-integration-resend-force-"));
    await initWithRegistry(cwd, "test-app");

    const first = runCli(["add", "integration", "resend", "--cwd", cwd]);
    expectCliStatus(first, 0, "first add integration resend");

    const integrationPath = path.join(cwd, "telemetry/integrations/resend.ts");
    const template = await readFile(integrationPath, "utf8");
    await writeFile(integrationPath, `${template}
// user edit
`);

    const forced = runCli([
      "add",
      "integration",
      "resend",
      "--cwd",
      cwd,
      "--force",
    ]);
    expectCliStatus(forced, 0, "add integration resend --force");
    expect(forced.stdout).not.toContain("skipped existing integration file");

    const after = await readFile(integrationPath, "utf8");
    expect(after).toBe(template);
    expect(after).not.toContain("// user edit");
    expect(after).toContain("trackResendEmail");
    expect(after).toContain("handleResendWebhook");
  });
});


describe("cli add integration unknown", () => {
  it("fails clearly for unknown integration", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-add-unknown-integration-"));
    await initWithRegistry(cwd);
    const result = runCli(["add", "integration", "not-a-real-integration", "--cwd", cwd]);
    expect(result.status).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toContain("Unknown integration");
  });
});

describe("cli --version", () => {
  it("prints package.json version with --version", () => {
    const result = runCli(["--version"]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(cliPackageVersion);
  });
  it("prints package.json version with -V", () => {
    const result = runCli(["-V"]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(cliPackageVersion);
  });
});
