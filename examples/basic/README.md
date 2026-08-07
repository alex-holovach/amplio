# example-basic

Minimal Hono app showing logcn wide events in an open-code `telemetry/` tree.

## What this demonstrates

- `telemetry/logger.ts` calls `init()` once and exposes `wideEvent()` for standalone emits
- `telemetry/middleware/hono.ts` creates one request-scoped wide event and auto-emits on response
- Handlers call `useRequestLogger(c)` to add context with `.set()` — no manual emit in handlers
- Schema-bound events live in `telemetry/events/` and emit via `wideEvent().event(...)`

## Run

From the monorepo root:

```bash
pnpm install
pnpm build
pnpm --filter @logcn/example-basic dev
```

Try it:

```bash
curl http://127.0.0.1:3000/health
curl -X POST http://127.0.0.1:3000/signup
```

Each request prints one JSON wide event to stdout.

## Install more registry items

```bash
pnpm registry:build
npx shadcn@latest add ./public/r/event-email-sent.json
```

Items land under `telemetry/` and stay editable like normal app code.

## Smoke

```bash
pnpm --filter @logcn/example-basic smoke
```

Starts the Hono app, hits `GET /health`, asserts one JSON wide event with nested `http` and status 200.

