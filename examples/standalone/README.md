# standalone

Reference for scripts and workers: `logger.create()` + schema-bound `logger.event()` — no HTTP middleware.

## Run

```bash
pnpm install
pnpm build
pnpm --filter @logcn/example-standalone dev
```

## Smoke

```bash
pnpm --filter @logcn/example-standalone smoke
```

Asserts one `logger.create()` wide event and one `job.completed` schema event.
