# amplio alpha guide

Schema-first wide-event telemetry that installs as open code in your repo.

**Status:** public alpha (`0.1.0-alpha.x`). APIs may change.

## Install (≈ 5 minutes)

From an existing Node 20+ app:

```bash
npx @useamplio/cli@alpha init --service my-app --yes
```

That command:

1. Scaffolds `telemetry/` + `amplio.json` + `components.json`
2. Installs `@useamplio/amplio` and `zod`
3. Auto-detects Next.js / Hono / Express / Fastify and scaffolds middleware + a starter event when possible (`auth.user.signed_up` only when an auth dependency is detected)

> The unscoped name `amplio` cannot be published on npm (typo-squatting block). Always use `@useamplio/cli`.

### Hono

```bash
pnpm add hono
# or: npm install hono  |  yarn add hono
npx @useamplio/cli@alpha init --service my-app --middleware hono --event auth.user.signed_up --yes
```

Wire middleware:

```ts
import { Hono } from "hono";
import { amplioMiddleware } from "./telemetry/middleware/hono";

const app = new Hono();
app.use("*", amplioMiddleware());
```

Emit in a route:

```ts
import { getRequestLogger } from "./telemetry/middleware/hono";
import { AuthUserSignedUp } from "./telemetry/events/auth/user-signed-up";

app.post("/signup", async (c) => {
  const log = getRequestLogger(c);
  log.child(AuthUserSignedUp).set({
    user: { id: "u_123" },
    signup: { method: "email" },
  }).emit();
  // two rows per signup request: the http.request spine (emitted by the middleware)
  // and this auth.user.signed_up row, correlated via request_id
  return c.json({ ok: true });
});
```

To add fields to the request row itself (no separate domain event):

```ts
log.set({ user: { id: "u_123" } });
// middleware emits the http.request spine when the response finishes
```

You should see JSON lines on stdout (console sink from `telemetry/logger.ts`) — one spine row plus any `.child(...).emit()` domain rows per request.

### Next.js (App Router)

```bash
npx @useamplio/cli@alpha init --service my-app --middleware next --event auth.user.signed_up --yes
```

Wrap a route handler:

```ts
import { withAmplio } from "@/telemetry/middleware/next";
import { getLogger } from "@useamplio/amplio";
import { AuthUserSignedUp } from "@/telemetry/events/auth/user-signed-up";
import { NextResponse } from "next/server";

export const GET = withAmplio(async () => {
  getLogger()
    .child(AuthUserSignedUp)
    .set({ user: { id: "u_123" }, signup: { method: "email" } })
    .emit();
  // middleware still emits the http.request spine when the handler finishes
  return NextResponse.json({ ok: true });
});
```

To annotate the spine only: `getLogger().set({ user: { id: "u_123" } })`.

### Turbopack / `next dev --turbo`

Turbopack can compile `instrumentation.ts` and route handlers into **separate module graphs**. amplio handles this in three layers:

1. **Runtime** — `init()` and ALS state live on `globalThis[Symbol.for('amplio.state.v1')]` so duplicated bundles share config.
2. **Templates** — `telemetry/middleware/next.ts` and `trpc.ts` begin with a side-effect `import "../logger";` so each graph runs `init()` even when instrumentation is unreachable.
3. **`amplio doctor`** — warns when those middleware files lack the `../logger` import (stale scaffolds from older CLI versions).

Separately, Next compiles `instrumentation.ts` for the **Edge runtime** too — the generated file guards its import with `if (process.env.NEXT_RUNTIME === "nodejs")` so Edge compiles never try to bundle `node:` builtins from `telemetry/` (doctor warns when the guard is missing).

After upgrading the CLI, run `amplio doctor`; regenerate middleware with `amplio add middleware next --force` (or `trpc --force`) if flagged. Historical details live in [CHANGELOG.md](./CHANGELOG.md).

### Server-only runtime vs client-safe event defs

The main runtime (`@useamplio/amplio`) imports `node:async_hooks` at module top level. Do **not** import `telemetry/logger` or call `init()` / `getLogger()` from a `"use client"` component — the bundle will fail.

**Event schemas are client-safe:** import `defineEvent` from `@useamplio/amplio/events` to share typed event definitions with client components (no AsyncLocalStorage). Emit server-side — POST to a route handler wrapped in `withAmplio` and call `.emit()` there.

Pass `init({ canonicalKeyOnly: true })` to emit only `@event` (drops the duplicate `event` key for `@`-averse sinks). By default both keys are set on schema-bound emits.

### `.emit()` return value

`.emit()` returns the **delivered** record, or **`null` when the event was not delivered**:

- before `init()` (library-first silence — dev warns on every drop)
- after the logger was sealed (repeat `.emit()`)
- when sampling skips sink delivery (enrichers + redaction still run; only sinks are skipped)

Redaction runs at emit time — fields derived before redaction (e.g. a length computed from a raw value) can look inconsistent next to `[REDACTED]`; that is expected.

### `success` field

When neither `status` nor an explicit `success` is set, **`success` is omitted** from the emitted record. Numeric `status` in `[200, 400)` or the exact string `"ok"` derives `success: true`; explicit `success` always wins.

> **Dashboard implication:** clean domain rows (`.child(Def).emit()` with no `status`) omit `success` entirely, so a filter like `success = true` silently excludes them. Filter domain events with `success != false` (or on `@event`) instead — only validation failures and explicit errors stamp `success: false`.

### `getLogger()` (was `useLogger()`)

`useLogger()` was renamed to **`getLogger()`** in `0.1.0-alpha.10` — it is not a React hook, but `use*` naming trips biome's `lint/correctness/useHookAtTopLevel` and eslint-plugin-react-hooks inside tRPC procedures. `useLogger` remains exported as a deprecated alias (identical behavior, one-time dev warning) and will be removed before 1.0.

## Correlated domain events

One **spine** wide event per unit of work (`http.request` for HTTP, `trpc.request` for server-caller tRPC) plus **N domain events** that share its `request_id`.

| API | Use when |
|---|---|
| `.child(EventDef)` | **Canonical.** Fresh seal and start time; copies `request_id` only (no `http.*` / `trpc.*`). Emitting the child does not seal the spine. |
| `getLogger().set({ … })` | Add fields to the spine row (middleware emits it). |
| `logger.event(Def).emit()` | Standalone row outside a request; inside ALS (since alpha.8) copies `request_id` only. |

```ts
// inside a request — two rows, same request_id:
getLogger().child(PostCreated).set({ post: { id } }).emit();
// spine: http.request (middleware) + domain: post.created
```

> **The one wrong spelling to avoid:** `getLogger().event(Def).emit()` — this **rebinds** the request spine to the domain schema and seals it on emit, so you lose the separate `http.request` row. Use `.child(Def)` instead; dev builds warn loudly when you emit a rebind of an already-named spine. (Older-alpha correlation quirks are in [CHANGELOG.md](./CHANGELOG.md).)

## tRPC (v11)

When `init` detects `@trpc/server` alongside Next.js, it scaffolds `telemetry/middleware/trpc.ts` in addition to `telemetry/middleware/next.ts` (create-t3-app style: App Router + tRPC v11).

**create-t3-app walkthrough:** [docs/t3.md](./docs/t3.md).

### Wiring (strict TypeScript)

> In a stock create-t3-app layout you don't need to do this by hand: `npx @useamplio/cli@alpha init --yes` (or `init --wire`) edits both files below automatically.

**1. Route handler** — wrap the tRPC HTTP entry so the request wide event exists before procedures run:

```ts
// src/app/api/trpc/[trpc]/route.ts
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { withAmplio } from "../../../../../telemetry/middleware/next";
import { appRouter } from "@/server/api/root";
import { createTRPCContext } from "@/server/api/trpc";

const handler = (request: Request) =>
  fetchRequestHandler({
    endpoint: "/api/trpc",
    req: request,
    router: appRouter,
    createContext: () => createTRPCContext({ headers: request.headers }),
  });

export const GET = withAmplio(handler);
export const POST = withAmplio(handler);
```

**2. tRPC init** — annotate the ambient request logger from procedures (no cast adapter):

```ts
// src/server/api/trpc.ts
import { amplioTrpcMiddleware } from "../../../telemetry/middleware/trpc";

const amplioMiddleware = t.middleware(amplioTrpcMiddleware());
export const publicProcedure = t.procedure.use(amplioMiddleware);
// repeat for protectedProcedure / other bases as needed
```

`amplioTrpcMiddleware()` is generic — `t.middleware(amplioTrpcMiddleware())` and `publicProcedure.use(...)` typecheck without casts under strict `tsconfig`.

### Model

- **`withAmplio`** owns the request wide event (the spine). It is named `event: "http.request"` / `@event: "http.request"` so you can filter all HTTP traffic on one key.
- **`amplioTrpcMiddleware`** annotates that spine with `trpc.path`, `trpc.type`, and HTTP status — it does not emit a sibling request row.
- **Server-caller path** (RSC `createCaller`, no HTTP request): when no ambient logger exists, the middleware creates a spine row named `trpc.request` with `transport: "server-caller"` and `trpc.path` / `trpc.type` — no fabricated `http.method: "TRPC"` or other `http.*` fields. Real HTTP tRPC requests through `withAmplio` are unchanged (`http.request`).
- **Domain events** — use `getLogger().child(Def).set({ … }).emit()` inside procedures (e.g. `auth.user.signed_up`). Separate rows; keep business context on domain events; keep transport on the spine.

### Errors

tRPC v11 returns `{ ok: false, error }` from `next()` instead of throwing for many procedure failures (including Zod input validation). The middleware inspects that result and annotates the spine via `.error()`: `error.message`, `error.name` (thrown class name), and `status` / `http.status` derived from the tRPC error code (`BAD_REQUEST` → 400, `UNAUTHORIZED` → 401, etc.). Thrown errors are handled the same way.

### Batching

With `httpBatchLink` / `httpBatchStreamLink`, multiple procedures share one HTTP request. The spine gets `trpc.batched: true`, `trpc.batch_size`, and `trpc.procedures: ["query post.hello", "mutation user.update", …]` — every invocation is counted, including repeat calls to the same procedure. `trpc.path` / `trpc.type` stay on the **first** procedure in the batch **unless a procedure errors**, in which case the error annotation overwrites them with the *failing* procedure (the full list stays in `trpc.procedures`). In batches, `status` is the **transport** status of the shared HTTP response (often `207` when results are mixed) while `error.*` carries the failing procedure's error (e.g. `error.code: "UNAUTHORIZED"`). For clean per-procedure attribution, emit domain events inside each procedure rather than relying on the spine alone.

## shadcn registry

Hosted at https://amplio-ruddy.vercel.app

`init` writes `components.json` with:

```json
{
  "registries": {
    "@useamplio": "https://amplio-ruddy.vercel.app/r/{name}.json"
  }
}
```

Then:

```bash
npx shadcn@latest add @useamplio/sink-json
npx shadcn@latest add @useamplio/middleware-hono
```

Files land under `telemetry/…`.

## Packages

| Package | Role |
|---|---|
| `@useamplio/cli` | Scaffolding CLI (`npx @useamplio/cli@alpha`) |
| `@useamplio/amplio` | Runtime (`defineEvent`, `init`, `.set()`, `.emit()`) |

`@useamplio/core` is deprecated — use `@useamplio/amplio`.

## CLI reference

- `amplio init --paths` — writes the `~telemetry/*` tsconfig path alias (JSONC-comment-safe).
- `amplio add <badkind> …` — errors with `Unknown add kind "…". Valid kinds: event, middleware, sink, enricher, integration.` (no silent fallthrough).
- `amplio add event <name>` — prints `matched registry event` or `generated starter schema`. Names need two+ segments (`post.created`, `auth.user.signed_up`); hyphenated registry ids from `list` (e.g. `auth-user-signed-in`) are accepted and mapped to the dot name.
- `amplio add enricher query-allowlist` — wires an enricher that drops `http.search` by default (or keeps only allowlisted query params) so query-string PII never reaches sinks.
- `amplio list --json` — machine-readable registry listing (events listed by dot name).
- `amplio doctor` — wiring checks (middleware exports, event schemas, tsconfig paths, Turbopack `../logger` import on `telemetry/middleware/next.ts` and `trpc.ts`, `NEXT_RUNTIME` guard in instrumentation.ts, event barrel exports including shadcn-installed events).
- `amplio doctor --fix` — regenerates missing event barrel `index.ts` exports.
- `amplio doctor --strict` — exit non-zero on warnings (CI gate); without it, doctor prints an explicit `(exit 0 with warnings …)` note so CI pipelines are not silently green.
- Per-command help: `amplio init --help`, `amplio add --help`, etc.

### `amplio.json` registry override

By default the CLI reads the bundled `registry/` shipped in `@useamplio/cli`. Set a custom path in `amplio.json`:

```json
{
  "telemetryDir": "telemetry",
  "registry": "../my-fork/registry",
  "packageManager": "pnpm"
}
```

Absolute paths work too. Resolution: `amplio.json` → bundled registry → monorepo checkout fallback (dev only).

### OTLP sink default

Registry `otlpSink` defaults to **`throwOnError: false`** — export failures log a one-time dev warning and are swallowed. Pass `throwOnError: true` to fail hard on network or HTTP errors.

## Feedback

- GitHub issues: https://github.com/alex-holovach/amplio/issues
- Include: framework, Node version, and the command you ran

## Skip auto-install

```bash
npx @useamplio/cli@alpha init --skip-install
pnpm add @useamplio/amplio zod
# or: npm install @useamplio/amplio zod  |  yarn add @useamplio/amplio zod
```
