# Contributing to amplio

Thanks for helping improve amplio. The project is a small monorepo — keep changes focused.

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
| Runtime API | `packages/amplio` |
| CLI / scaffolding | `packages/cli` |
| Registry items | `registry/` + `registry/registry.manifest.json` |
| Examples | `examples/` |

## Workflow

1. Work in the smallest package that owns the change.
2. Add or update tests in the same package.
3. Run `pnpm run ci` before opening a PR — not bare `pnpm ci` (pnpm's install-from-lockfile builtin).
4. For registry items, run `pnpm sync-registry` and commit both generated registry mirrors.
5. If you touch examples or middleware, run `pnpm smoke` (headless example checks).

Generated telemetry is TypeScript-only. `amplio init` supports `--service` and `--package-manager`
(see README Quick start).

## Try in another project

To use a local build outside this monorepo, pack core + CLI tarballs and install them in the other app — see README **Try from this repo (no npm publish)**.

## Checks

| Command | Purpose |
|---|---|
| `pnpm build` | Build `@useamplio/amplio` + `@useamplio/cli` |
| `pnpm test` | Unit tests |
| `pnpm typecheck` | TypeScript check across packages (CI) |
| `pnpm size` | `@useamplio/amplio` gzip budget (< 9 KiB) |
| `pnpm registry:build` | Regenerate the root `public/r/` registry |
| `pnpm sync-registry` | Regenerate and mirror the registry into `apps/www/public/r/` |
| `pnpm registry:serve` | Local HTTP server for `public/r/` JSON |
| `pnpm format:check:events` | Generated events match Prettier defaults; root `.prettierrc` pins the config |
| `pnpm smoke` | Example smoke scripts (basic/express/fastify/standalone/next) |
| `pnpm publish:smoke` | Pack CLI + core, install outside monorepo, run `amplio init` |
| `pnpm run ci` | Full local CI bundle (includes `publish:smoke`; matches GitHub Actions) — **must** use `run`; plain `pnpm ci` is pnpm's clean-install builtin |

`pnpm registry:serve` rejects invalid `--port` / `PORT` values immediately (`Invalid --port` / `Invalid PORT`); `PORT=0` / `--port 0` is fine (ephemeral bind).

CI (`.github/workflows/ci.yml`) runs build, test, typecheck, size, registry build, event Prettier checks, and publish smoke on push/PR.

## Conventions

- Event names: `domain.entity.action` (or shorter forms like `email.sent`).
- Generic NodeNext telemetry uses explicit `.js` relative specifiers. Generated Next.js telemetry is
  normalized to extensionless imports because the Next bundler resolves the `.ts` source graph.
- Generated telemetry code lives in user repos under `telemetry/` — keep it readable and diff-friendly.
- Do not expand the public `@useamplio/amplio` API beyond the frozen surface in `AGENTS.md`.

## Pull requests

- One concern per PR when possible.
- Include a short test plan in the PR description.
- Do not commit secrets or example API keys.

## First release

Packages publish to npm as **`@useamplio/amplio`** and **`@useamplio/cli`** under the [`useamplio`](https://www.npmjs.com/org/useamplio) npm org (scope `@useamplio`).

### Release steps

1. Bump **`version`** together in root `package.json`, `packages/amplio/package.json`, and `packages/cli/package.json`.
2. Commit the version bump.
3. Create an annotated tag matching the version with a `v` prefix — e.g. `v0.1.0` or `v0.1.0-alpha.1`.
4. Push the commit to `main`, then push the tag. The **publish** workflow (`.github/workflows/publish.yml`) runs only on tag pushes matching `v*` and publishes both packages.

Prerelease tags (`vX.Y.Z-alpha.N`, `vX.Y.Z-beta.N`, …) map to npm dist-tags from the prerelease id (`alpha`, `beta`, `rc`, …). Stable tags (`vX.Y.Z` with no `-`) publish under dist-tag **`latest`**.

### Security

- **`NPM_TOKEN`** is stored as an **environment secret** on GitHub environment **`npm-publish`**, which is restricted to deployment tags `v*` only.
- After the first successful publish, configure npm **Trusted Publishing** (OIDC) for workflow **`publish.yml`** on both `@useamplio/amplio` and `@useamplio/cli`, then **revoke the classic token** and rely on OIDC for future releases.
- If an npm token was ever pasted in chat or committed, **rotate it** before or immediately after setup.
