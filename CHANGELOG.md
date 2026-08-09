# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0-alpha.9] - 2026-08-09

Dogfood iter 4 — packaging, docs, and emit/sampling semantics alignment.

### Runtime

- **`.emit()` return** — returns `null` whenever the record was **not delivered** (before `init()`, after seal, or sampled out). Enrichers and redaction still run on sampled-out emits; only sink delivery is skipped.
- **`success` field** — omitted when neither `status` nor explicit `success` is set; numeric `status` in `[200, 400)` or exact `"ok"` derives `success: true`.
- **Redaction** — also scans URL-decoded copies of percent-encoded strings.
- **`init({ canonicalKeyOnly: true })`** — drops duplicate `event` key; keeps `@event`.
- **`@useamplio/amplio/events`** — client-safe subpath (`defineEvent`, types; no `node:async_hooks`).
- **`scheduleFlush()` / `trpcErrorHttpStatus()`** — new runtime exports for serverless flush and tRPC status mapping.

### CLI

- **Version sync** — `@useamplio/cli` bumped to `0.1.0-alpha.9`.
- **Per-command `--help`** — `amplio init|add|list|doctor --help`.
- **`amplio doctor --strict`** — non-zero exit on warnings (CI gate).
- **`amplio list --json`** — machine-readable registry listing.
- **`init`** — no longer auto-scaffolds `auth.user.signed_up` unless an auth dependency is detected; minimal `components.json`.
- **`add event`** — prints `matched registry event` vs `generated starter schema`; hints use full GitHub URLs.

### Registry templates

- Thinned templates use runtime `scheduleFlush` / `trpcErrorHttpStatus`.
- **`registry/logger.ts`** — unified with init template (no `composeSinks`).
- **`otlpSink`** — defaults to `throwOnError: false` (warn once; opt in to fail hard).

### Docs

- **`ALPHA.md` + `docs/`** — copied into published `@useamplio/amplio` and `@useamplio/cli` tarballs at build time.
- **README `## Sampling`** — rate/keep rules and sampled-out `.emit()` → `null` note.
- **ALPHA.md / CLI README / t3.md** — emit return semantics, `canonicalKeyOnly`, client-safe events subpath, `amplio.json` registry override, two-segment event names, updated success derivation.

## [0.1.0-alpha.8] - 2026-08-09

### Runtime

- **`Logger.child(EventDef)`** — first-class correlated domain event: fresh seal and start time (`duration_ms` measures the child's work), copies `request_id` only (no `http.*` / `trpc.*` duplication). Emitting the child does not seal the request spine.
- **`logger.event(def)` (facade)** — inside request scope (ALS), copies `request_id` into the standalone event; outside a request unchanged.
- **Instance `.event(def)`** — still rebinds the current wide event (shared seal/data); dev now warns loudly when emitting a rebind of an already-named spine (e.g. `http.request`).
- **`.create()` forks** — fresh start time (no longer inherit parent elapsed time).
- **`.error(createError({ … }))`** — structured errors record `message` / `why` / `fix` / `code` field-for-field (fixes `[object Object]`).
- **`globalThis[Symbol.for('amplio.state.v1')]`** — `init()` and ALS state shared across bundler module graphs (e.g. `next dev --turbo` compiling instrumentation and routes separately).
- **emit-before-init dev warning** — fires on every dropped emit (was warn-once); mentions Turbopack / separate module-graph cause.

### CLI

- **`amplio doctor`** — warns when `telemetry/middleware/next.ts` or `trpc.ts` lacks side-effect `import "../logger"` (Turbopack condition); checks event barrel exports (incl. shadcn-installed events).
- **`amplio doctor --fix`** — regenerates missing event barrel exports.
- **`amplio init --paths`** — writes `~telemetry/*` tsconfig path alias (JSONC-comment-safe).
- **`amplio add <badkind>`** — errors with valid kinds instead of silent fallthrough.
- **`amplio add enricher request`** — no longer inserts an unused import into `logger.ts`.

### Templates & registry

- **Next / tRPC middleware templates** — begin with side-effect `import "../logger";` (belt-and-braces with runtime global state).
- **tRPC server-caller path** — spine row is `trpc.request` with `transport: "server-caller"` and `trpc.path` / `trpc.type`; no fabricated `http.method: "TRPC"` or `http.*` on non-HTTP invocations (RSC `createCaller`). HTTP tRPC through `withAmplio` unchanged (`http.request`).
- **Registry integration deps** — pinned versions (no more `"resend": "*"` wildcards).

### Docs

- **ALPHA.md** — correlated domain events (`.child()`), fixed Hono/Next examples, Turbopack note, server-caller tRPC model, server-only caveat, CLI reference.
- **README.md** — `.child()` recipe, updated API table, per-drop emit warning, server-only note.
- **docs/t3.md** — create-t3-app / Next 15 / tRPC v11 walkthrough.

## [0.1.0-alpha.7] - 2026-08-09

### Added
- **tRPC v11 middleware** — rewritten for result inspection (`{ ok: false, error }` annotates the request spine); generic `amplioTrpcMiddleware()` plugs into `t.middleware(...)` / `procedure.use(...)` without casts; batched links set `trpc.batched: true` and `trpc.procedures` while `trpc.path` stays on the first procedure.
- **`amplio doctor`** — wiring checks (middleware exports referenced, event schemas, tsconfig paths) with fix hints.
- **Registry strict typecheck** — CI fixture typechecks all registry sources under create-t3-app-style strict `tsconfig` (incl. tRPC no-cast contract).
- **Docs** — ALPHA.md `## tRPC (v11)` wiring guide; README accuracy for emit-before-init, error shape, `http.request` spine, query-string redaction caveat, registry `~/` targets.

### Changed
- **`.error(err)`** — records `error.name` (thrown class name); sets `error.code` only when the value carries a real string/number `code` (not on plain `Error`).
- **Request wide events** — `createRequestLogger` sets `event` / `@event` to `http.request` (filterable HTTP spine).
- **Registry build** — `registryDependencies` namespaced as `@useamplio/…`; file targets root-anchored as `~/telemetry/…` so shadcn and CLI agree on placement in `src/` layouts.
- **emit() before init()** — returns `null` and drops the event (dev warns once); docs no longer claim a record is returned.
- **CLI init** — default `--service` from `package.json` name; tRPC detected alongside Next scaffolds `telemetry/middleware/trpc.ts`; wiring snippets point at ALPHA.md.

### Fixed
- **OTLP sink** — type fixes for strict `tsconfig` (`JsonValue` attribute mapping, timestamp parsing).
- **shadcn registry** — namespaced dependencies and `~/telemetry/…` targets fix misplaced installs in monorepos with `src/`.

### Performance
- Redaction: compile config once at `init()` (gated regex prechecks, copy-on-write subtrees); `redact: false` stays zero-cost; nested emit uses an inline leaf walk with safe-string / pattern-scan gates (~166k ops/s on ~1 KB nested payload vs ~1M flat with redaction on).
- Logger: class instances with shared prototype methods (`InternalLoggerImpl`) — no per-instance closure factories or `defineProperty` sealed getter.
- Payload ownership: `_ownsData` enables in-place `.set()` and skips emit-time clone when the logger owns its data; single-pass `.set()` and flat-path fast paths in `deepMerge`.
- Emit: one record build (stamp `service`/`env`/timestamp once, single `resolveConfig()`, skip payload copy when nothing mutates it); `alwaysSample` fast path when sampling cannot drop.

### Notes
- P1#9: Hero quick start omits email (uses `user.id` + `signup.method`); `AuthUserSignedUp` schema makes `user.email` optional in registry, CLI template, and example-basic.
- P1#9: README redaction note no longer demos `[REDACTED]` in the hero JSON; example-basic `/signup` needs no request body.
- Docs sync: AGENTS.md, SPEC.md, and packages/amplio/README.md match shipped API (no-op `useLogger` outside ALS, sealed no-op loggers, `.error()`/`flush()`, sync `emit()`, soft-fail validation, default redaction, `defineEvent(name, schema)`, Next middleware flush).
- P1#7: `flush()` tracks pending async sinks; Next middleware schedules flush via `after` / optional `waitUntil`; dev warns on async sink rejections.
- P1#8: `amplio init` detects framework from package.json and auto-scaffolds middleware + event (`--middleware`, `--event`, `--yes`).
- `EventLogger.error(err, ctx?)` delegates to bound logger; noop getters removed from public index.
- P1#5: `DeepPartial<T>` on typed `EventLogger.set()` and `logger.event(def, initial?)` for nested incremental patches.
- P1#6: `Logger.error(err, ctx?)` records structured errors without auto-emit; middleware uses `error()` instead of local `formatError` helpers.
- README quick start: problem → setup → emitted JSON sample; CLI exit-code/flag trivia moved to CLI reference section.
- Sealed create/event and useLogger() outside ALS return no-op loggers (never null/undefined); dev warnings for sealed vs no-context misuse.
- Next middleware: useRequestLogger() reads ALS (no module-scoped activeLogger race).
- emit() soft-fails schema validation outside NODE_ENV=test unless init({ strict: true }); attaches validation.issues and success: false.
- Improvement loop capped at 215 ticks; local wrap-up (no remote push).
- shouldSample with no/undefined config always keeps.
- Keep rule: if equals is set, matches/gte/lte on the same rule are not evaluated.
- Keep rule: if matches is set but the field is not a string, evaluation falls through to gte/lte.
- Enricher return values replace the emit payload (they do not deep-merge); return `{...record, ...}` to keep prior fields.
- Event validation merge: validated shape fields overwrite enricher/payload keys on overlap; enricher-only keys are kept.
- Sampling rate <= 0 drops (including negative rates) when no keep matches.
- Keep equals uses Object.is (so equals: null matches null fields; absent fields still miss).
- Keep equals: 0 matches numeric zero.
- Keep equals: "" matches empty string fields (absent still misses).
- Keep `gte`/`lte` only apply to number field values; non-numbers do not match.
- Keep gte/lte work on nested dotted paths (e.g. user.score).
- Nested keep paths miss when an intermediate segment is absent or not an object.
- Keep `matches` only applies to string field values; non-strings do not match.
- Sampling rate >= 1 always keeps (including values above 1).
- Sampling keep rules do not match when the target field is absent.
- Enrichers and redaction still run on emit() when sampling skips sinks; only delivery is skipped.
- emit() still returns the finalized record when sampling skips sinks (rate drop); only sink delivery is skipped.
- Second init() without enrichers/sampling clears the previous enrichers/sampling (does not leave them active).
- init({ enrichers: [] }) clears previously registered enrichers.
- init() copies sinks and enrichers arrays so mutating the caller arrays after init does not alter active config.
- getConfig()/init() copy sampling (incl. keep rules) so caller mutation does not alter active config.
- Registry serve: DELETE on item paths returns 405 Method Not Allowed.
- getConfig() returns shallow copies of sinks and enrichers (caller mutation does not alter active config).
- Registry serve: POST on item paths returns 405 Method Not Allowed.
- Registry serve: PUT on item paths returns 405 Method Not Allowed.
- Logger.set() returns the same instance for chaining.
- logger.set() replaces arrays (does not concatenate).
- Registry serve: HEAD on item paths returns 200 + application/json with empty body.
- Registry serve: OPTIONS on item paths returns CORS preflight (same as /registry.json).
- Enrichers run in order; each sees fields from previous enrichers.
- Sampling keep dotted paths (e.g. user.plan) apply at rate 0.
- Emit records use trimmed `service`/`env` from init().
- Sampling keep `gte`/`lte` still apply at rate 0 (emit path).
- createError({ message }) omits why/fix/code/link when not provided.
- Sampling keep `equals`/`matches` still apply at rate 0 (emit path).
- init() rejects empty/whitespace-only service and env (same as missing).
- init() trims service/env before storing (leading/trailing whitespace stripped).
- init() requires service, env, and at least one sink (throws otherwise).
- init() rejects non-array sinks (same error as empty sinks).
- Nested set()/deepMerge keeps sibling keys when patching a nested object.
- logger.set() deep-merge: null overwrites; undefined in a patch is skipped (prior value kept).
- Second init() replaces sampling config (prior rate/keep does not leak).
- Second init() replaces redact setting (e.g. redact:false then default re-enables redaction).
- getConfig() throws before init(); returns active config after init().
- Second init() replaces enrichers (prior enricher pipeline does not leak).
- Async sink rejection is isolated — later sync sinks still receive the record (no unhandledRejection).
- Multiple sampling keep rules are OR'd (any match keeps; rate 0 still honors keep).
- Nested runWithLogger restores the outer logger after the inner scope exits.
- Enricher non-object returns (null/string/array) are ignored — later enrichers and sinks still run.
- Enricher errors are isolated — later enrichers and sinks still run when earlier enrichers throw (incl. two consecutive failures).
- Multi-sink: one emit delivers the same record to all registered sinks (incl. 3+).
- Sink errors are isolated — later sinks still receive the record when earlier sinks throw.
- Sampling rate 1 always samples (even when keep rules would not match).
- JSON file sink appends JSONL lines (does not overwrite on sequential writes).
- Console sink logs once per write.
- Sampling rate 0 with no/empty keep drops all.
- success-from-status: only exact "ok" is true (e.g. "OK" → false).
- OTLP: log record body.stringValue is JSON.stringify(record).
- OTLP: successful export uses HTTP POST.
- OTLP: unset `OTEL_EXPORTER_OTLP_HEADERS` → default content-type only (options or env endpoint).
- OTLP: empty-string `OTEL_EXPORTER_OTLP_HEADERS` adds no headers (default content-type only).
- success-from-status: explicit `success: true` wins over status 500.
- OTLP: whitespace-only / empty header segments add no headers.
- `requestMetadata`: empty-string optional fields treated as unset; empty `requestId` does not overwrite existing `request_id`.
- createRequestId() returns req_<time36>_<rand36> and is unique per call.
- createRequestLogger({ requestId }) preserves the provided request_id.
- `requestMetadata`: status 0 is kept on `http.status`.
- OTLP: header env parsing trims keys/values.
- success-from-status: status 199 → false (boundary below 200).
- success-from-status: numeric string `"199"` → false.
- success-from-status: numeric string `"399"` → true.
- success-from-status: numeric string `"400"` → false.
- success-from-status defaults to true when status and success are unset.
- JSON sink: whitespace-only `AMPLIO_JSON_SINK_PATH` treated as unset (same as empty).
- OTLP: log attributes omit null/undefined/object values for known fields.
- JSON sink: empty/whitespace `AMPLIO_JSON_SINK_PATH` treated as unset (default `amplio.jsonl`).
- OTLP: options.headers override env headers; empty header keys skipped; typed attributes (int/bool/double).
- OTLP header parsing skips malformed comma segments without `=`.
- OTLP: trailing comma / empty header segments ignored.
- OTLP: leading comma / empty header segments ignored (same as trailing).
- OTLP: double-comma / empty middle header segments ignored.
- OTLP: headers that are only commas / empty segments add no headers (default content-type only).
- Service-metadata enricher treats empty AMPLIO_SERVICE/VERSION/REGION env vars as unset (fall back / omit).
- JSON file sink defaults to `amplio.jsonl` in the current working directory when `path` and `AMPLIO_JSON_SINK_PATH` are unset.
- `requestMetadata` maps `userAgent` → `http.user_agent` (omitted when unset).
- Service-metadata enricher omits unset version/region env keys (no undefined fields).
- KeepRule `gte` + `lte` on the same rule form an inclusive AND range.
- OTLP sink sets resource `deployment.environment` when `record.env` is a non-empty string.
- OTLP sink sets resource `service.name` when `record.service` is a non-empty string.
- JSON file sink creates missing parent directories before append.
- OTLP sink leaves endpoints that already end with `/v1/logs` unchanged (no double path).
- KeepRule supports optional `lte` (number ≤ threshold).
- OTLP sink `throwOnError: false` also swallows HTTP non-OK responses (not only network errors).
- OTLP sink sets timeUnixNano from record.timestamp when parseable (ISO/date or ms), else Date.now().
- `amplio list` shows human titles when present.
- Registry items include human-readable descriptions (used by `list` / index).
- `public/r/registry.json` index items include `title` and `description` (not only `name`/`type`).
- Whitespace-only `--service` / `--package-manager` on non-init commands are ignored.
- CLI commands are trimmed (e.g. padded `list` still works).
- Whitespace-only `add` names are treated as missing (trimmed).
- `--force` is only valid with `add` (rejected on init/list/etc.).
- `--service`, `--package-manager`, and `--no-typescript` are only valid with `init` (rejected elsewhere).
- `--service` is trimmed (whitespace-only → `my-app`).
- `--package-manager` is trimmed and case-insensitive (whitespace-only → default).
- Hosted shadcn registry URL is still TODO (local `public/r/` and bundled CLI registry work today).
- Scoped packages (`@useamplio/amplio`, `@useamplio/cli`) set `publishConfig.access=public` for npm publish.
- CLI registry copy (`packages/cli/scripts/copy-registry.mjs`) uses a file lock to avoid concurrent build races.
- Local full check: `pnpm run ci` (not `pnpm ci` — that is pnpm's install builtin).
- GitHub Actions CI runs `pnpm run ci` as a single step (same bundle as local).
- `amplio init --no-typescript` works (CLI `parseArgs` uses `allowNegative`) and writes `typescript: false`.
- `amplio init --package-manager` rejects unknown values (pnpm|npm|yarn|bun only).
- `@useamplio/amplio` `peerDependencies.zod` is `"^3.0.0 || ^4.0.0"` (tested).
- Invalid event names are rejected (leading/trailing dots, uppercase, single segment, double dots).
- `amplio add` works without prior `init` for event/middleware/sink/enricher/integration.
- `amplio init --cwd` creates missing directories (`mkdir -p`).
- Root package is private MIT (`LICENSE` + `package.json` `license`).
- `amplio add --cwd` creates missing directories (same `mkdir -p` as `init`).
- `--cwd` paths are trimmed.
- Unknown CLI options print a short `error:` line and exit 1 (no Node stack dump).
- Missing CLI option values print a short `error:` line and exit 1 (no Node stack dump).
- `amplio add <kind>` without a name prints a kind-specific missing-name error (vs bare `add` missing-target).
- Whitespace around `list` kinds is ignored (kinds are trimmed).
- Registry titles put the kind last (e.g. Console Sink, Hono Middleware), with JSON/OTLP/Next.js polish.
- sampling: {} (no rate) defaults to always sample (rate 1).
- README: try from local tarballs without npm publish.
- CONTRIBUTING: try from local tarballs (see README).
- Sampling with keep but no rate defaults rate to 1 (always sample).

## [0.1.0] - 2026-08-07

Initial publish-ready snapshot of the amplio monorepo.

### Added

- **`@useamplio/amplio`** — schema-first wide-event runtime: `defineEvent`, `init`, `logger.event` / `logger.create`, `useLogger`, sampling, and redaction. Packaged as ESM with a frozen public API and optional Zod peer dependency.
- **`@useamplio/cli`** — `amplio init`, `amplio add`, and `amplio list` for scaffolding typed telemetry into `telemetry/`. Bundles the registry at build time (`registry/` copied into the published package).
- **Registry** — shadcn-compatible items (events, middleware, sinks, enrichers, integrations) declared in `registry/registry.manifest.json` and built to `public/r/*.json`.
- **Examples** — runnable smoke apps for Hono, Express, Fastify, Next.js, and a standalone script under `examples/`.
