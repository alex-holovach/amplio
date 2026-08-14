# amplio documentation site

Fumadocs/Next.js site for the semantic-first amplio documentation and hosted shadcn registry.

```bash
pnpm --filter @useamplio/www dev
pnpm --filter @useamplio/www types:check
pnpm --filter @useamplio/www build
```

Documentation lives in `content/docs/`. `prebuild` copies the generated registry from the repository
root into `public/r/`; edit registry sources under the root `registry/` tree and run
`pnpm registry:build` rather than hand-editing hosted JSON.
