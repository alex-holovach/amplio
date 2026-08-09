# amplio

Schema-first wide-event telemetry that installs as **open code** in your repo — shadcn for observability.

Define typed event schemas, accumulate context with `.set()`, emit once with `.emit()`. Events, middleware, sinks, and integrations live in `telemetry/` — you read, edit, and review them like application code. No sprawling logger surface. No opaque npm runtime.

**Alpha testers:** start with [ALPHA.md](./ALPHA.md).

## Quick start

```bash
npx @useamplio/cli@alpha init --service my-app --yes
npx @useamplio/cli@alpha add event auth.user.signed_up
npx @useamplio/cli@alpha add middleware hono
```

> Alpha: prefer the `@alpha` dist-tag. See [ALPHA.md](./ALPHA.md).
>
> Note: the unscoped npm name `amplio` is blocked by npm’s typo-squatting rules, so the CLI entry is `npx @useamplio/cli@alpha`.

`amplio init` detects your framework from `package.json` (Next.js, Hono, Express, Fastify) and can scaffold middleware plus a starter event in one shot (`--yes` or non-interactive).

Using Next.js + tRPC (create-t3-app)? That's the most polished path — `init --yes` auto-wires both T3 files. Follow [docs/t3.md](./docs/t3.md).

Or pull registry items directly with shadcn:

```bash
npx shadcn@latest add @useamplio/event-auth-user-signed-up
npx shadcn@latest add @useamplio/middleware-hono
```

Registry items are published as shadcn-compatible JSON under `public/r/` (e.g. `event-auth-user-signed-up.json` with `telemetry/events/...` targets). Treat the shadcn path as interop: it drops files but does not wire barrels or `logger.ts` — `amplio add` does both in one command (after a shadcn install, `amplio doctor --fix` completes the wiring).

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

`@event` is the reserved canonical event name. `event` duplicates the same value for sinks and queries that avoid `@`-prefixed keys — both are set on schema-bound emits; request middleware uses `http.request` for both.

Default redaction masks emails and other sensitive patterns when those fields are present.

### Correlated domain events

Inside request middleware scope, emit domain rows with `.child()` — fresh seal and start time, copies `request_id` only (no `http.*` duplication):

```typescript
import { getLogger } from "@useamplio/amplio";
import { AuthUserSignedUp } from "./telemetry/events/auth/user-signed-up.js";

// inside withAmplio / hono middleware:
getLogger()
  .child(AuthUserSignedUp)
  .set({ user: { id: "u_123" }, signup: { method: "email" } })
  .emit();
// two rows: http.request spine (middleware) + auth.user.signed_up (same request_id)
```

`logger.event(Def).emit()` outside a request is unchanged. Inside request scope (since `0.1.0-alpha.8`) it also copies `request_id` — but `.child()` is the canonical API for separate domain rows without touching the spine. See [ALPHA.md](./ALPHA.md#correlated-domain-events).

**`duration_ms` on domain events:** a child logger's clock starts at `.child()` creation, so the typical `child().set().emit()` chain reports `duration_ms: 0` — it does **not** measure the surrounding operation. Create the child *before* the work if you want the work timed:

```typescript
const ev = getLogger().child(AuthUserSignedUp); // clock starts here
await doTheWork();
ev.set({ user: { id } }).emit();                // duration_ms = work time
```

## After init

`@useamplio/cli` is a scaffolder. Once `telemetry/` exists, you can remove the CLI and keep editing events/middleware/sinks with only `@useamplio/amplio` installed.

## amplio.json

`amplio init` writes `amplio.json` at the project root. It is plain JSON, safe to hand-edit, and only read by the CLI (the runtime never loads it):

| Field | Default | Purpose |
|---|---|---|
| `telemetryDir` | `"telemetry"` | Directory the CLI scaffolds into and `doctor` validates |
| `packageManager` | detected | Used for install commands and printed tips (`pnpm`, `npm`, `yarn`, `bun`) |
| `typescript` | `true` | TypeScript defaults for generated files |
| `registry` | *(unset)* | Optional path to a local registry checkout — overrides the CLI's bundled registry |

Regeneration semantics: `amplio add …` never overwrites an existing file under `telemetry/` (it prints `· skipped existing … file`); re-run with `--force` to overwrite a file with the current registry template. `amplio init` is idempotent — re-running it leaves existing files unchanged.

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
pnpm add /absolute/path/to/useamplio-amplio-0.1.0-alpha.5.tgz
pnpm add -D /absolute/path/to/useamplio-cli-0.1.0-alpha.5.tgz
pnpm exec amplio init --service my-app --skip-install
```

## API

Frozen public surface from `@useamplio/amplio`:

| Symbol | Role |
|---|---|
| `defineEvent` | Declare a named event schema |
| `init` | Configure service, env, sinks, sampling (`rate`, `keep` rules) — call once from `telemetry/logger.ts` |
| `.child(def)` | Correlated domain event: fresh seal + start time, copies `request_id` only — emit domain rows from inside requests without touching the spine |
| `logger.event(def, initial?)` | Standalone schema event; inside request scope it copies `request_id` |
| `logger.create(initial?)` | Standalone wide-event scope (jobs, scripts, CLI runs); forks get a fresh start time |
| `getLogger` | Request-scoped logger from middleware context (`useLogger` is a deprecated alias — renamed because lint tools mistook it for a React hook) |
| `.set()` | Merge nested context into the active wide event (mutates in place; returns same instance so `getLogger()` stays valid in middleware ALS) |
| `.error(err, ctx?)` | Record a structured error (`success: false`); does not emit — call `.emit()` after. For `Error` instances: `error.message`, `error.name` (class name), and `error.code` only when the thrown value carries a real string/number `code`. Structured errors from `createError({ message, why, fix, code })` are recorded field-for-field (not `[object Object]`) |
| `.emit()` | Finalize, validate, drain sinks; seals the instance |
| `flush()` | Await pending async sink deliveries (use with serverless `waitUntil` / Next.js `after`) |

When `success` is unset it defaults to `true`; if `status` is set, numeric codes in `[200, 400)` and the exact string `"ok"` (case-sensitive; `"OK"` → `false`) derive `success` (explicit `success` wins).

**Library-first silence:** Import `@useamplio/amplio` and call `.set()` / `.emit()` before you wire `telemetry/logger.ts`. Without `init()` and sinks, `.emit()` returns `null` (event dropped), no sinks run, and dev builds warn **on every dropped emit** (mentions Turbopack / separate module graphs as a common cause) — it never throws. Call `init()` with at least one sink when you want output. `getConfig()` is stricter: it throws if you call it before `init()`.

**Server-only:** the runtime imports `node:async_hooks` at module top level — do not import the logger or event defs from `"use client"` components.

Enricher errors are isolated — a throwing enricher is skipped; later enrichers and sinks still run.

`otlpSink` accepts a base OTLP endpoint or a full `…/v1/logs` URL (no double path). It maps `record.service` → resource `service.name` and `record.env` → `deployment.environment` when those fields are set. `throwOnError: false` swallows export failures.

The JSON file sink writes to `AMPLIO_JSON_SINK_PATH` (or `options.path`) and creates missing parent directories; when neither is set, the default filename is `amplio.jsonl`. Empty or whitespace-only `AMPLIO_JSON_SINK_PATH` is treated as unset (same default). `options.path` overrides `AMPLIO_JSON_SINK_PATH`.

### Sampling and redaction

- Sampling `rate` 0 drops events that do not match a `keep` rule (`keep` rules are OR'd — any match keeps); `rate` 1 always samples.
- Sampling `keep.field` supports dotted paths (e.g. `user.plan`) with `equals`, `matches`, `gte`, or `lte`; `gte` and `lte` on the same rule form an inclusive AND range.
- Redaction runs on every emit by default; pass `redact: false` to `init()` to disable it.
- **Redaction is value-level, not just field-name matching:** sensitive patterns (emails, JWTs, bearer tokens, card numbers) are masked *inside* free-text string values too — `"email me at a@b.co please"` emits as `"email me at [REDACTED] please"` — in addition to masking well-known field names outright. URL-decoded copies of percent-encoded strings are scanned as well.
- **Query strings:** request middleware records `http.search` verbatim (URL-encoded query text). Field-level redaction does not parse query strings — tokens or PII in `?…` params may leak. Run `amplio add enricher query-allowlist` to scaffold the fix: it drops `http.search` by default, or keeps only the params you allowlist (`queryAllowlist({ allow: ["page"] })`).
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

### getLogger (middleware)

Request middleware creates one wide event per HTTP unit of work named `http.request` (`event` and `@event` both set). Filter on `@event = "http.request"` for the request spine; domain events from `.child(SomeSchema).emit()` are separate rows sharing `request_id`.

```typescript
import { getLogger } from "@useamplio/amplio";

app.get("/health", (c) => {
  getLogger().set({ route: { name: "health" } });
  return c.json({ ok: true });
});
```

## Registry / shadcn

Registry items install into `telemetry/` with the same layout the CLI produces. Items are declared in `registry/registry.manifest.json` and published to `public/r/`. The registry index (`public/r/registry.json`) includes title and description per item.

Built registry JSON uses `@useamplio/…`-prefixed `registryDependencies` (e.g. `@useamplio/event-auth-user-signed-up`) and root-anchored file targets (`~/telemetry/…`). `npx shadcn add` therefore lands files in `telemetry/` at the repo root even when your app uses a `src/` layout — matching `amplio add` / `amplio init`.

```bash
pnpm registry:build   # regenerate public/r/*.json
pnpm registry:serve   # local HTTP server for shadcn
```

**Hosted registry:** [`https://amplio-ruddy.vercel.app`](https://amplio-ruddy.vercel.app) serves `public/r` at `/r/{name}.json` (CORS `*`). This Vercel preview domain is temporary — it will move to a stable branded domain before beta. When it does, re-running `amplio init` updates the `registries["@useamplio"]` entry in `components.json` in place; no other migration is needed.

**components.json:** when the file does not exist, `amplio init` writes a full shadcn-compatible `components.json` (style `new-york`, baseColor `neutral`, aliases derived from your tsconfig paths) because `npx shadcn add` refuses to run without one. If you adopt shadcn/ui later, run `npx shadcn init` and review those defaults — they were chosen by amplio, not by you. When `components.json` already exists, `amplio init` only upserts the `registries["@useamplio"]` key and leaves everything else untouched.

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
- `amplio init --paths` writes the `~telemetry/*` tsconfig path alias (JSONC-comment-safe).
- `amplio doctor` checks wiring (middleware, barrels, Turbopack `../logger` import) in both directions: event files missing from barrels *and* barrel exports whose target files no longer exist. `amplio doctor --fix` regenerates missing event barrel exports and prunes stale ones. `--verbose` always prints the end-to-end verification epilogue (otherwise it only appears after `--fix` or when something needs attention).
- `amplio add <badkind> …` errors with valid kinds (`event`, `middleware`, `sink`, `enricher`, `integration`).
- Event names must be lowercase dot-separated segments (e.g. `auth.user.signed_up`); no leading/trailing dots or uppercase.
- `amplio add event …` and other `add` kinds can scaffold from the registry without running `init` first — the telemetry tree is created as needed.
- Re-run `amplio add` with `--force` to overwrite existing scaffold files instead of skipping them. `--force` is only valid with `add` (rejected on `init` / `list`).
- `amplio list` works without prior `init` — reads the bundled registry. Optional filter by kind; each line includes the human title (e.g. Console Sink).

## License

MIT — see [LICENSE](./LICENSE).
