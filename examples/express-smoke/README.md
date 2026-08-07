# express-smoke

Minimal Express app using the registry `express` middleware pattern with `@logcn/core`.

## Run

From the monorepo root:

```bash
pnpm install
pnpm build
pnpm --filter @logcn/example-express-smoke dev
```

Try it:

```bash
curl http://127.0.0.1:3001/health
```

`GET /health` sets route context; one wide event emits when the response finishes.

## Smoke

```bash
pnpm --filter @logcn/example-express-smoke smoke
```

Starts the app, hits `GET /health`, asserts one JSON wide event with nested `http` and status 200.

