# Contributing to logcn

Thanks for helping improve logcn. The project is a small monorepo — keep changes focused.

## Setup

```bash
pnpm install
pnpm build
pnpm test
pnpm size
```

## Where to change things

| Change | Location |
|---|---|
| Runtime API | `packages/core` |
| CLI / scaffolding | `packages/cli` |
| Registry items | `registry/` + `registry/registry.manifest.json` |
| Examples | `examples/` |

## Workflow

1. Work in the smallest package that owns the change.
2. Add or update tests in the same package.
3. Run `pnpm run ci` before opening a PR — not bare `pnpm ci` (pnpm's install-from-lockfile builtin).
4. For registry items, run `pnpm registry:build` and commit generated `public/r/` output.
5. If you touch examples or middleware, run `pnpm smoke` (headless example checks).

`logcn init` supports `--service`, `--package-manager`, and `--no-typescript` (see README Quick start).

## Try in another project

To use a local build outside this monorepo, pack core + CLI tarballs and install them in the other app — see README **Try from this repo (no npm publish)**.

## Checks

| Command | Purpose |
|---|---|
| `pnpm build` | Build `@logcn/core` + `@logcn/cli` |
| `pnpm test` | Unit tests |
| `pnpm typecheck` | TypeScript check across packages (CI) |
| `pnpm size` | `@logcn/core` gzip budget (< 8 KB) |
| `pnpm registry:build` | Regenerate `public/r/` |
| `pnpm registry:serve` | Local HTTP server for `public/r/` JSON |
| `pnpm format:check:events` | Generated events match Prettier defaults; root `.prettierrc` pins the config |
| `pnpm smoke` | Example smoke scripts (basic/express/fastify/standalone/next) |
| `pnpm publish:smoke` | Pack CLI + core, install outside monorepo, run `logcn init` |
| `pnpm run ci` | Full local CI bundle (includes `publish:smoke`; matches GitHub Actions) — **must** use `run`; plain `pnpm ci` is pnpm's clean-install builtin |

`pnpm registry:serve` rejects invalid `--port` / `PORT` values immediately (`Invalid --port` / `Invalid PORT`); `PORT=0` / `--port 0` is fine (ephemeral bind).

CI (`.github/workflows/ci.yml`) runs build, test, typecheck, size, registry build, event Prettier checks, and publish smoke on push/PR.

## Conventions

- Event names: `domain.entity.action` (or shorter forms like `email.sent`).
- Relative imports under `telemetry/` are **extensionless** (Next-safe): `./sinks/json` not `./sinks/json.js`.
- Generated telemetry code lives in user repos under `telemetry/` — keep it readable and diff-friendly.
- Do not expand the public `@logcn/core` API beyond the frozen surface in `AGENTS.md`.

## Pull requests

- One concern per PR when possible.
- Include a short test plan in the PR description.
- Do not commit secrets or example API keys.

## First release

This repo may have no git commits yet. The first npm publish needs an initial commit and a version tag before release tooling can run — empty history is not ready to publish.
