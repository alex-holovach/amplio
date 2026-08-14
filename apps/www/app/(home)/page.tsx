import Link from "next/link";
import { appName } from "@/lib/shared";

export default function HomePage() {
  return (
    <div className="mx-auto flex max-w-2xl flex-1 flex-col items-center justify-center px-6 py-16 text-center">
      <p className="mb-3 text-sm font-medium tracking-wide text-fd-muted-foreground uppercase">
        {appName} — shadcn for observability
      </p>
      <h1 className="mb-4 text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
        Your code has semantics. Not a logger.
      </h1>
      <p className="mb-10 max-w-lg text-lg text-fd-muted-foreground text-balance">
        Compose open-code Plugins into one typed Event tree. Application code
        keeps calling ordinary functions; source in{" "}
        <code className="text-sm">telemetry/</code> owns semantics and
        lifecycle.
      </p>
      <div className="mb-10 flex flex-wrap items-center justify-center gap-3">
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
          npx @useamplio/cli@alpha init
        </a>
      </div>
      <pre className="w-full max-w-xl overflow-x-auto rounded-lg border border-fd-border bg-fd-card p-4 text-left font-mono text-sm leading-relaxed text-fd-card-foreground">
        {`// application code stays ordinary
const user = await signUp(input);
return Response.json(user, { status: 201 });

// native seams activate open-code Plugins once
const app = new Hono();
app.use("*", HonoPlugin());

export const resend = ResendPlugin(
  new Resend(process.env.RESEND_API_KEY),
);`}
      </pre>
    </div>
  );
}
