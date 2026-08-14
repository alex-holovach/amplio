import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import {
  runAddEnricher,
  runAddEvent,
  runAddPlugin,
  runAddSink,
} from "./commands/add.js";
import { runDoctor } from "./commands/doctor.js";
import { runInit } from "./commands/init.js";
import { runList } from "./commands/list.js";
import { runPaths } from "./commands/paths.js";
import { runSmoke } from "./commands/smoke.js";
import {
  runDiffPlugin,
  runRemovePlugin,
  runUpdatePlugin,
} from "./commands/plugin-lifecycle.js";
import { printCommandHelp, printGlobalHelp } from "./help.js";

const { version } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};
const ADD_KINDS = ["event", "plugin", "sink", "enricher"] as const;
type AddKind = (typeof ADD_KINDS)[number];

function parseCliArgs() {
  try {
    return parseArgs({
      allowPositionals: true,
      allowNegative: true,
      options: {
        cwd: { type: "string", default: "." },
        service: { type: "string" },
        "package-manager": { type: "string" },
        event: { type: "string" },
        target: { type: "string" },
        "source-only": { type: "boolean", default: false },
        yes: { type: "boolean", default: false },
        "skip-install": { type: "boolean", default: false },
        paths: { type: "boolean" },
        verbose: { type: "boolean", default: false },
        force: { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        strict: { type: "boolean", default: false },
        timeout: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "V", default: false },
      },
    });
  } catch (error) {
    if (error instanceof Error && "code" in error) {
      console.error(`error: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}

function invalidOption(condition: boolean, message: string): void {
  if (!condition) return;
  console.error(`error: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const { values, positionals } = parseCliArgs();
  if (values.version) {
    console.log(version);
    return;
  }
  const command = positionals[0]?.trim();
  if (values.help) {
    if (!command || !printCommandHelp(command)) printGlobalHelp();
    return;
  }
  if (!command) {
    printGlobalHelp();
    process.exit(1);
  }
  const cwd = values.cwd?.trim() || ".";
  const pluginAdd = command === "add" && positionals[1]?.trim() === "plugin";

  invalidOption(
    Boolean(values.force) && command !== "add" && command !== "init",
    "--force is only valid with init or add",
  );
  invalidOption(
    Boolean(values["dry-run"]) && command !== "add",
    "--dry-run is only valid with add",
  );
  invalidOption(
    Boolean(values.json) && command !== "list",
    "--json is only valid with list",
  );
  invalidOption(
    Boolean(values.strict) && command !== "doctor",
    "--strict is only valid with doctor",
  );
  invalidOption(
    values.timeout !== undefined && command !== "smoke",
    "--timeout is only valid with smoke",
  );
  invalidOption(
    Boolean(values.event?.trim()) && !pluginAdd,
    "--event is only valid with add plugin",
  );
  invalidOption(
    Boolean(values.target?.trim()) && !pluginAdd,
    "--target is only valid with add plugin",
  );
  invalidOption(
    Boolean(values["source-only"]) && !pluginAdd,
    "--source-only is only valid with add plugin",
  );
  invalidOption(
    Boolean(values.target?.trim()) && Boolean(values["source-only"]),
    "--target selects an active Plugin seam and cannot be used with --source-only",
  );
  invalidOption(
    Boolean(values.service?.trim()) && command !== "init",
    "--service is only valid with init",
  );
  invalidOption(
    Boolean(values["package-manager"]?.trim()) && command !== "init",
    "--package-manager is only valid with init",
  );
  invalidOption(
    Boolean(values.yes) && command !== "init" && !pluginAdd,
    "--yes is only valid with init or add plugin",
  );
  invalidOption(
    Boolean(values["skip-install"]) && command !== "init",
    "--skip-install is only valid with init",
  );
  invalidOption(
    values.paths !== undefined && command !== "init",
    "--paths/--no-paths is only valid with init",
  );
  invalidOption(
    Boolean(values.verbose) && command !== "init" && command !== "doctor",
    "--verbose is only valid with init or doctor",
  );

  try {
    if (command === "init") {
      const packageManager = values["package-manager"]?.trim().toLowerCase();
      const allowed = ["pnpm", "npm", "yarn", "bun"] as const;
      if (
        packageManager &&
        !allowed.includes(packageManager as (typeof allowed)[number])
      ) {
        throw new Error(
          `Unknown package manager "${packageManager}". Use: ${allowed.join(", ")}`,
        );
      }
      await runInit({
        cwd,
        ...(values.service?.trim() ? { service: values.service.trim() } : {}),
        ...(packageManager
          ? { packageManager: packageManager as (typeof allowed)[number] }
          : {}),
        ...(values.yes ? { yes: true } : {}),
        ...(values["skip-install"] ? { skipInstall: true } : {}),
        ...(values.paths !== undefined ? { paths: values.paths } : {}),
        ...(values.verbose ? { verbose: true } : {}),
        ...(values.force ? { force: true } : {}),
      });
      return;
    }

    if (command === "add") {
      const kind = positionals[1]?.trim();
      if (!kind || !ADD_KINDS.includes(kind as AddKind)) {
        throw new Error(
          kind
            ? `Unknown add kind "${kind}". Valid kinds: ${ADD_KINDS.join(", ")}`
            : "Missing add target. Example: amplio add event order.placed",
        );
      }
      const ids = positionals
        .slice(2)
        .map((id) => id.trim())
        .filter(Boolean);
      if (ids.length === 0) {
        const examples: Record<AddKind, string> = {
          event: "amplio add event order.placed",
          plugin: "amplio add plugin resend --event http.request",
          sink: "amplio add sink console",
          enricher: "amplio add enricher service-metadata",
        };
        throw new Error(
          `Missing add name. Example: ${examples[kind as AddKind]}`,
        );
      }
      if (kind === "plugin" && ids.length !== 1) {
        throw new Error(
          "Expected one Plugin slug. Usage: amplio add plugin <slug> [--event <root-event-id>]",
        );
      }
      const options = {
        cwd,
        force: values.force ?? false,
        dryRun: values["dry-run"] ?? false,
        sourceOnly: values["source-only"] ?? false,
        yes: values.yes ?? false,
        ...(values.event?.trim() ? { event: values.event.trim() } : {}),
        ...(values.target?.trim() ? { target: values.target.trim() } : {}),
      };
      for (const id of ids) {
        if (kind === "event") await runAddEvent(id, options);
        else if (kind === "plugin") await runAddPlugin(id, options);
        else if (kind === "sink") await runAddSink(id, options);
        else await runAddEnricher(id, options);
      }
      return;
    }

    if (command === "list") {
      await runList({
        cwd,
        ...(positionals[1]?.trim() ? { kind: positionals[1]!.trim() } : {}),
        ...(values.json ? { json: true } : {}),
      });
      return;
    }
    if (command === "diff" || command === "update" || command === "remove") {
      const kind = positionals[1]?.trim();
      const slug = positionals[2]?.trim();
      if (kind !== "plugin") {
        throw new Error(
          `Missing Plugin target. Example: amplio ${command} plugin resend`,
        );
      }
      if (!slug) {
        throw new Error(
          `Missing Plugin slug. Example: amplio ${command} plugin resend`,
        );
      }
      if (positionals.slice(3).some((value) => value.trim())) {
        throw new Error(
          `Expected one Plugin slug. Usage: amplio ${command} plugin <slug>`,
        );
      }
      if (command === "diff") await runDiffPlugin(slug, { cwd });
      else if (command === "update") await runUpdatePlugin(slug, { cwd });
      else await runRemovePlugin(slug, { cwd });
      return;
    }
    if (command === "doctor") {
      process.exit(
        await runDoctor({
          cwd,
          ...(values.strict ? { strict: true } : {}),
          ...(values.verbose ? { verbose: true } : {}),
        }),
      );
    }
    if (command === "paths") {
      await runPaths({ cwd });
      return;
    }
    if (command === "smoke") {
      const url = positionals[1]?.trim();
      if (!url)
        throw new Error(
          "Missing URL. Example: amplio smoke http://localhost:3000/health",
        );
      const timeout =
        values.timeout === undefined ? undefined : Number(values.timeout);
      if (
        timeout !== undefined &&
        (!Number.isFinite(timeout) || timeout <= 0)
      ) {
        throw new Error("--timeout must be a positive number of seconds");
      }
      process.exit(
        await runSmoke({
          cwd,
          url,
          ...(timeout !== undefined ? { timeoutSeconds: timeout } : {}),
        }),
      );
    }
    throw new Error(`Unknown command "${command}".`);
  } catch (error) {
    console.error(
      `error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

void main();
