# @useamplio/amplio

Tiny schema-first wide-event telemetry runtime. Zero runtime dependencies (`zod` optional peer).

## Install

```bash
pnpm add @useamplio/amplio
# optional validation
pnpm add zod
```

## Quick start

```ts
import { init, defineEvent, createLogger } from "@useamplio/amplio";
// client-safe event definitions (no AsyncLocalStorage / node:async_hooks)
import { defineEvent as defineClientEvent } from "@useamplio/amplio/events";
import { z } from "zod";

const signedUp = defineEvent("auth.user.signed_up", z.object({ user_id: z.string() }));

init({
  service: "api",
  env: process.env.NODE_ENV ?? "development",
  sinks: [(record) => console.log(JSON.stringify(record))],
  sampling: {
    rate: 0.1,
    keep: [
      { field: "status", gte: 400 },
      { field: "severity", equals: "ERROR" },
    ],
  },
});

createLogger()
  .event(signedUp)
  .set({ user_id: "u_123" })
  .emit();
```

## API

| Export | Purpose |
|---|---|
| `init(config)` | Service metadata, sinks, enrichers, sampling, redaction, `canonicalKeyOnly`; returns `logger` |
| `defineEvent(name, shape?, options?)` | Typed event schema (Zod 3+ or Standard Schema) |
| `@useamplio/amplio/events` | Client-safe subpath: `defineEvent`, `createError`, and event types (no `node:async_hooks`) |
| `createLogger(initial?)` | Wide-event builder: `.set()`, `.emit()`, `.create()`, `.event()`, `.child()` |
| `createRequestLogger({ method, path })` | HTTP helper with `request_id` |
| `runWithLogger` / `getLogger` | AsyncLocalStorage context (`getLogger` no-op outside ALS; `useLogger` deprecated alias) |
| `flush()` | Await pending async sink deliveries |
| `scheduleFlush({ waitUntil? })` | Schedule `flush()` via platform `waitUntil` or Next.js `after()` |
| `trpcErrorHttpStatus(error)` | Map tRPC error `code` strings to HTTP status (defaults 500) |
| `createError({ message, why, fix, code, link })` | Structured errors for events |
| `deepMerge` | Fast merge used by `.set()` |
| `AmplioValidationError` | Thrown on schema validation failure; includes `issues` with paths |

## Behavior

- **Library-first silence:** Use `createLogger()` / `.emit()` without calling `init()` first — `.emit()` returns `null` (event dropped), no sinks run, dev warns **on every dropped emit** (mentions Turbopack / separate module graphs); never throws. Wire `init({ service, env, sinks: [...] })` when you want output. `getConfig()` still throws if called before `init()`.
- **Pipeline:** enrichers → validation → redaction → sampling → sinks.
- **No level methods** on wide events — use `.set()` / `.error()` / `.emit()` (plus `.create()` / `.event()` on the logger facade).
- **Mutable `.set()`** deep-merges fields in place (`DeepPartial` on schema-bound loggers; ALS-safe); **`.emit()`** runs enrichers → validation → redaction → sampling → sinks synchronously, then seals the logger. **`.emit()`** returns the delivered record, or `null` when the event was not delivered (before `init()`, after the logger was sealed, or dropped by sampling). **`flush()`** awaits pending async sink deliveries.
- **Soft seal:** after `.emit()`, the instance is sealed. Further `.set()` / `.error()` are no-ops; repeat `.emit()` returns `null`. Post-seal `.create()` and `.event()` return sealed no-op loggers (not `null`). Ignored calls log a dev warning (`console.warn`).
- **`getLogger()`** returns a no-op logger outside AsyncLocalStorage (does not throw). **`useLogger()`** is a deprecated alias with identical behavior.
- **Validation** soft-fails outside `NODE_ENV=test` unless `init({ strict: true })`; failed emits attach `validation.issues` and set `success: false`.
- **`.error(err)`** on `Error` instances: `error.message`, `error.name` (class name), and `error.code` only when `err.code` is a string or number (Node-style `ENOENT`, etc.) — plain `Error` omits `code`. Structured errors from `createError({ message, why, fix, code })` are recorded field-for-field.
- **Auto fields** on emit: `timestamp`, `duration_ms` (time since the logger was created — a `.child()` created right before `.emit()` reports `~0`; create the child before the work to time the work), `request_id` (when set), `success` (derived from `status` or set explicitly via `.set()` / `.error()` — omitted when neither applies), `service`, `env`. Schema events set `event` and `@event` to the declared name; `@event` is canonical, `event` is a duplicate for `@`-averse sinks. Pass `init({ canonicalKeyOnly: true })` to emit only `@event`. `createRequestLogger` seeds `http.request` on both keys.
- **Redaction**: emails, JWTs, Bearer tokens, credit cards, and sensitive field names (on by default; pass `redact: false` to `init()` to opt out). Redaction runs at emit time — fields derived before redaction (e.g. a length computed from a raw value) can look inconsistent next to `[REDACTED]`; that is expected.

## Sampling

Configure sampling in `init({ sampling: { rate, keep } })`:

- **`rate`** — fraction of records to deliver to sinks (0–1). `rate: 0` drops events unless a `keep` rule matches; `rate: 1` always delivers (unless other drop conditions apply).
- **`keep`** — rules that always deliver matching records (OR'd). Each rule uses a dotted `field` path with `equals`, `matches` (regex on strings), `gte`, and/or `lte` (numbers). Example: `{ field: "user.plan", equals: "enterprise" }`.

Enrichers and redaction still run on `.emit()` even when sampling skips sink delivery. **`.emit()` returns the delivered record, or `null` when the event was not delivered** — including before `init()`, after the logger was sealed, or when sampling drops delivery.

## Which entry point do I use?

- **`logger`** (module-level facade) — one-shot scripts, jobs, or cron handlers where you create and emit a wide event in one place without HTTP request context.
- **`createLogger(initial?)`** — a new named wide-event spine when you want an explicit builder (same as `logger.create()` after `init()`).
- **`createRequestLogger({ method, path, … })`** — HTTP request spine with `request_id` and `http.*`; middleware wraps handlers with `runWithLogger(createRequestLogger(…), …)`.
- **`getLogger()`** — ambient request logger inside middleware-established `runWithLogger` scope (e.g. tRPC procedures, route handlers). Returns a no-op outside that scope.

## Recipes

### Correlated domain event (inside a request)

```ts
import { getLogger } from "@useamplio/amplio";
import { OrderPlaced } from "../events/commerce/order-placed";

getLogger()
  .child(OrderPlaced)
  .set({ order: { id: "ord_1" } })
  .emit();
// spine row (http.request) + domain row — same request_id
```

`duration_ms` on the domain row measures time since `.child()` was called — the chain above reports `~0`. To time an operation, create the child first:

```ts
const ev = getLogger().child(OrderPlaced); // clock starts here
const order = await placeOrder();
ev.set({ order: { id: order.id } }).emit(); // duration_ms = placeOrder() time
```

### Job / cron scope

```ts
import { logger } from "../logger";

logger
  .create({ job: "nightly-sync" })
  .set({ records_processed: 42 })
  .emit();
```

### Serverless flush

Next.js middleware schedules `flush()` via `after()`; pass `waitUntil` when your platform supports it:

```ts
export const GET = withAmplio(handler, { waitUntil });
// or after the handler returns: await flush();
```

## Scripts

```bash
pnpm build
pnpm test
pnpm bench
pnpm size   # gzip target < 8KB
```

## License

MIT
