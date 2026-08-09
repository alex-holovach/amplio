# amplio

Schema-first wide-event telemetry that installs as **open code** in your repo — shadcn for observability.

Define typed event schemas, accumulate context with `.set()`, emit once with `.emit()`. Events, middleware, sinks, and integrations live in `telemetry/` — you read, edit, and review them like application code. No sprawling logger surface. No opaque npm runtime.

## Quick start

```bash
npx amplio init
npx amplio add event auth.user.signed_up
npx amplio add middleware hono
```

`amplio init` detects your framework from `package.json` (Next.js, Hono, Express, Fastify) and can scaffold middleware plus a starter event in one shot (`--yes` or non-interactive).

Or pull registry items directly with shadcn:

```bash
npx shadcn@latest add @useamplio/event-auth-user-signed-up
npx shadcn@latest add @useamplio/middleware-hono
```

Registry items are published as shadcn-compatible JSON under `public/r/` (e.g. `event-auth-user-signed-up.json` with `~/events/...` targets → `telemetry/`).

### Emit

```typescript
import { logger } from "./telemetry/logger.js";
import { AuthUserSignedUp } from "./telemetry/events/auth/user-signed-up.js";

logger
  .event(AuthUserSignedUp)
  .set({
    user: { id: "u_123" },
    signup: { method: "email" },
  })
  .emit();
```

Example emitted record (fields vary by schema and enrichers):

```json
{
  "service": "my-app",
  "env": "development",
  "timestamp": "2026-08-07T16:30:00.000Z",
  "duration_ms": 12,
  "success": true,
  "event": "auth.user.signed_up",
  "@event": "auth.user.signed_up",
  "user": { "id": "u_123" },
  "signup": { "method": "email" }
}
```

Default redaction masks emails and other sensitive patterns when those fields are present.

## After init

`@useamplio/cli` is a scaffolder. Once `telemetry/` exists, you can remove the CLI and keep editing events/middleware/sinks with only `@useamplio/amplio` installed.

## Philosophy

| Principle | What it means |
|---|---|
| **Open code** | Events, middleware, sinks, and integrations live in `telemetry/` — you read, edit, and review them like app code |
| **Schema-first** | Every important event is declared with `defineEvent` before use |
| **Wide events** | One rich event per unit of work; context accumulates, then drains on `.emit()` |
| **Less is more** | Tiny runtime (`@useamplio/amplio`); frozen public API |
| **shadcn-native** | Registry items scaffold typed files into your repo |

## Folder structure

After init and a few adds, your repo looks like:

```
telemetry/
├── events/           # one file per event schema (generated + editable)
│   └── auth/
│       ├── user-signed-up.ts
│       └── index.ts
├── middleware/       # hono, next, express, fastify
├── sinks/            # console, json, otlp
├── enrichers/        # request metadata, service metadata
├── integrations/     # better-auth, clerk, resend, polar
└── logger.ts         # init() + exported logger
```

Event names use dot-separated segments (`auth.user.signed_up`, `email.sent`). Files nest under the domain segment.

## Try from this repo (no npm publish)

```bash
pnpm build
pnpm --filter @useamplio/amplio pack
pnpm --filter @useamplio/cli pack
# then in your app:
pnpm add /absolute/path/to/amplio-core-0.1.0.tgz
pnpm add -D /absolute/path/to/amplio-cli-0.1.0.tgz
pnpm exec amplio init --service my-app
```

## API

Frozen public surface from `@useamplio/amplio`:

| Symbol | Role |
|---|---|
| `defineEvent` | Declare a named event schema |
| `init` | Configure service, env, sinks, sampling (`rate`, `keep` rules) — call once from `telemetry/logger.ts` |
| `logger.event(def, initial?)` | Bind a schema; optionally seed context |
| `logger.create(initial?)` | Standalone wide-event scope (jobs, scripts, CLI runs) |
| `useLogger` | Request-scoped logger from middleware context |
| `.set()` | Merge nested context into the active wide event (mutates in place; returns same instance so `useLogger()` stays valid in middleware ALS) |
| `.error(err, ctx?)` | Record a structured error (`success: false`); does not emit — call `.emit()` after |
| `.emit()` | Finalize, validate, drain sinks; seals the instance |
| `flush()` | Await pending async sink deliveries (use with serverless `waitUntil` / Next.js `after`) |

When `success` is unset it defaults to `true`; if `status` is set, numeric codes in `[200, 400)` and the exact string `"ok"` (case-sensitive; `"OK"` → `false`) derive `success` (explicit `success` wins).

**Library-first silence:** Import `@useamplio/amplio` and call `.set()` / `.emit()` before you wire `telemetry/logger.ts`. Without `init()` and sinks, `.emit()` still returns a record and does not throw — nothing is written anywhere. Call `init()` with at least one sink when you want output. `getConfig()` is stricter: it throws if you call it before `init()`.

Enricher errors are isolated — a throwing enricher is skipped; later enrichers and sinks still run.

`otlpSink` accepts a base OTLP endpoint or a full `…/v1/logs` URL (no double path). It maps `record.service` → resource `service.name` and `record.env` → `deployment.environment` when those fields are set. `throwOnError: false` swallows export failures.

The JSON file sink writes to `AMPLIO_JSON_SINK_PATH` (or `options.path`) and creates missing parent directories; when neither is set, the default filename is `amplio.jsonl`. Empty or whitespace-only `AMPLIO_JSON_SINK_PATH` is treated as unset (same default). `options.path` overrides `AMPLIO_JSON_SINK_PATH`.

### Sampling and redaction

- Sampling `rate` 0 drops events that do not match a `keep` rule (`keep` rules are OR'd — any match keeps); `rate` 1 always samples.
- Sampling `keep.field` supports dotted paths (e.g. `user.plan`) with `equals`, `matches`, `gte`, or `lte`; `gte` and `lte` on the same rule form an inclusive AND range.
- Redaction runs on every emit by default; pass `redact: false` to `init()` to disable it.
- `serviceMetadata` uses `AMPLIO_SERVICE` / `AMPLIO_SERVICE_VERSION` / `AMPLIO_REGION` (name falls back to `record.service`; unset or empty version/region omitted — empty env strings are treated as unset).
- `requestMetadata` optional fields (`route` / `ip` / `userAgent` / `requestId`): empty strings are treated as unset (omitted from `http`); empty `requestId` does not overwrite an existing `request_id`.

### defineEvent

```typescript
import { defineEvent } from "@useamplio/amplio";
import { z } from "zod";

export const AuthUserSignedUp = defineEvent(
  "auth.user.signed_up",
  z.object({
    user: z.object({ id: z.string(), email: z.string().email().optional() }),
    signup: z.object({ method: z.enum(["email", "oauth", "invite"]) }),
  }),
);
```

### logger.event

```typescript
import { logger } from "./telemetry/logger.js";

logger.event(AuthUserSignedUp, { user: { id: "u_1" } })
  .set({ signup: { method: "email" } })
  .emit();
```

### logger.create

```typescript
logger.create({ job: "nightly-sync" })
  .set({ records_processed: 42 })
  .emit();
```

### useLogger (middleware)

```typescript
import { useLogger } from "@useamplio/amplio";

app.get("/health", (c) => {
  useLogger().set({ route: { name: "health" } });
  return c.json({ ok: true });
});
```

## Registry / shadcn

Registry items install into `telemetry/` with the same layout the CLI produces. Items are declared in `registry/registry.manifest.json` and published to `public/r/`. The registry index (`public/r/registry.json`) includes title and description per item.

```bash
pnpm registry:build   # regenerate public/r/*.json
pnpm registry:serve   # local HTTP server for shadcn
```

**Hosted registry:** [`https://amplio-ruddy.vercel.app`](https://amplio-ruddy.vercel.app) serves `public/r` at `/r/{name}.json` (CORS `*`).

```json
{
  "registries": {
    "@useamplio": "https://amplio-ruddy.vercel.app/r/{name}.json"
  }
}
```

**Local development:** run `pnpm registry:serve`, then point `components.json` at `http://127.0.0.1:4173/{name}.json`. Use `PORT=0` or `--port 0` for an ephemeral port. `amplio add` works without the hosted URL because the CLI bundles `registry/`.

```json
{
  "registries": {
    "@useamplio": "https://amplio-ruddy.vercel.app/r/{name}.json"
  }
}
```

From the amplio repo after `pnpm registry:build`:

```bash
npx shadcn@latest add @useamplio/event-auth-user-signed-up
# or a single item file:
npx shadcn@latest add ./public/r/middleware-hono.json
```

Common items:

- `@useamplio/event-auth-user-signed-up`
- `@useamplio/middleware-hono`
- `@useamplio/sink-json`
- `@useamplio/integration-better-auth`

## Size and performance

Measured on Node 22 (`pnpm build && pnpm size && pnpm bench`). Higher ops/s is faster.

| | |
|---|---|
| `@useamplio/amplio` gzip | ~4.5 KB |
| Runtime deps | **0** (optional `zod` peer) |

### `pnpm bench` (default redaction ON)

| Workload | ops/s | median |
|---|---:|---:|
| Flat `create` → `.set()` → `.emit()` | ~1.0M | ~0.001 ms |
| Nested ~1 KB payload | ~166k | ~0.006 ms |

### Local compare harness (noop / discard sink, `redact: false`)

Same machine; create→emit style workload for amplio/evlog vs `info(obj)` for LogTape/Pino. Not identical to LogTape marketing nanosecond figures.

| Library | Flat ops/s | Nested ~1 KB ops/s | Median (flat) |
|---|---:|---:|---:|
| **amplio** | ~2.1M | ~1.6M | ~370 ns |
| Pino (discard stream) | ~610k | ~185k | ~1.4 µs |
| LogTape (null sink) | ~280k | ~290k | ~2.4 µs |
| evlog (silent + drain noop) | ~290k | ~245k | ~1.9 µs |

Reproduce with `pnpm bench`. Compare harness is local (not shipped). Numbers are machine-dependent; we do not claim “fastest logger in the world.”


## amplio vs evlog

**evlog** ships a closed npm runtime and optional module augmentation — telemetry logic hides in `node_modules`.

**amplio** ships **schemas + generated code in your repo** and a tiny core with a frozen public API (loggers mutate in place via `.set()`). You own the events, middleware, and sinks. The CLI and shadcn registry scaffold readable, typed files under `telemetry/` that you can diff in PRs.

Same wide-event model. Different ownership model.

## Examples

Runnable smoke apps (from repo root after `pnpm install` + `pnpm build`):

```bash
pnpm --filter @useamplio/example-basic dev            # Hono — http://127.0.0.1:3000
pnpm --filter @useamplio/example-express-smoke dev    # Express — http://127.0.0.1:3001
pnpm --filter @useamplio/example-fastify-smoke dev    # Fastify — http://127.0.0.1:3002
pnpm --filter @useamplio/example-next-smoke dev       # Next.js — http://127.0.0.1:3003
```

Headless smoke (no long-lived server):

```bash
pnpm --filter @useamplio/example-basic smoke
pnpm --filter @useamplio/example-express-smoke smoke
pnpm --filter @useamplio/example-fastify-smoke smoke
pnpm --filter @useamplio/example-next-smoke smoke
pnpm --filter @useamplio/example-standalone smoke
```

Or all at once: `pnpm smoke`.


See `examples/*/README.md` for curl commands and what each demo covers.

## Packages

| Package | Purpose |
|---|---|
| `@useamplio/amplio` | Runtime: `defineEvent`, `init`, `logger`, wide-event lifecycle |
| `@useamplio/cli` | `init` / `add` scaffolding |

## Development

### Publish readiness

- **`@useamplio/amplio`** is packable as-is (`dist/` only; optional Zod peer).
- **`@useamplio/cli`** bundles `registry/` into the published tarball at build (`pnpm build` → `copy-registry.mjs`).
- **Hosted shadcn registry** — https://amplio-ruddy.vercel.app/r/{name}.json (redeploy with `pnpm registry:deploy`).

```bash
pnpm install
pnpm build
pnpm test
pnpm typecheck
pnpm registry:build
pnpm size          # @useamplio/amplio gzip must stay under 8 KB
pnpm run ci   # full local CI — not `pnpm ci` (pnpm clean-install)
```

CI (`.github/workflows/ci.yml`) runs build, test, typecheck, size, registry build, event Prettier checks, and publish smoke on push/PR.

See [CONTRIBUTING.md](./CONTRIBUTING.md); for the first npm publish, follow **First release** (initial commit + version tag before publishing).


## CLI reference

- Running `amplio` with no args prints usage/help but exits **1**; use `amplio -h` / `--help` for exit 0.
- Unknown options and missing option values also exit **1** with a short `error:` line (no Node stack).
- `add` needs both kind and name (e.g. `add sink console`); bare `add` or kind-only exits **1** with an error.
- Omitting `--service` on `init` defaults the service name to `my-app`; `--service` is trimmed, so empty or whitespace-only values fall back the same way.
- `amplio init` accepts `--package-manager <pnpm|npm|yarn|bun>` (default `pnpm`). Values are trimmed and case-insensitive; whitespace-only falls back to the default.
- `amplio init --no-typescript` sets `typescript: false` in `amplio.json`.
- `--service`, `--package-manager`, and `--no-typescript` are only valid with `init` (rejected on `add` / `list`). Whitespace-only `--service` / `--package-manager` on non-init commands are ignored (not rejected).
- `init --cwd <path>` and `add --cwd <path>` create missing directories (`mkdir -p`).
- Event names must be lowercase dot-separated segments (e.g. `auth.user.signed_up`); no leading/trailing dots or uppercase.
- `amplio add event …` and other `add` kinds can scaffold from the registry without running `init` first — the telemetry tree is created as needed.
- Re-run `amplio add` with `--force` to overwrite existing scaffold files instead of skipping them. `--force` is only valid with `add` (rejected on `init` / `list`).
- `amplio list` works without prior `init` — reads the bundled registry. Optional filter by kind; each line includes the human title (e.g. Console Sink).

## License

MIT — see [LICENSE](./LICENSE).
