# @useamplio/cli

Scaffold editable Event definitions, framework and contributor Plugins, sinks,
and resource enrichers under `telemetry/`.

## Start

This walkthrough assumes the host application contains one `new Hono()` composition root and one
unambiguous `new Resend(...)` construction. Missing Plugin dependencies are shown as one exact,
range-checked runtime/development install plan and require approval (or `--yes`); Amplio never
brings providers into core or invents provider clients. Before running the package manager, the CLI
states which tracked files it can restore and that caches, `node_modules`, and dependency
lifecycle-script side effects are not reversible.

```bash
npx @useamplio/cli@alpha init --service my-app
npx @useamplio/cli@alpha add plugin hono
npx @useamplio/cli@alpha add event order.placed
npx @useamplio/cli@alpha add plugin resend --event http.request
npx @useamplio/cli@alpha doctor --strict
```

`init` creates `telemetry/runtime.ts`, `telemetry/events/http-request.ts`, and a console sink. The
explicit `add plugin hono` step installs and attaches the framework Plugin at one unambiguous
`new Hono()` seam. Runtime configuration exports no logger; application code keeps its native
types, return values, and errors.

## Commands

| Command                                       | Purpose                                         |
| --------------------------------------------- | ----------------------------------------------- |
| `amplio init`                                 | Create the Event + Plugin telemetry root        |
| `amplio add event <id>`                       | Create an editable duration-root Event          |
| `amplio add plugin <id>`                      | Install an editable boundary Plugin             |
| `amplio add plugin <id> --event <id>`         | Mount a contributor Plugin under one root Event |
| `amplio add plugin <id> --target <file>`      | Select one contained native composition file    |
| `amplio diff plugin <id>`                     | Compare local, installed, and registry source   |
| `amplio update plugin <id>`                   | Three-way merge a compatible recipe update      |
| `amplio remove plugin <id>`                   | Remove safe source/wiring; retain provider deps |
| `amplio add sink <id>`                        | Install and wire an operational sink            |
| `amplio add enricher <id>`                    | Install and wire a resource enricher            |
| `amplio list [event\|plugin\|sink\|enricher]` | List available items; add `--json` for machines |
| `amplio doctor [--strict]`                    | Validate runtime, Event, and Plugin wiring      |
| `amplio paths`                                | Add the `~telemetry/*` TypeScript path alias    |
| `amplio smoke <url>`                          | Verify request-in/Event-out with the JSON sink  |

Run `amplio <command> --help` for current flags.

Event ids need at least two lowercase dot-separated segments, such as
`http.request` or `order.placed`. Existing open-code files are skipped unless
`--force` is provided.

Plugin adds accept `--dry-run` and perform the same compatibility, Event-tree, and native-seam
preflight without writing files. Successful installs cache the exact recipe source under
`.amplio/bases/sha256-….json` and reversible wiring state under `.amplio/installs/<id>.json`.
`amplio update plugin` preserves non-overlapping edits with a three-way merge and refuses native,
semantic, privacy, or overlapping-source migrations. `amplio remove plugin` never deletes edited
Plugin source and never removes the host-owned provider dependency.

`--target <relative-source-file>` narrows native seam discovery to one existing, contained source
file. Absolute, traversing, missing, non-source, and symlink-escaping targets fail before writes.
The selected file must still contain exactly one authenticated supported seam; `--target` does not
guess between multiple seams in the same file or weaken provider binding checks. An active Plugin
cannot be silently retargeted—remove and reinstall it explicitly.

Hono, Fastify, constructor, Better Auth, and tRPC recipes can be wired into the selected file.
Next.js and Express remain explicit: first copy with `--source-only`, attach the documented wrapper
by hand, then rerun active installation with `--target`. Amplio verifies that exact native route and
records its wiring as customer-owned without rewriting it. `doctor --strict` re-verifies adopted
wiring. Removal never rewrites customer-owned code and refuses to delete Plugin source while a live
import or reference remains; detach it, then retry removal.

Commit `telemetry/`, `amplio.json`, and `.amplio/` together. The lifecycle cache contains source
snapshots, never runtime Event data, and is required for reproducible update and removal on another
machine.

## Generated layout

```text
telemetry/
├── events/http-request.ts
├── plugins/hono.ts
├── sinks/console.ts
├── enrichers/
└── runtime.ts
```

`amplio.json` is CLI-only configuration:

```json
{
  "telemetryDir": "telemetry",
  "packageManager": "pnpm",
  "registry": "../optional-local-registry"
}
```

Prefer `amplio add` when an install needs semantic placement or composition
root rewriting. Registry JSON under `public/r/` remains compatible with raw
shadcn file installs.

## Development

```bash
pnpm --filter @useamplio/cli build
pnpm --filter @useamplio/cli test
pnpm --filter @useamplio/cli typecheck
pnpm registry:build
```
