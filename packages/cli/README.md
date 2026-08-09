# @useamplio/cli

CLI for scaffolding amplio telemetry in your repo (`init`, `add`, `list`, `doctor`).

## Binary

```bash
npx @useamplio/cli@alpha init
npx @useamplio/cli@alpha add event post.created
npx @useamplio/cli@alpha add event auth.user.signed_up
```

The published package exposes the `amplio` bin (`dist/cli.js`). Run `amplio <command> --help` for per-command flags (e.g. `amplio init --help`, `amplio doctor --help`).

## Commands

| Command | Purpose |
|---|---|
| `amplio init` | Scaffold `telemetry/`, `amplio.json`, `components.json`; auto-detect framework |
| `amplio add <kind> <id>` | Install registry item (event, middleware, sink, enricher, integration) |
| `amplio list [kind]` | List registry items (human-readable; `--json` for machine output) |
| `amplio doctor` | Validate wiring; `--fix` regenerates missing event barrel exports and prunes stale ones (targets that no longer resolve); `--strict` exits non-zero on warnings (CI gate); `--verbose` always prints the verification epilogue |

### `init` highlights

- **`--yes`** — non-interactive: auto-scaffold detected middleware + starter event
- **`--event <name\|none>`** — starter event name; defaults to `auth.user.signed_up` only when auto-scaffolding **and** an auth dependency (better-auth, Clerk, etc.) is detected — otherwise no event is scaffolded
- **`--paths`** — writes `~telemetry/*` tsconfig path alias (JSONC-safe)
- **`--skip-install`** — skip installing `@useamplio/amplio` and `zod`

### `add event` output

When adding an event, the CLI prints either **`matched registry event`** (installed from bundled registry) or **`generated starter schema`** (synthetic Zod stub for names not in the registry).

Event names need **two or more** dot-separated segments (`post.created`, `auth.user.signed_up`, `email.sent`).

### `add` and `--force`

For `event`, `middleware`, `sink`, `enricher`, and `integration`, `amplio add` skips files that already exist under `telemetry/` and prints `skipped existing … file`. Pass `--force` to overwrite those paths with the registry template instead.

## Registry resolution

The CLI **bundles** a copy of `registry/` (copied at build time into `packages/cli/registry`). Build-time `copy-registry.mjs` uses a lock file so concurrent `pnpm` builds don't race on `packages/cli/registry/`. Resolution order:

1. **`amplio.json`** — if the project has a `registry` field, that path is used (absolute or relative to the project root). Useful for pinning a fork or local registry checkout.
2. **Bundled package registry** — `registry/registry.json` next to the installed package (`dist/`).
3. **Monorepo checkout fallback** — repo-root `registry/` when developing from source.

Example `amplio.json` override:

```json
{
  "telemetryDir": "telemetry",
  "registry": "../amplio/registry",
  "packageManager": "pnpm",
  "typescript": true
}
```

`amplio.json` is plain JSON, safe to hand-edit, and read only by the CLI (never by the runtime). Fields: `telemetryDir` (scaffold/validate target, default `telemetry`), `packageManager` (used for install commands and tips), `typescript` (generated-file defaults), `registry` (optional local registry path, see above).

Run `pnpm registry:build` from the monorepo root to refresh hosted `public/r/` JSON; `pnpm --filter @useamplio/cli build` refreshes the CLI bundle.

## Bundled docs

The published tarball includes [ALPHA.md](./ALPHA.md) and [docs/](./docs/) copied from the monorepo at build time — same content as the GitHub repo root.
