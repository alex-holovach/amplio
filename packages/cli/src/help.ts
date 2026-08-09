const ALPHA_MD_URL = "https://github.com/alex-holovach/amplio/blob/main/ALPHA.md";
const T3_MD_URL = "https://github.com/alex-holovach/amplio/blob/main/docs/t3.md";

export { ALPHA_MD_URL, T3_MD_URL };

export function printGlobalHelp(): void {
  console.log(`amplio — schema-first wide-event telemetry scaffolding

Usage:
  amplio init [options]       Scaffold telemetry/ in your project
  amplio add <kind> <id>      Add registry item (event, middleware, sink, …)
  amplio list [kind]          List registry items
  amplio doctor [options]     Validate wiring and event layout

Commands:
  init, add, list, doctor     Run amplio <command> --help for command-specific flags

Global options:
  --cwd <path>                Project directory (default: .)
  -h, --help                  Show help (global or per-command)
  -V, --version               Print version
`);
}

export function printInitHelp(): void {
  console.log(`amplio init — scaffold telemetry/ in your project

Usage:
  amplio init [options]

Options:
  --cwd <path>                 Project directory (default: .)
  --service <name>             Service name for logger.ts (defaults to package.json name)
  --package-manager <pm>       pnpm | npm | yarn | bun
  --no-typescript              Disable TypeScript defaults in amplio.json
  --middleware <name|none>     Scaffold middleware (auto-detect from package.json)
  --event <name|none>          Scaffold starter event (defaults to auth.user.signed_up when auto and an auth dependency is detected)
  --yes                        Non-interactive: auto-scaffold detected middleware + event
  --skip-install               Skip installing @useamplio/amplio and zod
  --paths                      Write ~telemetry/* tsconfig path alias
  -h, --help                   Show this help

Example:
  amplio init --yes --service my-api
`);
}

export function printAddHelp(): void {
  console.log(`amplio add — install a registry item into telemetry/

Usage:
  amplio add event <domain.action or domain.entity.action>
  amplio add middleware <hono|express|next|fastify|trpc>
  amplio add sink <console|otlp|json>
  amplio add enricher <service-metadata|request|request-metadata>
  amplio add integration <better-auth|clerk|resend|polar>

Options:
  --cwd <path>                 Project directory (default: .)
  --force                      Overwrite generated files
  -h, --help                   Show this help

Examples:
  amplio add event post.created
  amplio add event auth.user.signed_up
  amplio add middleware hono
`);
}

export function printDoctorHelp(): void {
  console.log(`amplio doctor — validate telemetry wiring and event layout

Usage:
  amplio doctor [options]

Options:
  --cwd <path>                 Project directory (default: .)
  --fix                        Regenerate missing event barrel exports
  --strict                     Exit non-zero on warnings (CI gate)
  -h, --help                   Show this help

Example:
  amplio doctor --strict
`);
}

export function printListHelp(): void {
  console.log(`amplio list — list registry items

Usage:
  amplio list [kind]

Kinds:
  event, middleware, sink, enricher, integration

Options:
  --cwd <path>                 Project directory (default: .)
  --json                       Print machine-readable JSON (no decorative text)
  -h, --help                   Show this help

Example:
  amplio list sink --json
`);
}

const COMMAND_HELP: Record<string, () => void> = {
  init: printInitHelp,
  add: printAddHelp,
  doctor: printDoctorHelp,
  list: printListHelp,
};

export function printCommandHelp(command: string): boolean {
  const print = COMMAND_HELP[command];
  if (!print) {
    return false;
  }
  print();
  return true;
}
