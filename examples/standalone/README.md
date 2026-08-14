# standalone

Reference for scripts and workers: one root Event owned by a worker Plugin, with ordinary
application calls.

## Run

```bash
pnpm install
pnpm build
pnpm --filter @useamplio/example-standalone dev
```

## Smoke

```bash
pnpm --filter @useamplio/example-standalone smoke
```

Asserts one `worker.billing.reconcile` Event containing stable worker, job, and result fields.
