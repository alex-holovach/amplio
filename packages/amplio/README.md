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
| `init(config)` | Service metadata, sinks, enrichers, sampling, redaction; returns `logger` |
| `defineEvent(name, shape?, options?)` | Typed event schema (Zod 3+ or Standard Schema) |
| `createLogger(initial?)` | Wide-event builder: `.set()`, `.emit()`, `.create()`, `.event()`, `.child()` |
| `createRequestLogger({ method, path })` | HTTP helper with `request_id` |
| `runWithLogger` / `useLogger` | AsyncLocalStorage context (`useLogger` no-op outside ALS) |
| `flush()` | Await pending async sink deliveries |
| `createError({ message, why, fix, code, link })` | Structured errors for events |
| `deepMerge` | Fast merge used by `.set()` |
| `AmplioValidationError` | Thrown on schema validation failure; includes `issues` with paths |

## Behavior

- **Library-first silence:** Use `createLogger()` / `.emit()` without calling `init()` first — `.emit()` returns `null` (event dropped), no sinks run, dev warns **on every dropped emit** (mentions Turbopack / separate module graphs); never throws. Wire `init({ service, env, sinks: [...] })` when you want output. `getConfig()` still throws if called before `init()`.
- **Pipeline:** enrichers → validation → redaction → sampling → sinks.
- **No level methods** on wide events — use `.set()` / `.error()` / `.emit()` (plus `.create()` / `.event()` on the logger facade).
- **Mutable `.set()`** deep-merges fields in place (`DeepPartial` on schema-bound loggers; ALS-safe); **`.emit()`** runs enrichers → validation → redaction → sampling → sinks synchronously, then seals the logger. **`flush()`** awaits pending async sink deliveries.
- **Soft seal:** after `.emit()`, the instance is sealed. Further `.set()` / `.error()` are no-ops; repeat `.emit()` returns `null`. Post-seal `.create()` and `.event()` return sealed no-op loggers (not `null`). Ignored calls log a dev warning (`console.warn`).
- **`useLogger()`** returns a no-op logger outside AsyncLocalStorage (does not throw).
- **Validation** soft-fails outside `NODE_ENV=test` unless `init({ strict: true })`; failed emits attach `validation.issues` and set `success: false`.
- **`.error(err)`** on `Error` instances: `error.message`, `error.name` (class name), and `error.code` only when `err.code` is a string or number (Node-style `ENOENT`, etc.) — plain `Error` omits `code`. Structured errors from `createError({ message, why, fix, code })` are recorded field-for-field.
- **Auto fields** on emit: `timestamp`, `duration_ms`, `request_id` (when set), `success` (from `status`), `service`, `env`. Schema events set `event` and `@event` to the declared name; `@event` is canonical, `event` is a duplicate for `@`-averse sinks. `createRequestLogger` seeds `http.request` on both keys.
- **Sampling**: `rate` (0–1, fraction of records to emit) plus `keep` rules that always emit matching records. `field` supports dotted paths (e.g. `user.plan`) with `equals`, `matches` (regex), or `gte` (numeric). Example: `{ field: "user.plan", equals: "enterprise" }`.
- **Redaction**: emails, JWTs, Bearer tokens, credit cards, and sensitive field names (on by default; pass `redact: false` to `init()` to opt out).

## Recipes

### Correlated domain event (inside a request)

```ts
import { useLogger } from "@useamplio/amplio";
import { OrderPlaced } from "../events/commerce/order-placed";

useLogger()
  .child(OrderPlaced)
  .set({ order: { id: "ord_1" } })
  .emit();
// spine row (http.request) + domain row — same request_id
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
