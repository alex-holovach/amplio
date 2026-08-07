# REQUIREMENTS.md — logcn

Product requirements for **logcn**: schema-first wide-event telemetry with shadcn-style open code.

## Problem

Teams want **structured, queryable observability** without:

- Scattered `console.log` / `logger.info` lines that agents and humans must grep
- Black-box logging libraries whose behavior cannot be reviewed in PRs
- Untyped payloads that drift (`userId` vs `user_id` vs `account.id`)
- Heavy platforms that own the schema away from the application repo

**evlog** popularized wide events (one rich event per unit of work) but keeps schemas optional via module augmentation and ships primarily as an npm runtime.

**logcn** targets teams that want **evlog's mental model** with **shadcn's ownership model**: typed event definitions live in the repo, install as files, and diff like normal code.

## Goals

1. **Schema-first events** — important domain events are declared before use.
2. **Wide events** — accumulate context, emit once per request/job/run.
3. **Open code** — `telemetry/` is part of the application, not hidden in `node_modules`.
4. **Tiny runtime** — `@logcn/core` stays small, dependency-light, and immutable in API shape.
5. **shadcn-native DX** — `npx logcn add …` and `npx shadcn add @logcn/…` scaffold registry items.
6. **Agent-friendly output** — nested JSON, stable field names, self-describing event names.

## Non-goals (v0)

- Log aggregation hosting or a SaaS control plane
- Replacing metrics/tracing vendors (integrate via sinks)
- Free-form printf logging as a first-class feature
- Visual dashboard or query UI
- Supporting every framework in v0 (examples cover Hono, Express, Fastify, Next.js, standalone; expand further via registry)

## Users

| Persona | Need |
|---|---|
| Application developer | Add typed events and middleware without learning a large API |
| Platform / infra engineer | Audit sinks, redaction, and enrichers in repo |
| AI coding agent | Parse one wide JSON event per unit of work with stable schemas |
| OSS contributor | Extend registry items (events, integrations) with clear conventions |

## Core concepts

### Wide event

A single JSON object representing one unit of work (HTTP request, background job, CLI invocation). Context is merged over time via `.set()` and finalized with `.emit()`.

### Event schema

A named, typed definition (`domain.entity.action`) created with `defineEvent`. Schemas validate at emit time (and optionally on set, per spec).

### Logger scope

- **Request-scoped** — middleware creates the logger; handlers call `useLogger()`.
- **Standalone** — caller uses `logger.create()` for scripts and workers.

### Registry item

A shadcn-compatible installable unit that copies or merges files into `telemetry/`.

## Functional requirements

### FR-1 Init

`npx logcn init` scaffolds:

```
telemetry/
  events/
  sinks/
  enrichers/
  integrations/
  logger.ts
```

- Creates config (`components.json` or logcn-specific manifest) pointing registry namespace `@logcn`.
- Writes a minimal `telemetry/logger.ts` that calls `init()` with default console sink.
- Does not create `middleware/` until an middleware item is added.

### FR-2 Define events

- Developers (or CLI) define events with `defineEvent({ name, schema })`.
- Event names MUST match `domain.entity.action` (lowercase segments, underscores allowed in action segment).
- Each event gets a kebab-case file under `telemetry/events/`.
- Exported PascalCase type for payload shape.

### FR-3 CLI add

```bash
npx logcn add event auth.user.signed_up
npx logcn add middleware hono
npx logcn add sink axiom
npx logcn add enricher request-metadata
npx logcn add integration better-auth
```

- Resolves registry item, writes files, installs declared peer dependencies.
- Prints next steps (import paths, middleware wiring).
- Safe to re-run (no clobbering user edits without confirmation).

### FR-4 shadcn registry

- Registry builds from `registry/` via `pnpm registry:build`.
- Items addressable as `@logcn/event-auth-user-signed-up`, `@logcn/middleware-hono`, etc.
- Compatible with `npx shadcn@latest add @logcn/…`.

### FR-5 Wide-event lifecycle

- `.set(partial)` deep-merges nested objects (see SPEC for merge rules).
- `.emit()` validates against schema when bound to `defineEvent`, drains to configured sinks, seals instance.
- Post-emit mutations are ignored with a dev-only warning.

### FR-6 Framework middleware

- Middleware creates request-scoped logger and auto-emits on response finish (or error).
- `useLogger()` returns the same instance within the request async context.

### FR-7 Sinks

- Sinks are plain functions/modules in `telemetry/sinks/` registered through `init()`.
- At least one reference sink: structured JSON to stdout.

### FR-8 Enrichers

- Enrichers derive context (service name, env, trace ids) and run before drain.
- Live in `telemetry/enrichers/`; registered in `init()`.

### FR-9 Integrations

- Integrations connect third-party libraries (e.g. Better Auth) by calling `.set()` with documented nested shapes.
- Ship as registry items under `telemetry/integrations/`.

## Public API requirements

The **only** exported runtime API from `@logcn/core`:

- `defineEvent`
- `init`
- `logger.event`
- `logger.create`
- `useLogger`
- `.set()`
- `.emit()`

No `info` / `warn` / `debug` methods on the public logger.

## Quality requirements

### QR-1 Bundle size

`@logcn/core` gzipped size budget: **≤ 8 KB** (benchmark enforced in CI).

### QR-2 Performance

Hot path (`set` + `emit` without validation) should stay suitable for per-request use; benchmarks live in `benchmarks/`.

### QR-3 Type safety

Inferred payload types from `defineEvent` flow through `.set()` and `.emit()`.

### QR-4 Generated code quality

- Prettier-compatible formatting
- Explicit imports, no barrel re-export magic in generated files
- Comments only where wiring is non-obvious

### QR-5 Anti-slop

- Primary observability path is schema-bound wide events, not string logs.
- Encourage nested objects in schemas and CLI prompts.
- Event names are stable identifiers suitable for dashboards and agent tools.

## Differentiation from evlog

| Dimension | evlog | logcn |
|---|---|---|
| Code location | npm package runtime | `telemetry/` open code in user repo |
| Typing | Optional module augmentation | Schema-first `defineEvent` in repo |
| Install model | dependency + docs | CLI + shadcn registry scaffolds |
| Customization | hooks/adapters | edit sinks, enrichers, events directly |
| API surface | wider (levels, helpers) | minimal: set/emit + schemas |

logcn may interoperate with evlog-shaped **ideas** (wide events, structured errors) but must not copy evlog's API verbatim.

## Documentation requirements

- Root `README.md` — quickstart (exists).
- `AGENTS.md` — contributor/agent instructions.
- `REQUIREMENTS.md` — this file.
- `SPEC.md` — technical specification + acceptance criteria.
- Each example app README with run instructions.

## Success metrics

1. `npx logcn init && npx logcn add event …` produces a compiling TypeScript tree in under 30 seconds.
2. A new contributor can add an event schema and see it in emitted JSON without reading core source.
3. `@logcn/core` passes size and bench gates.
4. One example emits exactly one wide event per HTTP request in middleware mode.

## Open questions

- Standard Schema only vs hard Zod dependency in generated events (spec recommends Standard Schema with Zod in templates).
- Whether `.set()` validates incrementally or only at `.emit()` (spec: emit-time required, incremental optional).
- Head sampling in v0 vs v1.

Resolve open questions in `SPEC.md` before implementation diverges.
