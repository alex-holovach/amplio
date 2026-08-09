# AGENTS.md — amplio

Instructions for AI agents and contributors working on the **amplio** monorepo.

## What amplio is

**amplio** is schema-first, wide-event telemetry that installs as **open code** in the user's repo — shadcn for observability.

| Principle | Meaning |
|---|---|
| Open code | Events, middleware, sinks, enrichers, integrations live in `telemetry/` and are owned by the app |
| Schema-first | Every important event is declared with `defineEvent` before use |
| Wide events | Accumulate context with `.set()`, emit once with `.emit()` per unit of work |
| Less is more | Tiny runtime (`@amplio/amplio`); no sprawling logger surface |
| shadcn-native | Registry items scaffold typed files into `telemetry/` |

**Not evlog.** evlog ships a closed npm runtime and optional module augmentation. amplio ships **schemas + generated code in the repo** and a tiny immutable core. Users read, edit, and review their telemetry like application code.

## Monorepo layout

```
amplio/
├── packages/
│   ├── core/          # @amplio/amplio — runtime only (defineEvent, init, wide-event lifecycle)
│   └── cli/           # @amplio/cli — init, add, registry resolution
├── registry/          # shadcn-compatible registry JSON + item sources
├── examples/          # runnable reference apps (Hono, Express, Fastify, Next.js, standalone)
├── benchmarks/        # perf + bundle size gates for @amplio/amplio
├── scripts/           # registry build, codegen helpers
├── AGENTS.md          # this file
├── REQUIREMENTS.md    # product requirements
└── SPEC.md            # technical spec + acceptance criteria
```

Work in the smallest package that owns the change. Do not leak CLI or codegen logic into `@amplio/amplio`.

## Public API (frozen surface)

Only these symbols are public from `@amplio/amplio`:

| Symbol | Role |
|---|---|
| `defineEvent` | Declare a named event schema (name + Zod/Standard Schema shape) |
| `init` | Configure global logger (sinks, enrichers, defaults) — called once from `telemetry/logger.ts` |
| `logger.event` | Start or bind a wide event by schema |
| `logger.create` | Create a standalone wide-event scope (jobs, scripts, CLI runs) |
| `useLogger` | Retrieve request-scoped logger from framework context (via middleware); returns a no-op logger outside ALS (does not throw) |
| `.set()` | Merge nested context into the active wide event (`DeepPartial` on schema-bound loggers) |
| `.error(err, ctx?)` | Record a structured error (`success: false`); does not emit — call `.emit()` after |
| `.emit()` | Finalize, validate, redact, and drain sinks synchronously; seals the instance |
| `flush()` | Await pending async sink deliveries (use with serverless `waitUntil` / Next.js `after`) |

`.set()` deep-merges: `null` overwrites; `undefined` in a patch is skipped (prior value kept).
`logger.set()` replaces arrays (does not concatenate); enrichers run in order and each sees fields from previous enrichers.
Schema validation soft-fails outside `NODE_ENV=test` unless `init({ strict: true })`; failed emits attach `validation.issues` and set `success: false`.

**Soft seal:** after `.emit()`, the instance is sealed. Further `.set()` / `.error()` are no-ops; repeat `.emit()` returns `null`. Post-seal `.create()` and `.event()` return sealed no-op loggers (not `null`). Ignored calls log a dev warning (`console.warn`).

**Do not add** `log.info`, `log.warn`, `log.debug`, or free-form string logging to the public API. Use `.error()` plus schema fields for structured errors — not printf-style methods.

## User repo layout (after `npx amplio init`)

```
telemetry/
├── events/           # one file per event schema (generated + editable)
├── middleware/       # on demand — hono, next, etc.
├── sinks/            # axiom, console, sentry, …
├── enrichers/        # request metadata, trace context, …
├── integrations/     # better-auth, ai-sdk, …
└── logger.ts         # init() + exported logger
```

CLI and registry items **write into** this tree. Generated code must be readable, typed, and diff-friendly.

## Naming conventions

| Thing | Convention | Example |
|---|---|---|
| Event name | `domain.entity.action` (dot-separated) | `auth.user.signed_up` |
| Event file | kebab-case | `auth-user-signed-up.ts` |
| Event type / schema export | PascalCase | `AuthUserSignedUp` |
| Middleware / sink / enricher files | kebab-case | `hono.ts`, `axiom.ts` |
| Registry item id | `@amplio/<kind>-<kebab-name>` | `@amplio/event-auth-user-signed-up` |

## Codegen & registry rules

1. **Registry first** — new scaffoldable items live in `registry/` with shadcn-compatible manifests.
2. **Readable output** — no minified one-liners; explicit imports; formatted like hand-written code.
3. **Schema in repo** — `defineEvent` calls and Zod (or compatible) schemas stay in `telemetry/events/`.
4. **Nested objects** — generated types and docs encourage grouping (`user`, `cart`, `error`), not flat `userId`, `userPlan`, …
5. **Idempotent add** — re-running `amplio add` must not destroy user edits; merge or skip with a clear message.
6. **Dependencies** — prefer peer deps on framework packages; `@amplio/amplio` stays dependency-free or near-zero.

## Anti-slop (enforce in reviews)

- No free-form `log.info("…")` as the primary observability path.
- No anonymous `{ [key: string]: unknown }` event payloads in generated code.
- No hidden globals beyond `init()` configuration.
- Core `init()` trims `service`/`env` (not only CLI `--service`).
- No duplicate emission — wide events seal after `.emit()`.
- No registry item that installs opaque `node_modules` telemetry logic the user cannot edit.

## Implementation priorities

When building features, prefer this order:

1. `@amplio/amplio` lifecycle (create → set → emit → seal)
2. `defineEvent` + typed `.set()` inference
3. CLI `init` + `add event`
4. Registry build + one reference event item
5. One middleware (Hono) + `useLogger`
6. One sink (console JSON) + one enricher

Sink and enricher failures are isolated: a throwing or non-object enricher is skipped (dev warn); later enrichers and sinks still run.
Enricher return values replace the emit payload (they do not deep-merge); return `{...record, ...}` to keep prior fields.
`init({ enrichers: [] })` clears previously registered enrichers.
After enrichers, event validation merge: validated shape fields overwrite enricher/payload keys on overlap; enricher-only keys are kept.
`getConfig()` returns shallow copies of `sinks`, `enrichers`, and `sampling` (including `keep` rules) — mutating those arrays does not change the active config. `init()` copies `sinks`, `enrichers`, and `sampling.keep`, so mutating the caller arrays after init is safe. A second `init()` that omits `enrichers`/`sampling` clears the previous enrichers/sampling (they do not stay active).
7. Examples and benchmarks

## Testing expectations

- **Unit tests** in `packages/amplio` for lifecycle, sealing, merge semantics, and schema validation at emit time.
- **CLI tests** for init/add against a temp directory (snapshot the generated tree structure, not necessarily every line).
- **Benchmarks** track `@amplio/amplio` bundle size and hot-path `set`/`emit` cost.
- **Examples** must run and emit at least one wide event end-to-end.

## Commands

```bash
pnpm install
pnpm run ci        # build + test + typecheck + size + registry + format check
pnpm build
pnpm test
pnpm typecheck
pnpm bench
pnpm size
pnpm registry:build
pnpm publish:smoke   # pack CLI + core, install outside monorepo, run amplio init
pnpm registry:serve  # local HTTP server for shadcn registry JSON (127.0.0.1:4173)
```

CLI surface (user-facing): `amplio init`, `amplio list [kind]` (id — title — description; titles when present), `amplio add <kind> <id>` (`--force` overwrites).

`amplio init` detects framework from `package.json` (Next.js, Hono, Express, Fastify via `packages/cli/src/utils/detect-framework.ts`) and can auto-scaffold middleware + a starter event.

Sampling keep rules support `equals` / `matches` / `gte` / `lte` and dotted paths (e.g. `attributes.http.status_code`); `gte`+`lte` on one rule is an inclusive AND range. `shouldSample` with no/undefined config always keeps. On a single keep rule, when `equals` is set, `matches`/`gte`/`lte` on that rule are not evaluated. `equals` uses Object.is (null matches null; 0 matches numeric zero; `""` matches empty string fields; absent fields still miss). `matches` only applies to string field values (non-strings do not match); if `matches` is set but the field is not a string, evaluation falls through to `gte`/`lte`; `gte`/`lte` only apply to number field values (non-numbers do not match) and work on nested dotted paths (e.g. `user.score`). Nested keep paths miss when an intermediate segment is absent or not an object. Keep rules do not match when the target field is absent. Rate `<= 0` drops non-matching events, including negative rates (`keep` rules are OR'd — any match keeps); rate `>= 1` always keeps (including values above 1). On a rate drop, `emit()` still returns the finalized record — only sink delivery is skipped. Enrichers and redaction still run on emit() when sampling skips sinks; only delivery is skipped. On emit, when `success` is unset it defaults to `true`; a numeric `status` in `[200, 400)` derives `success` when unset; an explicit `success` always wins.

`serviceMetadata` reads `AMPLIO_SERVICE` / `AMPLIO_SERVICE_VERSION` / `AMPLIO_REGION` (name falls back to record.service; unset or empty version/region omitted — empty env strings are treated as unset).

`requestMetadata` optional fields (`route` / `ip` / `userAgent` / `requestId`): empty strings are treated as unset (omitted from `http`); empty `requestId` does not overwrite an existing `request_id`. `createRequestId()` returns `req_<time36>_<rand36>` and is unique per call. `createRequestLogger({ requestId })` preserves the provided `request_id`.

## Commit guidance

- Scope commits to one package or concern.
- Do not commit secrets or example API keys.
- Update `SPEC.md` acceptance criteria checkboxes only when the feature is actually implemented and tested.
- User asked for local git only — **do not push** unless explicitly requested.

## Where to look

| Question | Document |
|---|---|
| What should we build? | `REQUIREMENTS.md` |
| How should it work? | `SPEC.md` |
| Quick user-facing intro | `README.md` |

When requirements and spec disagree, **SPEC wins for implementation**; escalate conflicts by updating REQUIREMENTS first, then SPEC.
