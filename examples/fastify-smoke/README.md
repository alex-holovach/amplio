# fastify-smoke

Minimal Fastify app using the registry `fastify` middleware pattern with `@amplio/core`.

## Run

From the monorepo root:

```bash
pnpm install
pnpm build
pnpm --filter @amplio/example-fastify-smoke dev
```

Try it:

```bash
curl http://127.0.0.1:3002/health
```

`GET /health` sets route context; one wide event emits when the response finishes.

## Smoke

```bash
pnpm --filter @amplio/example-fastify-smoke smoke
```

Starts the app, hits `GET /health`, asserts one JSON wide event with nested `http` and status 200.
