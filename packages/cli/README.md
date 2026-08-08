# @amplio/cli

CLI for scaffolding amplio telemetry in your repo (`init`, `add`).

## Binary

```bash
npx amplio init
npx amplio add event auth.user.signed_up
```

The published package exposes the `amplio` bin (`dist/cli.js`).

## `add` and `--force`

For `event`, `middleware`, `sink`, `enricher`, and `integration`, `amplio add` skips files that already exist under `telemetry/` and prints `skipped existing … file`. Pass `--force` to overwrite those paths with the registry template instead.

## Registry resolution

The CLI **bundles** a copy of `registry/` (copied at build time into `packages/cli/registry`). Build-time `copy-registry.mjs` uses a lock file so concurrent `pnpm` builds don't race on `packages/cli/registry/`. Resolution order:

1. **`amplio.json`** — if the project has a `registry` field, that path is used (absolute or relative to the project root).
2. **Bundled package registry** — `registry/registry.json` next to the installed package (`dist/`).
3. **Monorepo checkout fallback** — repo-root `registry/` when developing from source.

Run `pnpm registry:build` from the monorepo root to refresh hosted `public/r/` JSON; `pnpm --filter @amplio/cli build` refreshes the CLI bundle.
