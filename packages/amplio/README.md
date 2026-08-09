# @useamplio/amplio

Tiny schema-first wide-event telemetry runtime. Zero runtime dependencies (`zod` optional peer).

**The spine.** amplio emits one wide event per unit of work — the **spine** (`http.request` for HTTP, `trpc.request` for server-caller tRPC). Everything that happens during that unit of work either *annotates* the spine (`.set()`) or emits a separate **domain event** row that shares the spine's `request_id`:

```jsonc
{"@event":"http.request","request_id":"req_x1","http":{"method":"POST","path":"/signup"},"status":200,"duration_ms":494,...}
{"@event":"auth.user.signed_up","request_id":"req_x1","user":{"id":"u_1"},"duration_ms":3,...}
```

Middleware owns and emits the spine; your code adds fields to it or emits correlated domain rows with `.child(EventDef)`.

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
| `createLogger(initial?)` | Wide-event builder: `.set()`, `.emit()`, `.create()`, `.event()`, `.child()`, `.time()` |
| `createRequestLogger({ method, path })` | HTTP helper with `request_id` |
| `runWithLogger` / `getLogger` | AsyncLocalStorage context (`getLogger` no-op outside ALS; `useLogger` deprecated alias) |
| `hasAmbientLogger()` | `true` inside a `runWithLogger` scope — used by middleware to decide between annotating the ambient spine and creating a standalone one |
| `createRequestId()` | New unique request id (`req_<time36>_<rand36>`) — pass to `createRequestLogger({ requestId })` to preserve an upstream id |
| `flush()` | Await pending async sink deliveries |
| `memorySink()` | In-memory sink for tests — assert on `sink.records`, reset with `sink.clear()` |
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
- **`.error(err)`** on `Error` instances: `error.message`, `error.name` (class name), and `error.code` only when `err.code` is a string or number (Node-style `ENOENT`, etc.) — plain `Error` omits `code`. Structured errors from `createError({ message, why, fix, code })` are recorded field-for-field. `.error()` sets `success: false` but **not** `status` — only transport middleware stamps `status`; a domain row's error is not an HTTP status.
- **Auto fields** on emit: `timestamp`, `duration_ms` (time since the logger was created — a `.child()` created right before `.emit()` reports `~0`; create the child before the work to time the work), `request_id` (when set), `success` (derived from `status` or set explicitly via `.set()` / `.error()` — omitted when neither applies), `service`, `env`. Schema events set `event` and `@event` to the declared name; `@event` is canonical, `event` is a duplicate because some sinks and columnar stores reject or mangle `@`-prefixed keys. Pass `init({ canonicalKeyOnly: true })` to emit only `@event`. `createRequestLogger` seeds `http.request` on both keys.
  **Dashboard implication:** clean domain rows (`.child(Def).emit()` with no `status`) omit `success` entirely, so `success = true` silently excludes them — filter domain events with `success != false` (or on `@event`) instead.
- **Redaction** is on by default (`redact: false` to opt out) — exact contract in [Redaction](#redaction) below. It runs at emit time, so fields derived before redaction (e.g. a length computed from a raw value) can look inconsistent next to `[REDACTED]`; that is expected.
- **Facade `logger.event(Def)` starts a fresh row on each call** — two calls emit two rows — and its `duration_ms` measures from that call (≈0 unless you hold the returned logger before emitting). Inside a `runWithLogger` scope it copies the ambient `request_id`; outside one the row has none. This is different from *instance* `.event(Def)`, which binds the schema to the same row (see the table below).
- **Next.js build-time emission:** `next build` static generation executes RSC pages, so emits fire during CI builds with `env: "production"`. Those records are tagged `build_phase: true` (detected via `NEXT_PHASE`) — filter dashboards with `build_phase != true`. To silence telemetry wholesale (CI, one-off scripts), set `AMPLIO_DISABLED=1`: every `.emit()` drops before sinks run.

## Redaction

The precise default contract (relying on this for compliance? read the limits):

**Field names** — any field whose (case-insensitive) key is one of `authorization`, `cookie`, `set-cookie`, `email`, `password`, `secret`, `token`, `access_token`, `refresh_token`, `card`, `card_number`, `credit_card`, `pan` has its string value replaced with `[REDACTED]`, at any nesting depth (arrays included). Exact key match only — `user_email` is *not* matched by `email`. Add your own with `init({ redact: { fields: ["ssn"] } })`.

**Value patterns** — scanned inside every string value, then again on decoded variants when the string looks encoded: the percent-decoded string (when it contains `%xx` escapes) and a form-decoded pass with `+` treated as a space (query strings form-encode spaces as `+`, which `decodeURIComponent` does not undo). The Bearer pattern also accepts `+` as the separator directly (`Bearer+abc…`).

| Pattern | Shape | Limits |
|---|---|---|
| Email | `local@domain.tld` (TLD ≥ 2 alpha) | — |
| JWT | `eyJ…`-prefixed 2–3 dot-separated base64url segments | only catches JWTs whose header starts `{"` (i.e. `eyJ`) |
| Credit card | Visa 13/16, Mastercard 51–55, Amex 34/37, Discover 6011/65 digit runs, with optional single space/dash separators (`4111 1111 1111 1111`, `4111-1111-1111-1111`) | must pass a Luhn check *and* a known brand prefix — other lengths/brands and non-Luhn numbers pass through |
| Bearer token | `Bearer <token68>` (case-insensitive) | — |
| Authorization header | `Authorization: <value>` inside strings | stops at whitespace/comma |

Add custom patterns with `init({ redact: { patterns: [/my-regex/g] } })`. Redaction does **not** parse query strings as key/value pairs — use the `query-allowlist` enricher for `http.search`.

**Encoding caveat:** when a pattern only matches after decoding, the stored value is the **decoded** string (and, if the match needed the form-decode pass, with `+` turned into spaces) — e.g. a percent-encoded `http.search` that gets redacted comes out decoded. Consumers parsing such fields must handle both encodings; leaking the value beats preserving its shape.

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

### `.child()` vs `.create()` vs `.event()` on a logger

| Method | What you get | Use when |
|---|---|---|
| `.child(EventDef)` | **New row** correlated to this one: copies `request_id` only, fresh clock and seal | Domain events inside a request — the canonical spelling |
| `.time(EventDef, fn)` | `.child()` created **before** `fn` runs, emitted after it settles — `duration_ms` measures `fn`; a throw records the error and rethrows | Timed domain events — the easy path for "how long did this take" |
| `.create(initial?)` | New independent logger that **copies all current fields**, fresh clock and seal | Forking a job/batch scope that should inherit context |
| `.event(EventDef)` | **Binds the schema to this same row** (same data, same seal — emitting it consumes this logger) | Naming/typing a spine you own, e.g. `createLogger().event(Def)` |

The module facade's `logger.event(Def)` is a third thing: a **fresh standalone row per call** (with the ambient `request_id` copied when inside request scope). Same method name, different receiver — on an instance it binds; on the facade it creates.

`.event(OtherDef)` on a logger that is already bound to a different event name (e.g. the request spine) behaves as `.child(OtherDef)` — a separate correlated row, spine preserved — with a dev notice. Earlier alphas rebound and sealed the spine (silently losing the request row); that footgun is gone, but spell it `.child()` to make the intent explicit.

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

Or use `.time()` — the timed path as the easy path (child created before the work, emitted after; errors are recorded and rethrown):

```ts
const order = await getLogger().time(OrderPlaced, async (ev) => {
  const order = await placeOrder();
  ev.set({ order: { id: order.id } });
  return order;
}); // duration_ms = placeOrder() time, row emitted automatically
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
