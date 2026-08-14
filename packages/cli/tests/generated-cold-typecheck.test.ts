import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const cliRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const generated: string[] = [];

afterAll(async () => {
  await Promise.all(
    generated.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("fresh generated project", () => {
  it("typechecks under NodeNext using the built CLI", async () => {
    // Keep the fixture beneath packages/cli so normal Node resolution finds the
    // package's workspace-linked @useamplio/amplio and zod dependencies. There
    // are deliberately no fixture-specific node_modules or path aliases.
    const cwd = await mkdtemp(path.join(cliRoot, ".generated-typecheck-"));
    generated.push(cwd);
    await writeFile(
      path.join(cwd, "package.json"),
      `${JSON.stringify(
        {
          name: "generated-amplio-app",
          private: true,
          type: "module",
          dependencies: {
            "@useamplio/amplio": "0.1.0-alpha.16",
            hono: "^4.7.4",
            zod: "^3.24.2",
          },
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      path.join(cwd, "app.ts"),
      'import { Hono } from "hono";\n\nexport const app = new Hono();\n',
    );

    const runCli = (args: string[]) =>
      execFileSync(
        process.execPath,
        [path.join(cliRoot, "dist/cli.js"), ...args, "--cwd", cwd],
        {
          cwd: cliRoot,
          stdio: "pipe",
          env: { ...process.env, FORCE_COLOR: "0" },
        },
      );

    runCli(["init", "--yes", "--skip-install"]);
    runCli(["add", "event", "order.placed"]);
    runCli(["add", "enricher", "service-metadata"]);

    const tsconfigPath = path.join(cwd, "tsconfig.json");
    await writeFile(
      tsconfigPath,
      `${JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            types: ["node"],
          },
          include: ["telemetry/**/*.ts"],
        },
        null,
        2,
      )}\n`,
    );

    execFileSync("pnpm", ["exec", "tsc", "--noEmit", "-p", tsconfigPath], {
      cwd: cliRoot,
      stdio: "pipe",
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    const rootEvent = await readFile(
      path.join(cwd, "telemetry/events/http-request.ts"),
      "utf8",
    );
    expect(rootEvent).toContain('id: "http.request"');
    expect(rootEvent).toContain("// amplio:plugins");

    const addedEvent = await readFile(
      path.join(cwd, "telemetry/events/order-placed.ts"),
      "utf8",
    );
    expect(addedEvent).toContain('id: "order.placed"');
    expect(addedEvent).toContain("// amplio:plugin-imports");

    const plugin = await readFile(
      path.join(cwd, "telemetry/plugins/hono.ts"),
      "utf8",
    );
    expect(plugin).toContain("HttpRequest.handle");
    expect(plugin).toContain('import "../runtime.js";');
    expect(plugin).toContain('from "../events/http-request.js"');

    const runtime = await readFile(
      path.join(cwd, "telemetry/runtime.ts"),
      "utf8",
    );
    expect(runtime).toContain('from "./sinks/console.js"');
    expect(runtime).toContain('from "./enrichers/service-metadata.js"');
    expect(runtime).toContain("enrichers: [serviceMetadata]");
    expect(runtime).not.toMatch(/defineFact|defineWorkload|useLogger/);
  });
});
