# SPEC.md — amplio

Technical specification and acceptance criteria for **amplio**.

## 1. Overview

amplio provides:

1. **`@useamplio/amplio`** — immutable runtime for schema-first wide events.
2. **`@useamplio/cli`** — project init and registry-driven `add`.
3. **`registry/`** — shadcn-compatible item definitions.
4. **User-owned `telemetry/`** — events, sinks, enrichers, middleware, integrations.

### Design tenets

- **One wide event per unit of work** — request, job, or run.
- **Set then emit** — context accumulates; emission is explicit or middleware-driven.
- **Schema at the edge** — event definitions live in user repo files.
- **Drain pipeline** — enrichers → validation → sinks (user-configured in `init()`).

## 2. Terminology

| Term | Definition |
|---|---|
| **Event name** | Stable id: `domain.entity.action` (e.g. `auth.user.signed_up`) |
| **Event schema** | Standard Schema-compatible validator + metadata from `defineEvent` |
| **Wide event** | In-memory builder holding merged context until emit |
| **Scope** | Request-scoped (AsyncLocalStorage) or standalone instance |
| **Seal** | Post-emit state; further `.set()` / `.emit()` are no-ops |
| **Drain** | Serialize, enrich, validate, write to sinks |

## 3. Repository structure

### 3.1 Monorepo

```
packages/amplio/       → @useamplio/amplio
packages/cli/        → @useamplio/cli
registry/            → item sources + built manifest
examples/
  hono/              → HTTP middleware reference
  standalone/        → logger.create reference
benchmarks/          → core perf + size
scripts/build-registry.mjs
```

### 3.2 User project (post-init)

```
telemetry/
├── events/
│   └── auth-user-signed-up.ts
├── middleware/          # created on demand
│   └── hono.ts
├── sinks/
│   └── console-json.ts
├── enrichers/
│   └── service-metadata.ts
├── integrations/
│   └── better-auth.ts
└── logger.ts
```

## 4. Public API

### 4.1 `defineEvent`

```typescript
import { defineEvent } from "@useamplio/amplio";
import { z } from "zod";

export const AuthUserSignedUp = defineEvent(
  "auth.user.signed_up",
  z.object({
    user: z.object({
      id: z.string(),
      email: z.string().email().optional(),
    }),
    signup: z.object({
      method: z.enum(["email", "oauth", "invite"]),
      referrer: z.string().optional(),
    }),
  }),
);
```

**Rules:**

- First argument (name) MUST match `/^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*){2}$/`.
- Second argument (shape) MUST implement [Standard Schema](https://standardschema.dev) (`~standard.validate`).
- Returns opaque event definition with phantom types for inference.

### 4.2 `init`

```typescript
// telemetry/logger.ts
import { init } from "@useamplio/amplio";
import { consoleJsonSink } from "./sinks/console-json";
import { serviceMetadata } from "./enrichers/service-metadata";

export const logger = init({
  service: "my-app",
  env: process.env.NODE_ENV,
  enrichers: [serviceMetadata],
  sinks: [consoleJsonSink],
});
```

- Called once; repeated calls throw in development.
- Returns `{ event, create }` bound to global config.
- Optional `sampling: { rate, keep }` — `keep` rules support `equals` / `matches` / `gte` / `lte` and dotted paths (e.g. `attributes.http.status_code`).
- A keep rule with both `gte` and `lte` forms an inclusive AND range (value must be ≥ `gte` and ≤ `lte`).
- Multiple `keep` rules are OR'd — any matching keep rule keeps the record.
- `rate: 0` with no `keep` (or an empty `keep` list) drops all events; `rate: 1` always samples (`keep` rules are irrelevant).

### 4.3 `logger.create`

```typescript
const run = logger.create({
  run: { id: "job-123", kind: "nightly-sync" },
});

run.set({ sync: { tables: 4 } });
run.emit(); // validates if schema bound; otherwise freeform within init defaults
```

Standalone wide events for scripts, workers, CLI.

### 4.4 `logger.event`

```typescript
const ev = logger.event(AuthUserSignedUp, {
  user: { id: "u_1" },
});

ev.set({ signup: { method: "oauth" } });
ev.emit();
```

- Binds instance to schema; emit runs validation.
- Partial initial context optional.

### 4.5 `useLogger`

```typescript
import { useLogger } from "@useamplio/amplio";

export async function handler(c: Context) {
  const log = useLogger();
  log.set({ route: { name: "checkout" } });
  // middleware emits on response finish
}
```

- Retrieves current scope from AsyncLocalStorage.
- Returns a no-op logger when no scope is active (does not throw); dev warns on misuse.

### 4.6 `.set()` / `.emit()`

```typescript
interface WideEvent {
  set(partial: DeepPartial<Context>): this;
  error(err: unknown, ctx?: Record<string, unknown>): this;
  emit(): EmittedEvent | null;
}
```

**Merge semantics:**

- Objects: deep merge (recursive plain objects only).
- Arrays: replace (no concat) unless future spec adds `setMergeArrays`.
- `undefined` values: ignored (do not unset keys).
- `null`: sets key to null.

**Emit semantics:**

1. If sealed → dev warning, return `null`.
2. Run enrichers (in registration order).
3. If schema-bound → validate; on failure throw `AmplioValidationError` in test or when `init({ strict: true })`, otherwise soft-fail (attach `validation.issues`, set `success: false`, dev warn).
4. Redact sensitive fields (on by default; `redact: false` to disable).
5. Attach system fields: `timestamp`, `@event`, `service`, `env`, `duration_ms`, `level` (derived).
6. Fan-out to sinks synchronously (`flush()` awaits pending async sink deliveries; sink errors logged, do not throw by default).
7. Seal instance.

**Level derivation (v0):**

- Default `info`.
- If payload contains `error` object (nested key `error` with `message: string`) → `error`.
- Explicit `level` in schema allowed; must be enum `debug | info | warn | error`.

**Success from `status` (v0):**

When both `status` and `success` are unset, `success` defaults to `true`.

When `success` is unset and `status` is present on emit, derive `success`:

- Numeric: `[200, 400)` → `true`; otherwise → `false`.
- Numeric strings: same range as numeric (e.g. `"200"` → `true`, `"500"` → `false`).
- `"ok"` → `true` (case-sensitive exact match only; `"OK"` → `false`).
- Other non-numeric strings → `false`.

Explicit `success` wins over `status` derivation (ignore `status` when `success` is set).

## 5. Naming & files

| Artifact | Rule | Example |
|---|---|---|
| Event name | `domain.entity.action` | `billing.invoice.paid` |
| File | kebab-case | `billing-invoice-paid.ts` |
| Export | PascalCase matching semantic | `BillingInvoicePaid` |
| Registry id | `@useamplio/event-<kebab-full-name>` | `@useamplio/event-billing-invoice-paid` |

CLI `add event billing.invoice.paid` → `telemetry/events/billing/invoice-paid.ts` (+ barrels).

## 6. CLI

### 6.1 Commands

| Command | Behavior |
|---|---|
| `amplio init` | Scaffold `telemetry/`, config, default sink |
| `amplio list [kind]` | List registry items with titles when present (optional kind filter) |
| `amplio add event <name>` | Add event file + export |
| `amplio add middleware <id>` | Add middleware file + wiring instructions |
| `amplio add sink <id>` | Add sink module |
| `amplio add enricher <id>` | Add enricher module |
| `amplio add integration <id>` | Add integration helper |

### 6.2 Init options

- `--cwd` (default `.`)
- `--package-manager` (`pnpm` | `npm` | `yarn` | `bun`)
- `--typescript` (default true)
- Framework detection from `package.json` (Next.js, Hono, Express, Fastify) via `detect-framework`; `--middleware`, `--event`, `--yes` for non-interactive scaffold

### 6.3 Registry resolution

1. Read project config for registry URL / namespace.
2. Fetch item manifest (local file in dev, HTTPS in prod).
3. Copy files into paths relative to cwd.
4. Merge `dependencies` / `devDependencies` into package.json.

## 7. Registry format

shadcn-compatible item:

```json
{
  "name": "event-auth-user-signed-up",
  "type": "registry:amplio",
  "files": [
    {
      "path": "registry/events/auth-user-signed-up.ts",
      "target": "telemetry/events/auth-user-signed-up.ts"
    }
  ],
  "dependencies": ["zod"],
  "registryDependencies": []
}
```

Built output published to `registry/` as static JSON for CDN or git raw hosting.

## 8. Middleware (reference: Hono)

`telemetry/middleware/hono.ts`:

- On request: `logger.create()` or anonymous wide event with `{ http: { method, path } }`.
- Store in ALS + Hono context (`c.set('amplio', log)`).
- On response `finish` / `error`: `await log.emit()`.
- Export factory `amplioMiddleware()` and typed `useLogger(c)`.

Auto-emit is middleware responsibility, not `@useamplio/amplio` magic.

Next.js middleware (`registry/middleware/next.ts`): wraps handlers with AsyncLocalStorage via `runWithLogger`, auto-emits on response, and schedules `flush()` via Next.js `after`, optional `waitUntil`, or a fire-and-forget fallback.

## 9. Sinks & enrichers

### Sink

```typescript
export type AmplioSink = (event: Record<string, unknown>) => void | Promise<void>;
```

### Enricher

```typescript
export type AmplioEnricher = (
  event: Record<string, unknown>
) => Record<string, unknown> | Promise<Record<string, unknown>>;
```

Both are user-editable modules; core only invokes arrays registered in `init()`.

`serviceMetadata` uses `AMPLIO_SERVICE` / `AMPLIO_SERVICE_VERSION` / `AMPLIO_REGION` (name falls back to `record.service`; unset or empty-string version/region omitted — empty env strings are treated as unset).

`requestMetadata` / request-metadata enricher: empty-string optional `route` / `ip` / `userAgent` / `requestId` ≡ unset (omitted from `http`; empty `requestId` does not wipe an existing `request_id`). `status` is still included when `0`.

OTLP sink: when present, maps `record.service` → resource `service.name` and `record.env` → `deployment.environment`.

JSON file sink: `AMPLIO_JSON_SINK_PATH` empty or whitespace-only is treated as unset → default `amplio.jsonl`; `options.path` wins when set.

## 10. Anti-slop rules

1. **No printf primary path** — examples must not demonstrate `log.info("user signed up")` as main telemetry.
2. **Nested shapes** — event templates group fields (`user`, `error`, `http`, `billing`).
3. **Readable codegen** — max line length 100; multiline objects; named exports.
4. **Stable event names** — `@event` field always set from `defineEvent.name`.
5. **One emit per scope** — sealed loggers prevent duplicate request events.

## 11. `@useamplio/amplio` internals (non-public)

May include: ALS store, merge util, validate adapter, seal flag, dev warnings.

Must NOT include: vendor SDKs, framework imports, CLI, code generation.

## 12. Error model

```typescript
class AmplioValidationError extends Error {
  issues: StandardSchemaIssue[];
}

class AmplioSealedError extends Error {} // dev-only throw if strict mode
```

Structured errors via `.error()` (does not auto-emit):

```typescript
log.error(new PaymentError("Card declined"), { billing: { order_id: "ord_1" } });
log.emit();
```

Or set an `error` object directly with `.set()` when you prefer manual shaping.

## 13. Type inference

`defineEvent` infers:

- Required/optional keys for `.set()` after bind.
- Emit return type `EmittedEvent<TSchema>`.

Standalone `logger.create()` without schema uses `init` default context type or `Record<string, unknown>`.

## 14. Security

- Core redacts emails, JWTs, Bearer tokens, credit cards, and sensitive field names on every emit by default; pass `redact: false` to `init()` to disable.
- Document never logging passwords, tokens, raw cookies.

## 15. Compatibility

- Node ≥ 20.
- TypeScript ≥ 5.4.
- ESM-first (`"type": "module"`).

## 16. Acceptance criteria

### AC-1 Monorepo bootstrap

- [x] `packages/amplio`, `packages/cli`, `registry/`, `examples/`, `benchmarks/` exist and `pnpm build` succeeds.
- [x] Root scripts (`build`, `test`, `bench`, `size`, `registry:build`) run without error.

### AC-2 Core API surface

- [x] `@useamplio/amplio` exports a frozen public surface (`defineEvent`, `init`, `logger`/`createLogger`, `useLogger`/`runWithLogger`, errors, types) — verified by tests.
- [x] `init()` returns `logger` with `.event()` and `.create()`.
- [x] Wide event instances expose `.set()`, `.error()`, and `.emit()` (no level methods like `.info()`).
- [x] Public API documented in package README and matches this spec.

### AC-3 defineEvent & validation

- [x] Invalid event name rejected at definition time (`defineEvent` + CLI).
- [x] Schema-bound emit validates with Standard Schema adapter.
- [x] Validation failure throws `AmplioValidationError` in test or `strict: true`; otherwise soft-fails with `validation.issues` on the record.
- [x] Successful emit includes `@event` equal to declared name.

### AC-4 Wide-event lifecycle

- [x] Deep merge for nested objects; arrays replace; `undefined` in patch keeps prior values.
- [x] Second `.emit()` returns `null` and warns in development.
- [x] Post-seal `.set()` is ignored with dev warning.
- [x] Post-seal `.create()` returns sealed no-op logger with dev warning.
- [x] Post-seal `.event()` returns sealed no-op event logger with dev warning.
- [x] Enrichers run before validation; sinks run after validation.

### AC-5 Init & drain

- [x] Multiple sinks receive the same finalized payload.
- [x] Sink failure does not prevent other sinks from running (sink isolation).
- [x] Sync/async sink errors do not throw from `.emit()`.
- [x] Library-first silence: `.emit()` without `init()` returns a record and does not throw.
- [x] `redact: false` disables default redaction on emit.
- [x] `service` and `env` from init appear on every emitted event.

### AC-6 CLI init

- [x] `npx @useamplio/cli@alpha init` creates `telemetry/logger.ts`, `telemetry/events/`, `telemetry/middleware/`, `telemetry/sinks/`, `telemetry/enrichers/`, `telemetry/integrations/`.
- [x] Default console JSON sink wired and importable.
- [x] Second `amplio init` is idempotent — existing files left unchanged.
- [x] CLI `--help` and `--version` exit 0.
- [x] Project compiles after init (`telemetry/events/index.ts` scaffolded as `export {}`).

### AC-6b CLI list

- [x] `amplio list` prints grouped registry items and exits 0.
- [x] `amplio list sink` filters to sink items only.

### AC-7 CLI add event

- [x] `amplio add event auth.user.signed_up` creates `telemetry/events/auth/user-signed-up.ts`.
- [x] File contains `defineEvent`, Zod schema with nested objects, PascalCase export.
- [x] Re-run skips existing files; `--force` overwrites (documented in README).

### AC-8 Registry

- [x] `pnpm registry:build` emits shadcn-compatible JSON.
- [x] At least one event item installable via `shadcn add @useamplio/event-auth-user-signed-up` (shadcn-compatible `public/r` install proven in tests).
- [x] Registry item lands files only under `telemetry/` (`~/…` targets).

### AC-9 Middleware (Hono example)

- [x] Example app in `examples/basic` uses `amplioMiddleware`.
- [x] One wide event emitted per HTTP request (smoke scripts).
- [x] Handler uses `useLogger()` and `.set()`; no manual emit in handler.
- [x] Emitted JSON includes nested `http` object.

### AC-10 Standalone example

- [x] `examples/standalone` uses `logger.create()` + `.emit()`.
- [x] Demonstrates schema-bound `logger.event()`.

### AC-11 Anti-slop

- [x] No example uses string-only logging as primary telemetry.
- [x] Generated event files pass Prettier defaults (CLI + registry tests).
- [x] All shipped event templates use nested object schemas (minimum depth 2 for domain fields).

### AC-12 Performance & size

- [x] `pnpm size` reports `@useamplio/amplio` ≤ 8 KB gzip.
- [x] Benchmark documents `set` + `emit` median & p99 for 1 KB payload (`pnpm bench`).
- [x] Core package ships with zero runtime dependencies.

### AC-13 Differentiation

- [x] README states open-code + in-repo schema vs opaque npm runtime.
- [x] User can delete `@useamplio/cli` after init and keep editing `telemetry/` with only `@useamplio/amplio` installed (documented in README).

### AC-14 Tests

- [x] Unit tests cover merge, validation, sampling, redaction, ALS, sinks.
- [x] CLI integration test scaffolds temp dir and asserts file tree.
- [x] `examples/basic`, `express-smoke`, and `fastify-smoke` smoke scripts assert one JSON wide event with nested `http`.

## 17. Versioning

- Pre-1.0: minor bumps may break generated file templates; core API stable after 0.2.
- Registry items versioned independently in manifest `version` field.
- Event schemas are user-owned; breaking changes are explicit repo edits.

## 18. Future (post-v0, not acceptance)

- Head/tail sampling in `init({ sample })`
- `logger.fork()` for sub-operations
- OpenTelemetry trace correlation enricher
- `amplio add integration ai-sdk`

---

**Status:** Spec draft for initial implementation. Update checkboxes as criteria are verified in CI or manual QA.
