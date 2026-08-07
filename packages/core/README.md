# @logcn/core

Tiny schema-first wide-event telemetry runtime. Zero runtime dependencies (`zod` optional peer).

## Install

```bash
pnpm add @logcn/core
# optional validation
pnpm add zod
```

## Quick start

```ts
import { init, defineEvent, createLogger } from "@logcn/core";
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
| `createLogger(initial?)` | Wide-event builder: `.set()`, `.emit()`, `.create()`, `.event()` |
| `createRequestLogger({ method, path })` | HTTP helper with `request_id` |
| `runWithLogger` / `useLogger` | AsyncLocalStorage context |
| `createError({ message, why, fix, code, link })` | Structured errors for events |
| `deepMerge` | Fast merge used by `.set()` |
| `LogcnValidationError` | Thrown on schema validation failure; includes `issues` with paths |

## Behavior

- **Library-first silence:** Use `createLogger()` / `.emit()` without calling `init()` first — emit is a no-op (returns a record, never throws; no sinks run). Wire `init({ service, env, sinks: [...] })` when you want output. `getConfig()` still throws if called before `init()`.
- **Pipeline:** enrichers → validation → redaction → sampling → sinks.
- **No level methods** on wide events — only `.set()` / `.emit()` (plus `.create()` / `.event()` on the logger facade).
- **Mutable `.set()`** deep-merges fields in place (ALS-safe); **`.emit()`** runs validation → redaction → sampling → sinks, then seals the logger.
- **Soft seal:** after `.emit()`, the instance is sealed. Further `.set()` is a no-op; `.emit()`, `.create()`, and `.event()` return `null`. Ignored calls log a dev warning (`console.warn`).
- **Auto fields** on emit: `timestamp`, `duration_ms`, `request_id` (when set), `success` (from `status`), `service`, `env`. Schema events also set `event` and `@event`.
- **Sampling**: `rate` (0–1, fraction of records to emit) plus `keep` rules that always emit matching records. `field` supports dotted paths (e.g. `user.plan`) with `equals`, `matches` (regex), or `gte` (numeric). Example: `{ field: "user.plan", equals: "enterprise" }`.
- **Redaction**: emails, JWTs, Bearer tokens, credit cards, and sensitive field names (on by default; pass `redact: false` to `init()` to opt out).

## Scripts

```bash
pnpm build
pnpm test
pnpm bench
pnpm size   # gzip target < 8KB
```

## License

MIT
