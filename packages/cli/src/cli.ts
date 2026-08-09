import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { runInit } from "./commands/init.js";

const { version } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};
import {
  runAddEnricher,
  runAddEvent,
  runAddIntegration,
  runAddMiddleware,
  runAddSink,
} from "./commands/add.js";
import { runList } from "./commands/list.js";
import { runDoctor } from "./commands/doctor.js";

const VALID_ADD_KINDS = [
  "event",
  "middleware",
  "sink",
  "enricher",
  "integration",
] as const;

function printHelp(): void {
  console.log(`amplio — schema-first wide-event telemetry scaffolding

Usage:
  amplio init [options]
  amplio doctor [--fix] [options]
  amplio list [kind]   List registry items (id, title, description)
  amplio add event <domain.entity.action>
  amplio add middleware <hono|express|next|fastify|trpc>
  amplio add sink <console|otlp|json>
  amplio add enricher <service-metadata|request|request-metadata>
  amplio add integration <better-auth|clerk|resend|polar>

Options:
  --cwd <path>                 Project directory (default: .)
  --service <name>             Service name for logger.ts (init; defaults to package.json name)
  --package-manager <pm>       pnpm | npm | yarn | bun (init)
  --no-typescript              Disable TypeScript defaults in amplio.json (init)
  --middleware <name|none>     Scaffold middleware on init (auto-detect from package.json)
  --event <name|none>          Scaffold event on init (default: auth.user.signed_up when auto)
  --yes                        Non-interactive init: auto-scaffold detected middleware + event
  --skip-install               Skip installing @useamplio/amplio and zod (init)
  --paths                      Write ~telemetry/* tsconfig path alias (init)
  --fix                        Regenerate missing event barrel exports (doctor)
  --force                      Overwrite generated files (add)
  -h, --help                   Show help
  -V, --version                Print version
`);
}

function parseCliArgs() {
  try {
    return parseArgs({
      allowPositionals: true,
      allowNegative: true,
      options: {
        cwd: { type: "string", default: "." },
        service: { type: "string" },
        "package-manager": { type: "string" },
        typescript: { type: "boolean", default: true },
        middleware: { type: "string" },
        event: { type: "string" },
        yes: { type: "boolean", default: false },
        "skip-install": { type: "boolean", default: false },
        paths: { type: "boolean", default: false },
        fix: { type: "boolean", default: false },
        force: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "V", default: false },
      },
    });
  } catch (error) {
    if (error instanceof Error && "code" in error) {
      if (error.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
        const match = /Unknown option '([^']+)'/.exec(error.message);
        const option = match?.[1] ?? "unknown";
        console.error(`error: Unknown option '${option}'`);
        process.exit(1);
      }
      if (error.code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
        console.error(`error: ${error.message}`);
        process.exit(1);
      }
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseCliArgs();

  if (values.version) {
    console.log(version);
    process.exit(0);
  }

  const command = positionals[0]?.trim();
  if (values.help || !command) {
    printHelp();
    process.exit(values.help ? 0 : 1);
  }
  const cwd = (values.cwd ?? ".").trim() || ".";

  if (values.force && command !== "add") {
    console.error("error: --force is only valid with add");
    process.exit(1);
  }

  if (values.fix && command !== "doctor") {
    console.error("error: --fix is only valid with doctor");
    process.exit(1);
  }

  if (values.paths && command !== "init") {
    console.error("error: --paths is only valid with init");
    process.exit(1);
  }

  if (command !== "init") {
    if (values.service?.trim()) {
      console.error("error: --service is only valid with init");
      process.exit(1);
    }
    if (values["package-manager"]?.trim()) {
      console.error("error: --package-manager is only valid with init");
      process.exit(1);
    }
    if (values.typescript === false) {
      console.error("error: --no-typescript is only valid with init");
      process.exit(1);
    }
    if (values.middleware?.trim()) {
      console.error("error: --middleware is only valid with init");
      process.exit(1);
    }
    if (values.event?.trim()) {
      console.error("error: --event is only valid with init");
      process.exit(1);
    }
    if (values.yes) {
      console.error("error: --yes is only valid with init");
      process.exit(1);
    }
    if (values["skip-install"]) {
      console.error("error: --skip-install is only valid with init");
      process.exit(1);
    }
  }

  try {
    if (command === "init") {
      const allowedPackageManagers = ["pnpm", "npm", "yarn", "bun"] as const;
      type PackageManager = (typeof allowedPackageManagers)[number];
      const packageManager = values["package-manager"]?.trim().toLowerCase();
      if (
        packageManager &&
        !(allowedPackageManagers as readonly string[]).includes(packageManager)
      ) {
        throw new Error(
          `Unknown package manager "${packageManager}". Use: pnpm, npm, yarn, bun`,
        );
      }
      const service = values.service?.trim();
      const middleware = values.middleware?.trim();
      const event = values.event?.trim();
      await runInit({
        cwd,
        ...(service ? { service } : {}),
        ...(packageManager
          ? { packageManager: packageManager as PackageManager }
          : {}),
        typescript: values.typescript,
        ...(middleware ? { middleware } : {}),
        ...(event ? { event } : {}),
        ...(values.yes ? { yes: true } : {}),
        ...(values["skip-install"] ? { skipInstall: true } : {}),
        ...(values.paths ? { paths: true } : {}),
      });
      return;
    }

    if (command === "list") {
      const kind = positionals[1]?.trim();
      await runList({
        cwd,
        ...(kind ? { kind } : {}),
      });
      return;
    }

    if (command === "add") {
      const kind = positionals[1]?.trim();
      const id = positionals[2]?.trim();

      if (!kind) {
        throw new Error("Missing add target. Example: amplio add event auth.user.signed_up");
      }

      if (!(VALID_ADD_KINDS as readonly string[]).includes(kind)) {
        throw new Error(
          `Unknown add kind "${kind}". Valid kinds: event, middleware, sink, enricher, integration.`,
        );
      }

      if (!id) {
        const examples: Record<(typeof VALID_ADD_KINDS)[number], string> = {
          event: "amplio add event auth.user.signed_up",
          middleware: "amplio add middleware hono",
          sink: "amplio add sink console",
          enricher: "amplio add enricher service-metadata",
          integration: "amplio add integration better-auth",
        };
        throw new Error(`Missing add name. Example: ${examples[kind as (typeof VALID_ADD_KINDS)[number]]}`);
      }

      const options = { cwd, force: values.force ?? false };

      switch (kind as (typeof VALID_ADD_KINDS)[number]) {
        case "event":
          await runAddEvent(id, options);
          return;
        case "middleware":
          await runAddMiddleware(id, options);
          return;
        case "sink":
          await runAddSink(id, options);
          return;
        case "enricher":
          await runAddEnricher(id, options);
          return;
        case "integration":
          await runAddIntegration(id, options);
          return;
      }
    }

    if (command === "doctor") {
      const exitCode = await runDoctor({ cwd, ...(values.fix ? { fix: true } : {}) });
      process.exit(exitCode);
    }

    throw new Error(`Unknown command "${command}".`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`error: ${message}`);
    process.exit(1);
  }
}

main();
