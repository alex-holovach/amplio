# next-smoke

Minimal Next.js App Router route handler using the registry `next` middleware pattern with `@logcn/core`.

From monorepo root: `pnpm install && pnpm build && pnpm --filter @logcn/example-next-smoke dev` — http://127.0.0.1:3003

`curl http://127.0.0.1:3003/api/health` — one wide event emits when the handler returns.

## Smoke

```bash
pnpm --filter @logcn/example-next-smoke smoke
```

Starts `next dev` on an ephemeral port, hits `/api/health`, asserts one JSON wide event with nested `http`.

