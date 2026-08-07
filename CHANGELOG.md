# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Notes
- P1#9: Hero quick start omits email (uses `user.id` + `signup.method`); `AuthUserSignedUp` schema makes `user.email` optional in registry, CLI template, and example-basic.
- P1#9: README redaction note no longer demos `[REDACTED]` in the hero JSON; example-basic `/signup` needs no request body.
- Docs sync: AGENTS.md, SPEC.md, and packages/core/README.md match shipped API (no-op `useLogger` outside ALS, sealed no-op loggers, `.error()`/`flush()`, sync `emit()`, soft-fail validation, default redaction, `defineEvent(name, schema)`, Next middleware flush).
- P1#7: `flush()` tracks pending async sinks; Next middleware schedules flush via `after` / optional `waitUntil`; dev warns on async sink rejections.
- P1#8: `logcn init` detects framework from package.json and auto-scaffolds middleware + event (`--middleware`, `--event`, `--yes`).
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
- JSON sink: whitespace-only `LOGCN_JSON_SINK_PATH` treated as unset (same as empty).
- OTLP: log attributes omit null/undefined/object values for known fields.
- JSON sink: empty/whitespace `LOGCN_JSON_SINK_PATH` treated as unset (default `logcn.jsonl`).
- OTLP: options.headers override env headers; empty header keys skipped; typed attributes (int/bool/double).
- OTLP header parsing skips malformed comma segments without `=`.
- OTLP: trailing comma / empty header segments ignored.
- OTLP: leading comma / empty header segments ignored (same as trailing).
- OTLP: double-comma / empty middle header segments ignored.
- OTLP: headers that are only commas / empty segments add no headers (default content-type only).
- Service-metadata enricher treats empty LOGCN_SERVICE/VERSION/REGION env vars as unset (fall back / omit).
- JSON file sink defaults to `logcn.jsonl` in the current working directory when `path` and `LOGCN_JSON_SINK_PATH` are unset.
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
- `logcn list` shows human titles when present.
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
- Scoped packages (`@logcn/core`, `@logcn/cli`) set `publishConfig.access=public` for npm publish.
- CLI registry copy (`packages/cli/scripts/copy-registry.mjs`) uses a file lock to avoid concurrent build races.
- Local full check: `pnpm run ci` (not `pnpm ci` — that is pnpm's install builtin).
- GitHub Actions CI runs `pnpm run ci` as a single step (same bundle as local).
- `logcn init --no-typescript` works (CLI `parseArgs` uses `allowNegative`) and writes `typescript: false`.
- `logcn init --package-manager` rejects unknown values (pnpm|npm|yarn|bun only).
- `@logcn/core` `peerDependencies.zod` is `"^3.0.0 || ^4.0.0"` (tested).
- Invalid event names are rejected (leading/trailing dots, uppercase, single segment, double dots).
- `logcn add` works without prior `init` for event/middleware/sink/enricher/integration.
- `logcn init --cwd` creates missing directories (`mkdir -p`).
- Root package is private MIT (`LICENSE` + `package.json` `license`).
- `logcn add --cwd` creates missing directories (same `mkdir -p` as `init`).
- `--cwd` paths are trimmed.
- Unknown CLI options print a short `error:` line and exit 1 (no Node stack dump).
- Missing CLI option values print a short `error:` line and exit 1 (no Node stack dump).
- `logcn add <kind>` without a name prints a kind-specific missing-name error (vs bare `add` missing-target).
- Whitespace around `list` kinds is ignored (kinds are trimmed).
- Registry titles put the kind last (e.g. Console Sink, Hono Middleware), with JSON/OTLP/Next.js polish.
- sampling: {} (no rate) defaults to always sample (rate 1).
- README: try from local tarballs without npm publish.
- CONTRIBUTING: try from local tarballs (see README).
- Sampling with keep but no rate defaults rate to 1 (always sample).

## [0.1.0] - 2026-08-07

Initial publish-ready snapshot of the logcn monorepo.

### Added

- **`@logcn/core`** — schema-first wide-event runtime: `defineEvent`, `init`, `logger.event` / `logger.create`, `useLogger`, sampling, and redaction. Packaged as ESM with a frozen public API and optional Zod peer dependency.
- **`@logcn/cli`** — `logcn init`, `logcn add`, and `logcn list` for scaffolding typed telemetry into `telemetry/`. Bundles the registry at build time (`registry/` copied into the published package).
- **Registry** — shadcn-compatible items (events, middleware, sinks, enrichers, integrations) declared in `registry/registry.manifest.json` and built to `public/r/*.json`.
- **Examples** — runnable smoke apps for Hono, Express, Fastify, Next.js, and a standalone script under `examples/`.
