export function printGlobalHelp(): void {
  console.log(`amplio — open-code Event + Plugin telemetry

Usage:
  amplio init [options]       Create telemetry/runtime.ts, Events, and detected boundary Plugins
  amplio add <kind> <id>      Add an Event, Plugin, sink, or enricher
  amplio diff plugin <slug>   Compare local, installed, and registry Plugin source
  amplio update plugin <slug> Three-way merge a newer Plugin recipe
  amplio remove plugin <slug> Safely remove Plugin source and managed wiring
  amplio list [kind]          List Event + Plugin registry recipes
  amplio doctor [options]     Validate the vNext telemetry layout
  amplio paths                Add the ~telemetry/* tsconfig alias
  amplio smoke <url>          Verify a response and emitted root Event

Run amplio <command> --help for command-specific options.
`);
}

export function printInitHelp(): void {
  console.log(`amplio init — scaffold open-code Event telemetry

Usage:
  amplio init [options]

Options:
  --cwd <path>                 Project directory (default: .)
  --service <name>             Service name (defaults to package.json name)
  --package-manager <pm>       pnpm | npm | yarn | bun
  --yes                        Install the detected supported boundary Plugin (Hono in this slice)
  --skip-install               Do not run the package manager
  --force                      Overwrite colliding untracked generated files
  --paths / --no-paths         Add or skip the ~telemetry/* tsconfig alias
  --verbose                    Stream package-manager output
  -h, --help                   Show this help

Example:
  amplio init --yes --service my-api
`);
}

export function printAddHelp(): void {
  console.log(`amplio add — add open code to telemetry/

Usage:
  amplio add event <event-id>
  amplio add plugin hono
  amplio add plugin resend --event <root-event-id>
  amplio add sink <console|json|otlp>
  amplio add enricher service-metadata

Options:
  --cwd <path>                 Project directory (default: .)
  --event <event-id>           Root Event receiving a contributor Plugin subtree
  --target <relative-source-file>
                               Select one contained seam or adopt verified Next/Express wiring
  --source-only                Copy inert Plugin source without composing or wiring it
  --yes                        Approve the complete Plugin recipe dependency plan
  --force                      Overwrite an Event or operational recipe
  --dry-run                    Preview files, dependencies, and rollback boundaries
  -h, --help                   Show this help

Examples:
  amplio add event order.placed
  amplio add plugin resend --event http.request
  amplio add plugin ai-sdk --event http.request
  amplio add plugin resend --event http.request --target src/email.ts
  amplio add plugin next --target app/api/health/route.ts
  amplio add sink otlp --dry-run

Dependency installs roll back tracked package, lock, source, and state files.
Package-manager cache, node_modules, and dependency lifecycle scripts are not reversible.
`);
}

export function printListHelp(): void {
  console.log(`amplio list — list registry recipes

Usage:
  amplio list [event|plugin|sink|enricher]

Options:
  --cwd <path>                 Project directory (default: .)
  --json                       Print machine-readable JSON
  -h, --help                   Show this help
`);
}

function printPluginLifecycleHelp(command: "diff" | "update" | "remove"): void {
  const descriptions = {
    diff: "compare local, installed, and registry Plugin source",
    update: "three-way merge a newer open-code Plugin recipe",
    remove: "remove unmodified Plugin source and reverse managed wiring",
  } as const;
  console.log(`amplio ${command} plugin — ${descriptions[command]}

Usage:
  amplio ${command} plugin <slug>

Options:
  --cwd <path>                 Project directory (default: .)
  -h, --help                   Show this help
`);
}

export function printDoctorHelp(): void {
  console.log(`amplio doctor — validate Event + Plugin layout

Usage:
  amplio doctor [--strict] [--verbose]

Options:
  --cwd <path>                 Project directory (default: .)
  --strict                     Fail when warnings are present
  --verbose                    Print migration context on failure
  -h, --help                   Show this help
`);
}

export function printPathsHelp(): void {
  console.log(`amplio paths — add the ~telemetry/* tsconfig alias

Usage:
  amplio paths [--cwd <path>]
`);
}

export function printSmokeHelp(): void {
  console.log(`amplio smoke — verify one request and emitted root Event

Usage:
  amplio smoke <url> [--timeout <seconds>] [--cwd <path>]

Requires the JSON sink: amplio add sink json
`);
}

const COMMAND_HELP: Record<string, () => void> = {
  init: printInitHelp,
  add: printAddHelp,
  diff: () => printPluginLifecycleHelp("diff"),
  update: () => printPluginLifecycleHelp("update"),
  remove: () => printPluginLifecycleHelp("remove"),
  list: printListHelp,
  doctor: printDoctorHelp,
  paths: printPathsHelp,
  smoke: printSmokeHelp,
};

export function printCommandHelp(command: string): boolean {
  const print = COMMAND_HELP[command];
  if (!print) return false;
  print();
  return true;
}
