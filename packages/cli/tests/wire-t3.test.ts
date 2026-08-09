import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runInit } from "../src/commands/init.js";
import {
  T3_ROUTE_FILE,
  T3_TRPC_FILE,
  wireT3RouteHandler,
  wireT3TrpcProcedures,
} from "../src/utils/wire-t3.js";

async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

const T3_ROUTE_SOURCE = `import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { type NextRequest } from "next/server";

import { env } from "~/env";
import { appRouter } from "~/server/api/root";
import { createTRPCContext } from "~/server/api/trpc";

const createContext = async (req: NextRequest) => {
  return createTRPCContext({
    headers: req.headers,
  });
};

const handler = (req: NextRequest) =>
  fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext: () => createContext(req),
    onError:
      env.NODE_ENV === "development"
        ? ({ path, error }) => {
            console.error(\`tRPC failed on \${path ?? "<no-path>"}: \${error.message}\`);
          }
        : undefined,
  });

export { handler as GET, handler as POST };
`;

const T3_TRPC_SOURCE = `import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { ZodError } from "zod";

import { auth } from "~/server/auth";
import { db } from "~/server/db";

export const createTRPCContext = async (opts: { headers: Headers }) => {
  const session = await auth();
  return { db, session, ...opts };
};

const t = initTRPC.context<typeof createTRPCContext>().create({
  transformer: superjson,
});

export const createCallerFactory = t.createCallerFactory;

export const createTRPCRouter = t.router;

const timingMiddleware = t.middleware(async ({ next, path }) => {
  const start = Date.now();
  const result = await next();
  const end = Date.now();
  console.log(\`[TRPC] \${path} took \${end - start}ms to execute\`);
  return result;
});

/**
 * Public (unauthenticated) procedure
 *
 * This is the base piece you use to build new queries and mutations.
 */
export const publicProcedure = t.procedure.use(timingMiddleware);

/**
 * Protected (authenticated) procedure
 */
export const protectedProcedure = t.procedure
  .use(timingMiddleware)
  .use(({ ctx, next }) => {
    if (!ctx.session?.user) {
      throw new TRPCError({ code: "UNAUTHORIZED" });
    }
    return next({ ctx: { session: { ...ctx.session, user: ctx.session.user } } });
  });
`;

async function scaffoldT3Files(cwd: string): Promise<void> {
  await mkdir(path.join(cwd, path.dirname(T3_ROUTE_FILE)), { recursive: true });
  await mkdir(path.join(cwd, path.dirname(T3_TRPC_FILE)), { recursive: true });
  await writeFile(path.join(cwd, T3_ROUTE_FILE), T3_ROUTE_SOURCE);
  await writeFile(path.join(cwd, T3_TRPC_FILE), T3_TRPC_SOURCE);
}

describe("wireT3RouteHandler", () => {
  it("wraps the exported handler with withAmplio using the exact relative path", async () => {
    const cwd = await makeTempDir("amplio-wire-route-");
    await scaffoldT3Files(cwd);

    const result = await wireT3RouteHandler(cwd, "telemetry");

    expect(result.status).toBe("wired");
    const wired = await readFile(path.join(cwd, T3_ROUTE_FILE), "utf8");
    expect(wired).toContain(
      'import { withAmplio } from "../../../../../telemetry/middleware/next";',
    );
    expect(wired).toContain("const wrappedHandler = withAmplio(handler);");
    expect(wired).toContain("export { wrappedHandler as GET, wrappedHandler as POST };");
    expect(wired).not.toMatch(/export \{ handler as GET/);
  });

  it("prefers the ~telemetry alias when tsconfig defines it", async () => {
    const cwd = await makeTempDir("amplio-wire-route-alias-");
    await scaffoldT3Files(cwd);
    await writeFile(
      path.join(cwd, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { paths: { "~telemetry/*": ["./telemetry/*"] } },
      }),
    );

    const result = await wireT3RouteHandler(cwd, "telemetry");

    expect(result.status).toBe("wired");
    const wired = await readFile(path.join(cwd, T3_ROUTE_FILE), "utf8");
    expect(wired).toContain('import { withAmplio } from "~telemetry/middleware/next";');
  });

  it("is idempotent", async () => {
    const cwd = await makeTempDir("amplio-wire-route-idem-");
    await scaffoldT3Files(cwd);

    await wireT3RouteHandler(cwd, "telemetry");
    const second = await wireT3RouteHandler(cwd, "telemetry");

    expect(second.status).toBe("already");
  });

  it("reports unrecognized when the export shape differs", async () => {
    const cwd = await makeTempDir("amplio-wire-route-unrec-");
    await mkdir(path.join(cwd, path.dirname(T3_ROUTE_FILE)), { recursive: true });
    await writeFile(
      path.join(cwd, T3_ROUTE_FILE),
      "export async function GET() { return new Response('ok'); }\n",
    );

    const result = await wireT3RouteHandler(cwd, "telemetry");

    expect(result.status).toBe("unrecognized");
  });

  it("reports not-found when the route file is absent", async () => {
    const cwd = await makeTempDir("amplio-wire-route-missing-");
    const result = await wireT3RouteHandler(cwd, "telemetry");
    expect(result.status).toBe("not-found");
  });
});

describe("wireT3TrpcProcedures", () => {
  it("prepends amplioMiddleware to both procedure bases", async () => {
    const cwd = await makeTempDir("amplio-wire-trpc-");
    await scaffoldT3Files(cwd);

    const result = await wireT3TrpcProcedures(cwd, "telemetry");

    expect(result.status).toBe("wired");
    const wired = await readFile(path.join(cwd, T3_TRPC_FILE), "utf8");
    expect(wired).toContain(
      'import { amplioTrpcMiddleware } from "../../../telemetry/middleware/trpc";',
    );
    expect(wired).toContain(
      "const amplioMiddleware = t.middleware(amplioTrpcMiddleware());",
    );
    expect(wired).toContain(
      "export const publicProcedure = t.procedure.use(amplioMiddleware).use(timingMiddleware);",
    );
    expect(wired).toContain(
      "export const protectedProcedure = t.procedure.use(amplioMiddleware)",
    );
    // Declaration must land above the doc comment, not between it and the export.
    const declIndex = wired.indexOf("const amplioMiddleware");
    const docIndex = wired.indexOf("* Public (unauthenticated) procedure");
    expect(declIndex).toBeGreaterThan(-1);
    expect(declIndex).toBeLessThan(docIndex);
  });

  it("is idempotent", async () => {
    const cwd = await makeTempDir("amplio-wire-trpc-idem-");
    await scaffoldT3Files(cwd);

    await wireT3TrpcProcedures(cwd, "telemetry");
    const second = await wireT3TrpcProcedures(cwd, "telemetry");

    expect(second.status).toBe("already");
  });

  it("reports unrecognized when no procedure exports match", async () => {
    const cwd = await makeTempDir("amplio-wire-trpc-unrec-");
    await mkdir(path.join(cwd, path.dirname(T3_TRPC_FILE)), { recursive: true });
    await writeFile(
      path.join(cwd, T3_TRPC_FILE),
      "export const proc = base.procedure;\n",
    );

    const result = await wireT3TrpcProcedures(cwd, "telemetry");

    expect(result.status).toBe("unrecognized");
  });
});

describe("runInit auto-wiring", () => {
  it("wires route handler and tRPC procedures under --yes in a T3 layout", async () => {
    const cwd = await makeTempDir("amplio-init-wire-");
    await writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({
        name: "t3-app",
        dependencies: {
          next: "^15.0.0",
          "@trpc/server": "^11.0.0",
          "next-auth": "^5.0.0",
          "@useamplio/amplio": "^0.1.0-alpha.9",
          zod: "^3.24.0",
        },
      }),
    );
    await scaffoldT3Files(cwd);

    const logs: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });
    await runInit({ cwd, skipInstall: true, yes: true });
    log.mockRestore();

    const route = await readFile(path.join(cwd, T3_ROUTE_FILE), "utf8");
    const trpc = await readFile(path.join(cwd, T3_TRPC_FILE), "utf8");
    expect(route).toContain("withAmplio(handler)");
    expect(trpc).toContain("use(amplioMiddleware)");
    expect(logs.join("\n")).toContain("Wiring create-t3-app layout");
  });

  it("prints a --wire hint instead of editing files without --yes/--wire", async () => {
    const cwd = await makeTempDir("amplio-init-nowire-");
    await writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({
        name: "t3-app",
        dependencies: {
          next: "^15.0.0",
          "@trpc/server": "^11.0.0",
          "@useamplio/amplio": "^0.1.0-alpha.9",
          zod: "^3.24.0",
        },
      }),
    );
    await scaffoldT3Files(cwd);

    const logs: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });
    // Simulate an interactive terminal so auto-scaffold (and auto-wire) is off.
    const originalIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    try {
      await runInit({ cwd, skipInstall: true, middleware: "next" });
    } finally {
      Object.defineProperty(process.stdout, "isTTY", {
        value: originalIsTTY,
        configurable: true,
      });
    }
    log.mockRestore();

    const route = await readFile(path.join(cwd, T3_ROUTE_FILE), "utf8");
    expect(route).not.toContain("withAmplio");
    expect(logs.join("\n")).toContain("amplio init --wire");
  });

  it("wires with --wire when middleware files already exist", async () => {
    const cwd = await makeTempDir("amplio-init-wireflag-");
    await writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({
        name: "t3-app",
        dependencies: {
          next: "^15.0.0",
          "@trpc/server": "^11.0.0",
          "@useamplio/amplio": "^0.1.0-alpha.9",
          zod: "^3.24.0",
        },
      }),
    );
    await scaffoldT3Files(cwd);

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runInit({ cwd, skipInstall: true, yes: true, wire: true });
    log.mockRestore();

    const route = await readFile(path.join(cwd, T3_ROUTE_FILE), "utf8");
    const trpc = await readFile(path.join(cwd, T3_TRPC_FILE), "utf8");
    expect(route).toContain("const wrappedHandler = withAmplio(handler);");
    expect(trpc).toContain("const amplioMiddleware = t.middleware(amplioTrpcMiddleware());");
  });
});
