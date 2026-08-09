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
  amplio paths                Write the ~telemetry/* tsconfig path alias (nothing else)
  amplio smoke <url>          Hit a wrapped route and verify an event is emitted (PASS/FAIL)

Commands:
  init, add, list, doctor, paths, smoke   Run amplio <command> --help for command-specific flags

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
  --yes                        Non-interactive: auto-scaffold detected middleware + event (auto-wires create-t3-app layouts, applies ~telemetry/* path alias)
  --skip-install               Skip installing @useamplio/amplio and zod
  --paths / --no-paths         Write the ~telemetry/* tsconfig path alias (default: on under --yes; standalone: amplio paths)
  --wire                       Auto-wire create-t3-app files (route handler + tRPC procedures)
  --verbose                    Stream raw package-manager install output
  -h, --help                   Show this help

Examples:
  amplio init --yes --service my-api
  amplio init --wire --paths
`);
}

export function printAddHelp(): void {
  console.log(`amplio add — install a registry item into telemetry/

Usage:
  amplio add event <domain.action or domain.entity.action> [more names…]
  amplio add middleware <hono|express|next|fastify|trpc>
  amplio add sink <console|otlp|json>
  amplio add enricher <service-metadata|request-metadata|query-allowlist>
  amplio add integration <better-auth|clerk|next-auth|resend|polar>

Options:
  --cwd <path>                 Project directory (default: .)
  --force                      Overwrite generated files
  --dry-run                    Preview what would be created/updated/wired — writes nothing
  -h, --help                   Show this help

Examples:
  amplio add event post.created
  amplio add event auth.user.signed_up
  amplio add event post.created comment.created vote.cast
  amplio add middleware hono
  amplio add sink otlp --dry-run
`);
}

export function printDoctorHelp(): void {
  console.log(`amplio doctor — validate telemetry wiring and event layout

Usage:
  amplio doctor [options]

Options:
  --cwd <path>                 Project directory (default: .)
  --fix                        Regenerate missing barrel exports and prune stale ones
  --strict                     Exit non-zero on warnings (CI gate)
  --verbose                    Always print the end-to-end verification epilogue
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

export function printPathsHelp(): void {
  console.log(`amplio paths — write the ~telemetry/* tsconfig path alias

Usage:
  amplio paths

Adds "~telemetry/*": ["./<telemetryDir>/*"] to tsconfig.json compilerOptions.paths
(JSONC-comment-safe, idempotent). Does not re-run any other init step.

Options:
  --cwd <path>                 Project directory (default: .)
  -h, --help                   Show this help
`);
}

export function printSmokeHelp(): void {
  console.log(`amplio smoke — end-to-end verification: request in, event out

Usage:
  amplio smoke <url> [options]

Makes an HTTP request to <url> (a route wrapped with amplio middleware, dev
server already running) and watches amplio*.jsonl for a newly emitted row.
Reports PASS when both the response and an event arrive — a wrong-port curl
or unwired middleware becomes an explicit FAIL instead of silent nothing.

Requires the JSON file sink (amplio add sink json): the console sink writes to
the dev server's stdout, which this process cannot observe.

Options:
  --cwd <path>                 Project directory (default: .)
  --timeout <seconds>          How long to wait for the response/row (default: 10)
  -h, --help                   Show this help

Example:
  amplio smoke 'http://localhost:3000/api/trpc/post.hello?batch=1&input=%7B%7D'
`);
}

const COMMAND_HELP: Record<string, () => void> = {
  init: printInitHelp,
  add: printAddHelp,
  doctor: printDoctorHelp,
  list: printListHelp,
  paths: printPathsHelp,
  smoke: printSmokeHelp,
};

export function printCommandHelp(command: string): boolean {
  const print = COMMAND_HELP[command];
  if (!print) {
    return false;
  }
  print();
  return true;
}
