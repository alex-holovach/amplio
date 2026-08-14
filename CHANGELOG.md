# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0-alpha.17] - 2026-08-14

### Breaking: Event and Plugin vNext

- The public semantic model is now two concepts: an `Event` declares a versioned schema and nested
  Event tree; a `Plugin` observes a native library seam and contributes Events to that tree.
- Application code no longer receives, retrieves, or passes a logger. Duration root Events wrap
  ordinary functions with `.handle()`, while installed Plugins preserve the provider's native
  interface and record through their scoped `record`, `observe`, and `begin` tools.
- A completed root Event delivers one immutable record containing its nested Event occurrences,
  duration, outcome, and bounded runtime diagnostics. Cardinality, depth, key, string, occurrence,
  record-size, and pending-delivery limits prevent unbounded telemetry growth without changing
  application behavior.
- Error capture is privacy-safe by construction: generic errors expose only approved types, and
  explicit cancellation reason codes remain available for lifecycle boundaries. Sink failures and
  diagnostics never print arbitrary thrown values.
- `init()` is operational setup only. It configures sinks, resource enrichers, sampling, redaction,
  delivery, and limits, but exports no logger. Active Events retain their initialization generation
  through asynchronous completion and flush.
- The mutable alpha builder API is quarantined at `@useamplio/amplio/legacy`; it is absent from the
  main, Plugin, and testing declaration graphs. `@useamplio/amplio/plugin` contains Plugin-author
  tools, and `@useamplio/amplio/testing` provides schema-aware Event assertions and diagnostics.

### Open-code Plugins and CLI

- `amplio init --yes` creates `telemetry/runtime.ts`, `telemetry/events/http-request.ts`, a console
  sink, and the supported detected boundary Plugin. `amplio add event` creates project-owned Events;
  `amplio add plugin <name> --event <id>` copies and composes editable Plugin source.
- Registry Plugins cover Hono, Express, Fastify, Next.js route handlers, tRPC, Better Auth, Resend,
  and AI SDK 7. Framework boundaries own the root Event lifecycle; contributor Plugins mount under
  an explicit branch and use native hooks, middleware, constructors, clients, or the AI SDK's
  registered telemetry lifecycle plus its exact-result `streamText` wrapper.
- Provider packages are not dependencies of the core library. Registry manifests declare compatible
  host-owned provider ranges, Plugin wiring actions, Event placement, and minimum/current tested
  versions. The CLI shows the complete dependency and wiring plan, requires approval before a
  missing host dependency is installed, and fails before tracked writes when a native seam or
  dependency is ambiguous or incompatible.
- `amplio diff plugin`, `amplio update plugin`, and `amplio remove plugin` use content-addressed
  recipe bases plus reversible wiring snapshots. Updates preserve non-overlapping customer edits and
  fail closed for semantic, privacy, native-wiring, or merge conflicts; removal retains host-owned
  provider dependencies.
- Registry CI executes every Plugin against the minimum and latest supported provider release and
  rejects the declared upper/prerelease boundary. The compatibility fixtures exercise native
  lifecycles, concurrency, privacy, and provider-specific TypeScript resolution.
- AI SDK `ai.operation` v2 adds normalized provider/model categories, bounded generation settings,
  usage, aggregate lifecycle counts, and performance timings while continuing to exclude prompts,
  generated content, tool payloads, embeddings, raw identifiers, metadata, and raw errors.
- Generated code and examples use only `telemetry/events`, `telemetry/plugins`,
  `telemetry/sinks`, and `telemetry/runtime.ts`; the discarded component, integration, middleware,
  workload, and logger vocabulary is not part of the vNext interface.

### Alpha automation limits

- Active boundary wiring is automated for one unambiguous Hono or Fastify composition root.
  Express and Next.js boundary recipes are copied with `--source-only`, attached explicitly, then
  promoted with `--target <relative-source-file>` after exact native-shape verification. The CLI
  records this wiring as customer-owned, strict doctor re-verifies it, and removal never rewrites it.
- `--target` narrows constructor, Better Auth, tRPC, Hono, Fastify, Next.js, and Express discovery to
  one contained source file. Absolute, traversing, missing, non-source, and escaping targets fail
  before writes. Multiple supported seams inside that file still fail closed, and an active Plugin
  cannot be silently retargeted.
- `update plugin` fails closed when a recipe changes Event identity/version, privacy, placement,
  provider instrumenter, or native wiring. Those contract migrations require an explicit Event
  version decision and remove/reinstall workflow rather than an automatic rewrite.

## [0.1.0-alpha.15] - 2026-08-09

Dogfood iter 10 — build-phase tagging, RSC render correlation (`withAmplioRender`), `amplio smoke`, integration wiring output, alias imports by default, env-split JSONL, `.time()` sugar.

### Runtime

- **Build-time emission is tagged, not silent** — `next build` static generation executes RSC pages, so emits fired from CI with `env: "production"` and nothing said so. Records emitted during `NEXT_PHASE=phase-production-build` now carry `build_phase: true`; dashboards filter with `build_phase != true` without hiding real SSG behavior.
- **`AMPLIO_DISABLED=1` escape hatch** — drops every `.emit()` before sinks run (CI builds, one-off scripts). Documented in the README behavior contract.
- **`.time(EventDef, fn)` sugar** — creates the `.child()` before `fn` runs and emits after it settles, so `duration_ms` measures the work; a throw records the error (`success: false`, no `status`) and rethrows. The timed path is now the easy path instead of a documented footgun. No-op loggers still run `fn` and pass the result through.
- **Facade semantics documented** — `logger.event(Def)` starts a fresh row per call (`duration_ms` measures from that call; ambient `request_id` copied inside request scope), vs instance `.event(Def)` binding the same row. One method name, two receivers — now stated in the README instead of left to empirical testing.

### Registry

- **`withAmplioRender(name, fn)`** (middleware/next) — closes the RSC correlation gap: wraps a server-component page in an ambient `page.render` spine so server-caller tRPC calls annotate it (instead of emitting standalone uncorrelated `trpc.request` spines) and facade events share its `request_id`. `redirect()`/`notFound()` digests are recorded as `page.interrupted`, not errors.
- **JSON sink splits files per env** — default file name is now `amplio.<env>.jsonl` (from the record's `env`; `amplio.dev.jsonl` fallback), so dev rows and build/production rows never interleave in one file. Explicit `options.path` / `AMPLIO_JSON_SINK_PATH` behavior unchanged.
- **`page.viewed` allows anonymous visitors** — `visitor.id` is now optional inside the optional `visitor` object, so `visitor: { authenticated: false }` validates.

### CLI

- **New `amplio smoke <url>`** — closes the verification loop the init epilogue walks manually: makes the request, watches `amplio*.jsonl` for the emitted row, reports PASS/FAIL with a diagnosis (wrong-port trap, unwired route, init never ran, AMPLIO_DISABLED). Requires the JSON sink and says so; `--timeout <seconds>` adjusts the wait.
- **`add integration` prints wiring steps** — every integration now ends with its manual steps (next-auth: wrap the `[...nextauth]` route + `events: amplioNextAuthEvents()`, with the t3.md pointer; better-auth: plugin registration; clerk/resend/polar: webhook handler calls), plus a heads-up when the integration's target package is absent from `package.json` (phrased per integration: structural-types files stay tsc-green, package-importing files won't).
- **`init --yes` applies the `~telemetry/*` alias by default** — wired imports read `~telemetry/middleware/next` instead of a 5-deep `../` chain (tsconfig present required; `--no-paths` opts out, explicit `--paths` still forces it). Fixed `amplio paths` failing on a tsconfig whose `compilerOptions` (or `paths`) object was empty — the inserted entry no longer leaves a trailing comma.
- **`doctor` re-checks the app-side wiring init created** — on T3 layouts it warns when `route.ts` no longer references `withAmplio`, `trpc.ts` no longer uses `amplioTrpcMiddleware`, or the NextAuth route lost its wrap (checked when the next-auth integration is installed) — the edits most likely to be lost in a merge or T3 upgrade, invisible to the generic "export never referenced" check when the export survives elsewhere.
- **`.gitignore` entry widened to `amplio*.jsonl`** — `add sink json` writes the glob and upgrades a legacy exact `amplio.jsonl` entry in place; doctor validates the glob and explains the env-aware file name when only the legacy entry is present.

### Docs

- **t3.md added:** "Correlating a page render" section (`withAmplioRender`, plus the honest default: RSC rows do not correlate), "Build-time emission" section (`build_phase` tag + `AMPLIO_DISABLED`), facade per-call semantics on repeat renders, the Drizzle `.returning()` pattern for T3's void-returning `post.create` scaffold, `.time()` recipe, `amplio smoke` in the verify flow, and env-split JSONL naming.
- **README (runtime):** `.time()` in the API/entry-point tables and recipes, facade-vs-instance `.event()` distinction, build-phase/AMPLIO_DISABLED behavior bullets.

## [0.1.0-alpha.14] - 2026-08-09

Dogfood iter 9 — form-encoded redaction gap closed, OTLP spec-compliant endpoints + batching + attribute promotion, `add --dry-run`, NextAuth createUser, memorySink, four new registry events.

### Runtime

- **`+`-encoded secrets no longer survive redaction** — `NextRequest.nextUrl.search` form-encodes spaces as `+`, and `decodeURIComponent` does not turn `+` back into a space, so `Bearer+abc123…` (and `4111+1111+1111+1111`) slipped past the value patterns. The Bearer pattern now accepts `+` separators directly, the pattern-scan gate counts digit runs through `+`, and a form-decode pass (`+` → space) runs alongside the percent-decode pass.
- **Encoding caveat documented** — when a pattern only matches after decoding, the stored value comes out decoded; the README redaction contract now says so explicitly instead of leaving consumers to discover the shape change.
- **New `memorySink()`** — in-memory sink for tests (`sink.records`, `sink.clear()`); pairs with `resetConfigForTests()` and the NODE_ENV=test hard-throw validation for event assertions in vitest.

### Registry

- **OTLP sink honors `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`** per the OTel spec (signal-specific endpoint used verbatim and wins; base `OTEL_EXPORTER_OTLP_ENDPOINT` gets `/v1/logs` appended). Previously docs told users to set the signal var and the sink never read it. The disabled-export warning now names both vars and carries the `[amplio]` prefix like every other runtime message.
- **OTLP sink batching (opt-in)** — `otlpSink({ batch: true })` coalesces 100 records / 1 s (tunable via `{ maxSize, maxWaitMs }`) into one export request, grouped by (service, env) resource; per-emit POST remains the default and the header comment now states that limitation prominently.
- **OTLP attribute promotion is configurable** — defaults now include `trpc.path`, `http.path`, `http.method` (dot paths walk nested fields), and `otlpSink({ attributes: […] })` replaces the list.
- **NextAuth integration covers `createUser`** — the adapter event marks the id so the subsequent `signIn` emits `auth.user.signed_up` exactly once with the account-derived method, fixing signup detection for database-session credential flows where `isNewUser` is unreliable. `signOut` / `linkAccount` ship as commented recipes in the file.
- **Four new registry events** — `page.viewed`, `job.completed`, `webhook.received`, `payment.refunded`, so the registry demonstrates richer shapes beyond the auth/email/payment starter set.

### CLI

- **`amplio add … --dry-run`** — previews created/overwritten/skipped files, barrel wiring, `logger.ts` edits, and dependency additions without writing anything (for a tool that edits logger.ts, tsconfig.json, and app source, trust needs a preview mode).
- **Skip glyph explains itself** — `· path (exists — --force to overwrite)` instead of a bare `·`.
- **`add integration next-auth` no longer prints duplicate barrel lines** — barrel updates are reported once per file per install, not once per pulled-in event.
- **`doctor` prints a bottom-line summary** — `⚠ N warning(s) …` / `✗ N check(s) failed …` after the epilogue so warnings are not skimmed past.
- **`init` (Next.js) warns about `http.search`** — the epilogue now surfaces the query-string PII trap and the `add enricher query-allowlist` fix, the same way it surfaces the port trap.
- **Generated `logger.ts` carries a "which entry point?" comment** — the 3-line version of the README table, in the file everyone opens first.

### Docs

- **t3.md fixed:** the sampling section claimed `.emit()` returns the record when sampling skips delivery — it returns `null` (README/ALPHA/implementation agree); the `src/env.js` example's `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` is now actually honored by the sink and annotated with the verbatim-URL semantics.
- **t3.md added:** "Annotate the spine with the authenticated user" recipe (one `.set()` in `protectedProcedure` makes every request row user-scoped), a vitest testing recipe built on `memorySink()`, and the `components.json` merge behavior for apps that already have one (registries map merged, everything else untouched).
- **README added:** `success` dashboard note (`success != false` for domain rows), the `.error()` sets-success-not-status asymmetry, and the decoded-form redaction caveat.

## [0.1.0-alpha.13] - 2026-08-09

Dogfood iter 8 — PAN redaction fix, honest async-sink warning, `.event()` footgun removed, NextAuth wired end-to-end, quieter init.

### Runtime

- **Spaced/dashed credit cards are redacted** — `"4111 1111 1111 1111"` and `"4111-1111-1111-1111"` now match the PAN pattern (previously only unseparated runs did, while real card data is very often grouped). Candidates are verified with a **Luhn check + brand prefix** so ordinary long numbers (ids, timestamps) no longer false-positive. Field names `card`, `card_number`, `credit_card`, `pan` joined the sensitive-name list.
- **`[amplio] async sinks may be cut off…` warning is now honest** — it fires only when async sink deliveries are actually pending (all-sync setups like console + JSONL never see it), the warn-once flag and the cached `next/server` `after()` live on the shared `globalThis` state (Turbopack module graphs no longer each warn), and when the `after()` probe hasn't resolved yet the decision is deferred until it does instead of warning on the first request.
- **`.event()` on an already-named spine behaves as `.child()`** — a separate correlated row with the spine preserved, plus a dev notice suggesting the explicit `.child()` spelling. Previously it rebound and sealed the spine, silently losing the request row (the documented "one wrong spelling to avoid" — now removed rather than warned about). Same-name `.event()` (binding a schema to a spine you own) is unchanged.

### CLI

- **`init` captures package-manager install output** — one summary line (`✓ installed @useamplio/amplio, zod (pnpm, 1.2s)`) instead of raw pnpm progress and deprecated-subdependency warnings interleaved with amplio's checklist; `--verbose` streams the raw log, and failures always dump it.
- **`init --yes` / `--wire` wraps `src/app/api/auth/[...nextauth]/route.ts`** with `withAmplio` in a stock create-t3-app layout — NextAuth `events` callbacks run inside that route, and without the wrap every `getLogger().child(...)` in them silently no-ops in production.
- **`init` suggests matching integrations** — when package.json contains next-auth / better-auth / `@clerk/*` / resend / `@polar-sh/*` and the integration file isn't installed, init prints the `amplio add integration <id>` command.
- **New `amplio paths` subcommand** — writes the `~telemetry/*` tsconfig alias and nothing else (`init --paths` re-ran the whole idempotent init flow just to add an alias).
- **`doctor --fix` coalesces barrels** — repeated `export { X } from "./m";` lines for the same module merge into one statement; `add event` now appends into the existing statement instead of accumulating one line per event.
- **Fresh scaffolds no longer ship the deprecated `useRequestLogger` alias** — it existed for upgraders and nobody has imported it from a brand-new file.

### Registry

- **New `integration-next-auth`** — a NextAuth v5 `events` hook (`events: amplioNextAuthEvents()`) emitting `auth.user.signed_in` (+ `auth.user.signed_up` on `isNewUser`), using local message types so it never imports next-auth's beta type exports. Closes the loop for T3's default auth story: init detects next-auth, scaffolds the auth event, wires the route — and now answers "where do I emit this?".
- **Every registry item carries a `docs` post-install hint** (middleware, sinks, enrichers, integrations — not just events), printed as the last line of a shadcn install.
- **tRPC middleware: honest batch attribution** — on batched requests `trpc.path` / `trpc.type` are `null` (the full list stays in `trpc.procedures`), and a failing procedure lands in `trpc.failed_path` / `trpc.failed_type` instead of overwriting `trpc.path`, so group-bys on `trpc.path` never mix "the request was for X" with "X happened to be first in a batch".
- **Hosted registry is browsable** — `/r/` serves a human-readable item index, and the 404 page explains that starters generated by `amplio add event` exist only in your repo (they are not hosted items).

### Docs

- **"Spine" is defined at the top of the runtime README** with a two-row example (spine + domain row sharing `request_id`).
- **Redaction contract is precise** — README lists the exact default field names, the five value patterns with their shapes, and their limits (Luhn + brand prefix on cards, `eyJ`-prefix on JWTs, no query-string parsing).
- **`hasAmbientLogger()` and `createRequestId()`** added to the README API table (generated middleware imports both).
- **`.child()` vs `.create()` vs `.event()` decision table** in the README.
- **t3.md** gained: a NextAuth section (route wrap + integration wiring), a worked `src/env.js` example for sink env vars (OTLP endpoint/headers), a tRPC-idiomatic client-component example (import the event definition client-side, emit in a mutation), a production sampling recipe (keep mutations/errors/domain events, sample queries), and documentation of the async-sink warning.

## [0.1.0-alpha.12] - 2026-08-09

Dogfood iter 7 — Edge-runtime instrumentation guard, webpack build-noise fix, list/add event grammar, query-allowlist enricher.

### Runtime

- **Webpack "Critical dependency" warning fixed** — the `next/server` `after()` probe's dynamic import now carries `/* webpackIgnore: true */ /* @vite-ignore */` in the published dist (re-injected after minification by `scripts/annotate-dynamic-import.mjs`), so `next build` no longer prints `Critical dependency: the request of a dependency is an expression` for every route that imports the runtime.

### CLI

- **`init` scaffolds instrumentation.ts with a `NEXT_RUNTIME` guard** — Next compiles `instrumentation.ts` for the Edge runtime too; the unguarded `await import("../telemetry/logger")` made Turbopack warn `'node:fs' is not supported in the Edge Runtime` on every compile once a sink pulled in `node:` builtins. The template now wraps the import in `if (process.env.NEXT_RUNTIME === "nodejs")`, and `doctor` warns when an existing instrumentation file lacks the guard.
- **`add event` accepts hyphenated registry ids** — `amplio add event auth-user-signed-in` (the id `list` prints) now maps to `auth.user.signed_in` via the registry template instead of erroring; `list` also prints events by dot name, so its `Add with: amplio add <kind> <id>` hint works verbatim for every kind.
- **Starter event schema namespaces by entity** — `add event ui.feedback.submitted` now generates `feedback: z.object({ … })` (second-to-last segment) instead of `ui: …`; 2-segment names keep the domain (`post.created` → `post`). The header comment flags the guess and repeats the create-the-child-before-the-work `duration_ms` idiom plus the `.child()` / `.event()` / `.create()` one-liner.
- **`init` re-runs are honest** — an existing wired `instrumentation.ts` prints `· … already wired` (instead of a wall-of-text hint), and the "No starter event scaffolded" hint is suppressed when `telemetry/events/` already contains events.
- **Epilogues use the package script** — Verify step 4 and the starter-event hint print `pnpm amplio doctor` / `npm run amplio …` (the package manager init already detected) instead of a fresh `npx @useamplio/cli@alpha` resolve; the generated `logger.ts` header does the same.
- **`doctor` prints `(exit 0 with warnings — use --strict …)`** when warnings are present without `--strict`, so a CI pipe is never silently green.

### Registry

- **New `enricher-query-allowlist`** — `amplio add enricher query-allowlist` scaffolds and auto-wires an enricher that drops `http.search` by default (or keeps only allowlisted params, redacting the rest) — the scaffolded answer to the query-string PII caveat.

### Docs

- **`NEXT_RUNTIME` guard documented** in docs/t3.md (scaffold section + Turbopack section, with the upgrade path for pre-fix scaffolds) and ALPHA.md.
- **ALPHA.md is present-tense** — Turbopack fix archaeology and pre-alpha.8 "wrong spellings" moved to this changelog; the one still-relevant footgun (`getLogger().event(Def)` rebind) stays.
- **Value-level redaction documented** — emails/JWTs/bearer tokens/card numbers are masked inside free-text string values, not just on well-known field names.
- **`amplio add` positioned as primary, shadcn as interop** (README + t3.md); t3.md notes that `AMPLIO_JSON_SINK_PATH` bypasses T3's `src/env.js` validation by design.

## [0.1.0-alpha.11] - 2026-08-09

Dogfood iter 6 — dependency hygiene, doctor reverse barrel checks, init script/output fixes, npm README.

### CLI

- **`add integration resend` / `polar` no longer add unused npm dependencies** — the generated integrations use local webhook types only; the `resend` / `@polar-sh/sdk` entries are gone from their registry items (Clerk and Better Auth keep theirs — their generated code imports the SDK).
- **`doctor` checks barrels in both directions** — a barrel `export … from "./x"` whose target file no longer exists (or no longer exports the name) is now a warning, and `doctor --fix` prunes it (deepest barrels first, so a pruned domain barrel cascades to the root barrel). Previously `rm -rf telemetry/events/email` left `doctor --fix` green while `tsc` failed with TS2307.
- **`init` installs `@useamplio/cli` as a devDependency** alongside the `"amplio": "amplio"` script, so `npm run amplio doctor` works out of the box; the printed tip now uses `npm run amplio doctor` / `npm install -D` (was the invalid `npm amplio doctor` and `npm add --save-dev`).
- **`init` output regrouped** scaffold → wire → verify → tips: `instrumentation.ts` and the package.json script print with the scaffold block, the Verify checklist prints after wiring, and hints (starter event, `~telemetry/*`) print last.
- **npm installs run with `--no-audit --no-fund`** so the inner install no longer dumps audit noise mid-checklist.
- **`init` points at the bundled T3 guide** (`node_modules/@useamplio/amplio/docs/t3.md` + GitHub URL) when it detects a create-t3-app layout.
- **`doctor` epilogue is quieter** — the "Verify an event end-to-end" block prints only after `--fix`, when something needs attention, or with the new `--verbose` flag.
- **Registry-dependency events are barrel-wired on install** — `add integration resend` now wires `email.sent` into the barrels instead of leaving a half-install for doctor to flag.
- **Starter event schema** — `id` is `z.union([z.string(), z.number()])` with a "tighten me" comment (T3+Drizzle integer PKs no longer force `String(post.id)`).
- **Barrel path style unified** — root barrels now use `./domain` (was `./domain/index`), matching the `./file` style in domain barrels; existing `./domain/index` lines are recognized and never duplicated.
- **Enricher listing cleaned up** — `request-metadata` is the one listed id; the `request` alias is still accepted silently.

### Registry templates

- **tRPC middleware emits structured validation errors** — a `TRPCError` with a ZodError cause produces `error.issues` (`[{ path, message }]`) and a short `error.message` (`input validation failed: …`) instead of a ~400-char pretty-printed JSON blob in `error.message`.
- **`useRequestLogger()` → `getRequestLogger()`** in next/hono/express/fastify middleware (it is not a React hook and never runs on the client); `useRequestLogger` remains as a deprecated alias.
- **tRPC middleware header** now says up front you don't need to read the file (mirrors create-t3-app's own trpc.ts).
- **Event registry items carry shadcn post-install docs** ("run `amplio doctor --fix` to wire barrel exports").

### Docs / distribution

- **npm package pages fixed** — publish now lands the `latest` tag directly (then adds the prerelease channel tag), which is what makes npm populate the package README; `@useamplio/amplio` also ships `README.md` explicitly in `files`.
- **`amplio.json` documented** (fields, hand-editing, CLI-only) and `--force` regeneration semantics, in README + CLI README.
- **`duration_ms` on domain events documented** (clock starts at `.child()`; create the child before the work to time the work) in README, runtime README, and t3.md.
- **components.json interaction documented** — what `init` writes when the file is absent and how a later `npx shadcn init` interacts with it; hosted-registry domain flagged as temporary with the migration story (re-run `amplio init`).
- Generated logger.ts ships the canonical sampling example (keep all errors — `success: false` _and_ `status gte 400` — sample 10% of the rest).

## [0.1.0-alpha.10] - 2026-08-09

Dogfood iter 5 — close the init → first-event gap (T3 auto-wiring), lint-clean generated code, `getLogger` rename.

### Runtime

- **`useLogger()` → `getLogger()`** — renamed; `useLogger` stays as a deprecated alias (identical behavior, one-time dev warning). The `use*` name tripped biome's `lint/correctness/useHookAtTopLevel` and eslint-plugin-react-hooks inside tRPC procedures.

### CLI

- **`init` auto-wires create-t3-app** (the headline change): under `--yes` (or with the new `--wire` flag), init wraps the handler export in `src/app/api/trpc/[trpc]/route.ts` with `withAmplio` and prepends `amplioTrpcMiddleware` to `publicProcedure`/`protectedProcedure` in `src/server/api/trpc.ts`. Shape-guarded string edits — drifted files are left untouched with manual snippets printed instead.
- **`doctor` fails (exit 1) on scaffolded-but-unwired middleware** — "no events will be emitted" is no longer a green state. New warning when a sink file exists but is not referenced in `telemetry/logger.ts` (e.g. shadcn-installed sinks).
- **Formatter pass** — init/add run the project's detected formatter (biome or prettier) over generated files, so a stock T3 app passes `biome check telemetry` right after `init --yes`.
- **Wiring snippets print resolvable paths** — `~telemetry/...` when the tsconfig alias exists, otherwise the exact relative path from the detected T3 file (no more wrong-on-paste `../../telemetry/...`).
- **`add sink` prints the lines it inserts into `logger.ts`** (`+ import …`, `+ … appended to sinks array`).
- **Multi-add** — `amplio add event a.b c.d e.f` (all add kinds accept multiple names).
- **`init` adds an `"amplio": "amplio"` script** to package.json and suggests installing the CLI as a devDependency.
- **Starter event schema** — the `context` wrapper is now optional, so `.set({ domain: { id } }).emit()` validates clean.
- **Neutral next-steps** in undetected projects (no more `add middleware hono` suggestion in empty packages); Verify section warns about Next silently binding a different port.
- **`@useamplio/cli` npm README fixed** (README.md now shipped explicitly in `files`).

### Registry templates

- **tRPC batch counting fixed** — a batch of N calls to the _same_ procedure now reports `trpc.batched: true`, new `trpc.batch_size: N`, and N `procedures` entries (was: deduplicated to a single-call spine).
- **Lint-clean under strict biome** — `withAmplio` drops `any[]` for a `never[]` rest-constraint generic, the tRPC template drops its non-null assertion, and all templates call `getLogger()`.
- **`auth.user.signed_in`** — `session.id` is now optional (NextAuth/Clerk/Better Auth fire sign-in events before a session row exists).
- **shadcn parity** — sink and Next/tRPC middleware registry items now carry `docs` post-install notes explaining wiring (`npx shadcn add @useamplio/sink-*` no longer walks away silently).

### Docs

- ALPHA.md batching section aligned with actual behavior: `trpc.path` points at the failing procedure on error, `status` is the transport status (often 207) in batches.
- `success` dashboard callout: clean domain rows omit `success`, so filter with `success != false`.
- t3.md: auto-wiring section, port-binding hint in Verify, sinks-mutate-logger.ts note, full client-originated event example (defineEvent → fetch → withAmplio route).

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
