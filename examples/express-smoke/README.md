# express-smoke

Minimal Express app using the registry `express` middleware pattern with `@useamplio/amplio`.

## Run

From the monorepo root:

```bash
pnpm install
pnpm build
pnpm --filter @useamplio/example-express-smoke dev
```

Try it:

```bash
curl http://127.0.0.1:3001/health
```

`GET /health` sets route context; one wide event emits when the response finishes.

## Smoke

```bash
pnpm --filter @useamplio/example-express-smoke smoke
```

Starts the app, hits `GET /health`, asserts one JSON wide event with nested `http` and status 200.

