import Link from 'next/link';
import { appName } from '@/lib/shared';

export default function HomePage() {
  return (
    <div className="mx-auto flex max-w-2xl flex-1 flex-col items-center justify-center px-6 py-16 text-center">
      <p className="mb-3 text-sm font-medium tracking-wide text-fd-muted-foreground uppercase">
        {appName}
      </p>
      <h1 className="mb-4 text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
        Schema-first telemetry you own
      </h1>
      <p className="mb-10 max-w-lg text-lg text-fd-muted-foreground text-balance">
        Define typed wide events, accumulate context with <code className="text-sm">.set()</code>,
        emit once with <code className="text-sm">.emit()</code> — open code in{' '}
        <code className="text-sm">telemetry/</code>, not a black-box npm logger.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Link
          href="/docs"
          className="inline-flex h-10 items-center rounded-lg bg-fd-primary px-5 text-sm font-medium text-fd-primary-foreground transition-opacity hover:opacity-90"
        >
          Read the docs
        </Link>
        <a
          href="https://www.npmjs.com/package/@useamplio/cli"
          className="inline-flex h-10 items-center rounded-lg border border-fd-border bg-fd-background px-5 font-mono text-sm transition-colors hover:bg-fd-accent"
        >
          npx @useamplio/cli@alpha init --yes
        </a>
      </div>
    </div>
  );
}
