import { mkdtemp, mkdir, readFile, writeFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runInit } from "../src/commands/init.js";
import {
  runAddEnricher,
  runAddEvent,
  runAddIntegration,
  runAddMiddleware,
  runAddSink,
} from "../src/commands/add.js";

const monorepoRegistry = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../registry/registry.json",
);

async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function initWithRegistry(cwd: string, service?: string): Promise<void> {
  await runInit({ cwd, service, skipInstall: true });
  const configPath = path.join(cwd, "amplio.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.registry = monorepoRegistry;
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}
`);
}

describe("runInit", () => {
  it("creates amplio.json, telemetry/logger.ts, and telemetry/events only", async () => {
    const cwd = await makeTempDir("amplio-init-");
    await runInit({ cwd, service: "test-app" , skipInstall: true });

    await access(path.join(cwd, "amplio.json"));
    await access(path.join(cwd, "telemetry/logger.ts"));
    await access(path.join(cwd, "telemetry/events"));

    await expect(access(path.join(cwd, "telemetry/middleware"))).rejects.toThrow();
    await expect(access(path.join(cwd, "telemetry/sinks"))).rejects.toThrow();
    await expect(access(path.join(cwd, "telemetry/enrichers"))).rejects.toThrow();
    await expect(access(path.join(cwd, "telemetry/integrations"))).rejects.toThrow();
    await expect(access(path.join(cwd, "telemetry/events/index.ts"))).rejects.toThrow();

    const config = JSON.parse(await readFile(path.join(cwd, "amplio.json"), "utf8"));
    expect(config.telemetryDir).toBe("telemetry");
    expect(config.$schema).toBeUndefined();
    await access(path.join(cwd, "components.json"));
    const components = JSON.parse(await readFile(path.join(cwd, "components.json"), "utf8"));
    expect(components.registries["@useamplio"]).toContain("/r/{name}.json");

    const loggerSource = await readFile(path.join(cwd, "telemetry/logger.ts"), "utf8");
    expect(loggerSource).toContain('import { init, logger } from "@useamplio/amplio"');
    expect(loggerSource).toContain("consoleJsonSink");
    expect(loggerSource).toContain("enrichers: []");
    expect(loggerSource).toContain("// sampling:");
    expect(loggerSource).toContain("// see @useamplio/amplio README ## Sampling");
    expect(loggerSource).toContain("export { logger }");
  });
  it("is idempotent — second init preserves events from add event", async () => {
    const cwd = await makeTempDir("amplio-init-idempotent-");
    await runInit({ cwd, service: "test-app" , skipInstall: true });
    await runAddEvent("auth.user.signed_up", { cwd });

    const eventPath = path.join(cwd, "telemetry/events/auth/user-signed-up.ts");
    const eventBefore = await readFile(eventPath, "utf8");
    const loggerBefore = await readFile(path.join(cwd, "telemetry/logger.ts"), "utf8");

    await runInit({ cwd, service: "other-service" , skipInstall: true });

    expect(await readFile(eventPath, "utf8")).toBe(eventBefore);
    expect(await readFile(path.join(cwd, "telemetry/logger.ts"), "utf8")).toBe(loggerBefore);
  });

});

describe("runAddEvent", () => {
  it("scaffolds nested auth.user.signed_up with barrel files", async () => {
    const cwd = await makeTempDir("amplio-add-");
    await runInit({ cwd , skipInstall: true });
    await runAddEvent("auth.user.signed_up", { cwd });

    const eventPath = path.join(cwd, "telemetry/events/auth/user-signed-up.ts");
    await access(eventPath);

    const eventSource = await readFile(eventPath, "utf8");
    expect(eventSource).toContain('"auth.user.signed_up"');
    expect(eventSource).toContain("AuthUserSignedUp");

    const domainBarrel = await readFile(path.join(cwd, "telemetry/events/auth/index.ts"), "utf8");
    expect(domainBarrel).toContain("AuthUserSignedUp");

    const rootBarrel = await readFile(path.join(cwd, "telemetry/events/index.ts"), "utf8");
    expect(rootBarrel).toContain("AuthUserSignedUp");
  });
  it("add event auth.user.signed_up without init creates event file", async () => {
    const cwd = await makeTempDir("amplio-add-no-init-");
    await expect(runAddEvent("auth.user.signed_up", { cwd })).resolves.toBeUndefined();

    const eventPath = path.join(cwd, "telemetry/events/auth/user-signed-up.ts");
    await access(eventPath);
  });


  it("installs payment.order.paid from registry with barrels", async () => {
    const cwd = await makeTempDir("amplio-add-payment-");
    await initWithRegistry(cwd);
    await runAddEvent("payment.order.paid", { cwd });

    const eventPath = path.join(cwd, "telemetry/events/payment/order-paid.ts");
    await access(eventPath);

    const eventSource = await readFile(eventPath, "utf8");
    expect(eventSource).toContain('"payment.order.paid"');
    expect(eventSource).toContain("PaymentOrderPaid");
    expect(eventSource).toContain("amount_cents");

    const domainBarrel = await readFile(
      path.join(cwd, "telemetry/events/payment/index.ts"),
      "utf8",
    );
    expect(domainBarrel).toContain("PaymentOrderPaid");

    const rootBarrel = await readFile(path.join(cwd, "telemetry/events/index.ts"), "utf8");
    expect(rootBarrel).toContain("PaymentOrderPaid");
  });

  it("is idempotent — second add auth.user.signed_up preserves file (registry)", async () => {
    const cwd = await makeTempDir("amplio-add-idempotent-");
    await initWithRegistry(cwd);
    await runAddEvent("auth.user.signed_up", { cwd });

    const eventPath = path.join(cwd, "telemetry/events/auth/user-signed-up.ts");
    const before = await readFile(eventPath, "utf8");
    const edited = `${before}\n// user edit\n`;
    await writeFile(eventPath, edited);

    await expect(runAddEvent("auth.user.signed_up", { cwd })).resolves.toBeUndefined();
    expect(await readFile(eventPath, "utf8")).toBe(edited);
  });

  it("force:true overwrites auth.user.signed_up with registry content", async () => {
    const cwd = await makeTempDir("amplio-add-force-");
    await initWithRegistry(cwd);
    await runAddEvent("auth.user.signed_up", { cwd });

    const eventPath = path.join(cwd, "telemetry/events/auth/user-signed-up.ts");
    const template = await readFile(eventPath, "utf8");
    await writeFile(eventPath, `${template}\n// user edit\n`);

    await expect(
      runAddEvent("auth.user.signed_up", { cwd, force: true }),
    ).resolves.toBeUndefined();

    const after = await readFile(eventPath, "utf8");
    expect(after).toBe(template);
    expect(after).not.toContain("// user edit");
    expect(after).toContain("auth.user.signed_up");
    expect(after).toContain("AuthUserSignedUp");
    expect(after).toContain("signup");
  });

  it("accepts hyphenated registry ids from list output (auth-user-signed-in)", async () => {
    const cwd = await makeTempDir("amplio-add-hyphen-id-");
    await initWithRegistry(cwd);
    await runAddEvent("auth-user-signed-in", { cwd });

    const eventPath = path.join(cwd, "telemetry/events/auth/user-signed-in.ts");
    await access(eventPath);
    const eventSource = await readFile(eventPath, "utf8");
    expect(eventSource).toContain('"auth.user.signed_in"');
  });

  it("still rejects hyphen names with no registry match", async () => {
    const cwd = await makeTempDir("amplio-add-hyphen-miss-");
    await initWithRegistry(cwd);
    await expect(runAddEvent("no-such-event", { cwd })).rejects.toThrow(/Invalid event name/);
  });

  it("starter schema namespaces payload by entity segment for 3+-segment names", async () => {
    const cwd = await makeTempDir("amplio-add-entity-");
    await runInit({ cwd, skipInstall: true });
    await runAddEvent("ui.feedback.submitted", { cwd });

    const eventSource = await readFile(
      path.join(cwd, "telemetry/events/ui/feedback-submitted.ts"),
      "utf8",
    );
    // The entity is `feedback` (second-to-last segment), not the `ui` domain.
    expect(eventSource).toContain("feedback: z.object({");
    expect(eventSource).not.toContain("ui: z.object({");
  });

  it("starter schema keeps the domain namespace for 2-segment names", async () => {
    const cwd = await makeTempDir("amplio-add-two-seg-");
    await runInit({ cwd, skipInstall: true });
    await runAddEvent("post.created", { cwd });

    const eventSource = await readFile(
      path.join(cwd, "telemetry/events/post/created.ts"),
      "utf8",
    );
    expect(eventSource).toContain("post: z.object({");
  });

  it("installs email.sent from registry with barrels", async () => {
    const cwd = await makeTempDir("amplio-add-email-");
    await initWithRegistry(cwd);
    await runAddEvent("email.sent", { cwd });

    const eventPath = path.join(cwd, "telemetry/events/email/sent.ts");
    await access(eventPath);

    const eventSource = await readFile(eventPath, "utf8");
    expect(eventSource).toContain('"email.sent"');
    expect(eventSource).toContain("EmailSent");
    expect(eventSource).toContain("delivery");

    const domainBarrel = await readFile(path.join(cwd, "telemetry/events/email/index.ts"), "utf8");
    expect(domainBarrel).toContain("EmailSent");

    const rootBarrel = await readFile(path.join(cwd, "telemetry/events/index.ts"), "utf8");
    expect(rootBarrel).toContain("EmailSent");
  });
});


describe("runAddMiddleware", () => {
  it("scaffolds hono middleware after init", async () => {
    const cwd = await makeTempDir("amplio-mw-");
    await initWithRegistry(cwd);
    await runAddMiddleware("hono", { cwd });

    const middlewarePath = path.join(cwd, "telemetry/middleware/hono.ts");
    await access(middlewarePath);

    const source = await readFile(middlewarePath, "utf8");
    expect(source).toContain("amplioMiddleware");
  });

  it("add middleware hono without init creates telemetry/middleware/hono.ts", async () => {
    const cwd = await makeTempDir("amplio-mw-no-init-");
    await expect(runAddMiddleware("hono", { cwd })).resolves.toBeUndefined();
    const middlewarePath = path.join(cwd, "telemetry/middleware/hono.ts");
    await access(middlewarePath);
  });

  it("scaffolds fastify middleware after init", async () => {
    const cwd = await makeTempDir("amplio-mw-fastify-");
    await initWithRegistry(cwd);
    await runAddMiddleware("fastify", { cwd });

    const middlewarePath = path.join(cwd, "telemetry/middleware/fastify.ts");
    await access(middlewarePath);

    const source = await readFile(middlewarePath, "utf8");
    expect(source).toContain("amplioPlugin");
    expect(source).toContain("useRequestLogger");
  });

  it("add middleware fastify without init creates telemetry/middleware/fastify.ts", async () => {
    const cwd = await makeTempDir("amplio-mw-fastify-no-init-");
    await expect(runAddMiddleware("fastify", { cwd })).resolves.toBeUndefined();
    const middlewarePath = path.join(cwd, "telemetry/middleware/fastify.ts");
    await access(middlewarePath);
  });

  it("scaffolds express middleware after init", async () => {
    const cwd = await makeTempDir("amplio-mw-express-");
    await initWithRegistry(cwd);
    await runAddMiddleware("express", { cwd });

    const middlewarePath = path.join(cwd, "telemetry/middleware/express.ts");
    await access(middlewarePath);

    const source = await readFile(middlewarePath, "utf8");
    expect(source).toContain("amplioMiddleware");
    expect(source).toContain("useRequestLogger");
  });

  it("add middleware express without init creates telemetry/middleware/express.ts", async () => {
    const cwd = await makeTempDir("amplio-mw-express-no-init-");
    await expect(runAddMiddleware("express", { cwd })).resolves.toBeUndefined();
    const middlewarePath = path.join(cwd, "telemetry/middleware/express.ts");
    await access(middlewarePath);
  });

  it("scaffolds next middleware after init", async () => {
    const cwd = await makeTempDir("amplio-mw-next-");
    await initWithRegistry(cwd);
    await runAddMiddleware("next", { cwd });

    const middlewarePath = path.join(cwd, "telemetry/middleware/next.ts");
    await access(middlewarePath);

    const source = await readFile(middlewarePath, "utf8");
    expect(source).toContain("withAmplio");
    expect(source).toContain("useRequestLogger");
  });



  it("scaffolds trpc middleware after init", async () => {
    const cwd = await makeTempDir("amplio-mw-trpc-");
    await initWithRegistry(cwd);
    await runAddMiddleware("trpc", { cwd });

    const middlewarePath = path.join(cwd, "telemetry/middleware/trpc.ts");
    await access(middlewarePath);

    const source = await readFile(middlewarePath, "utf8");
    expect(source).toContain("hasAmbientLogger");
  });

  it("add middleware next without init creates telemetry/middleware/next.ts", async () => {
    const cwd = await makeTempDir("amplio-mw-next-no-init-");
    await expect(runAddMiddleware("next", { cwd })).resolves.toBeUndefined();
    const middlewarePath = path.join(cwd, "telemetry/middleware/next.ts");
    await access(middlewarePath);
  });

  it("second add hono preserves existing middleware file", async () => {
    const cwd = await makeTempDir("amplio-mw-idempotent-");
    await initWithRegistry(cwd);
    await runAddMiddleware("hono", { cwd });

    const middlewarePath = path.join(cwd, "telemetry/middleware/hono.ts");
    const before = await readFile(middlewarePath, "utf8");
    const edited = `${before}\n// user edit\n`;
    await writeFile(middlewarePath, edited);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(runAddMiddleware("hono", { cwd })).resolves.toBeUndefined();

    expect(await readFile(middlewarePath, "utf8")).toBe(edited);
    expect(logSpy.mock.calls.some((call) => call[0] === "  · skipped existing middleware file")).toBe(
      true,
    );
    logSpy.mockRestore();
  });

});


describe("runAddSink", () => {
  it("scaffolds console sink after init", async () => {
    const cwd = await makeTempDir("amplio-sink-");
    await initWithRegistry(cwd);
    await runAddSink("console", { cwd });

    const sinkPath = path.join(cwd, "telemetry/sinks/console.ts");
    await access(sinkPath);

    const source = await readFile(sinkPath, "utf8");
    expect(source).toContain("consoleSink");
  });

  it("add sink console without init creates telemetry/sinks/console.ts", async () => {
    const cwd = await makeTempDir("amplio-sink-no-init-");
    await expect(runAddSink("console", { cwd })).resolves.toBeUndefined();
    const sinkPath = path.join(cwd, "telemetry/sinks/console.ts");
    await access(sinkPath);
  });

  it("scaffolds otlp sink after init", async () => {
    const cwd = await makeTempDir("amplio-sink-otlp-");
    await initWithRegistry(cwd);
    await runAddSink("otlp", { cwd });
    const sinkPath = path.join(cwd, "telemetry/sinks/otlp.ts");
    await access(sinkPath);
    const source = await readFile(sinkPath, "utf8");
    expect(source).toContain("export function otlpSink");

    const loggerSource = await readFile(path.join(cwd, "telemetry/logger.ts"), "utf8");
    expect(loggerSource).toContain("otlpSink");
    expect(loggerSource).toContain("./sinks/otlp");
    expect(loggerSource).toMatch(/sinks:\s*\[[^\]]*otlpSink\(\)/);
  });

  it("add sink otlp without init creates telemetry/sinks/otlp.ts", async () => {
    const cwd = await makeTempDir("amplio-sink-otlp-no-init-");
    await expect(runAddSink("otlp", { cwd })).resolves.toBeUndefined();
    const sinkPath = path.join(cwd, "telemetry/sinks/otlp.ts");
    await access(sinkPath);
  });

  it("does not double-add otlp sink to logger.ts", async () => {
    const cwd = await makeTempDir("amplio-sink-idempotent-");
    await initWithRegistry(cwd);
    await runAddSink("otlp", { cwd });
    await runAddSink("otlp", { cwd });
    const loggerSource = await readFile(path.join(cwd, "telemetry/logger.ts"), "utf8");
    const matches = loggerSource.match(/otlpSink/g) ?? [];
    expect(matches.length).toBe(2);
  });

  it("keeps a single blank line after repeated sink codemods", async () => {
    const cwd = await makeTempDir("amplio-sink-blank-lines-");
    await initWithRegistry(cwd);
    await runAddSink("otlp", { cwd });
    await runAddSink("json", { cwd });

    const loggerSource = await readFile(path.join(cwd, "telemetry/logger.ts"), "utf8");
    expect(loggerSource).not.toMatch(/\n{4,}/);
    expect(loggerSource).toMatch(
      /import \{ jsonFileSink \} from "\.\/sinks\/json";\n\nconst consoleJsonSink/,
    );
  });

  it("updates composeSinks logger when adding otlp", async () => {
    const cwd = await makeTempDir("amplio-sink-compose-");
    await initWithRegistry(cwd);
    const loggerPath = path.join(cwd, "telemetry/logger.ts");
    await writeFile(
      loggerPath,
      `import { init, logger, type LogRecord, type Sink } from "@useamplio/amplio";
import { consoleSink } from "./sinks/console";

type Enricher = (record: LogRecord) => LogRecord;

function composeSinks(enrichers: Enricher[], sinks: Sink[]): Sink[] {
  if (enrichers.length === 0) {
    return sinks;
  }

  return sinks.map((sink) => (record) => sink(enrichers.reduce((acc, enrich) => enrich(acc), record)));
}

init({
  service: "test-app",
  env: process.env.NODE_ENV ?? "development",
  sinks: composeSinks([], [consoleSink]),
});

export { logger };
`,
    );
    await runAddSink("otlp", { cwd });
    const loggerSource = await readFile(loggerPath, "utf8");
    expect(loggerSource).toContain('import { otlpSink } from "./sinks/otlp"');
    expect(loggerSource).toContain("composeSinks([], [consoleSink, otlpSink()])");
  });

  it("scaffolds json sink after init", async () => {
    const cwd = await makeTempDir("amplio-sink-json-");
    await initWithRegistry(cwd);
    await runAddSink("json", { cwd });

    const sinkPath = path.join(cwd, "telemetry/sinks/json.ts");
    await access(sinkPath);

    const source = await readFile(sinkPath, "utf8");
    expect(source).toContain("jsonFileSink");
  });


  it("add sink json updates .gitignore and .env.example", async () => {
    const cwd = await makeTempDir("amplio-sink-json-gitignore-");
    await initWithRegistry(cwd);
    await writeFile(path.join(cwd, ".env.example"), "FOO=bar\n");
    await runAddSink("json", { cwd });

    const gitignore = await readFile(path.join(cwd, ".gitignore"), "utf8");
    expect(gitignore).toContain("amplio.jsonl");

    const envExample = await readFile(path.join(cwd, ".env.example"), "utf8");
    expect(envExample).toContain("AMPLIO_JSON_SINK_PATH");
  });

  it("add sink json without init creates telemetry/sinks/json.ts", async () => {
    const cwd = await makeTempDir("amplio-sink-json-no-init-");
    await expect(runAddSink("json", { cwd })).resolves.toBeUndefined();
    const sinkPath = path.join(cwd, "telemetry/sinks/json.ts");
    await access(sinkPath);
  });

  it("second add console preserves existing sink file", async () => {
    const cwd = await makeTempDir("amplio-sink-idempotent-");
    await initWithRegistry(cwd);
    await runAddSink("console", { cwd });

    const sinkPath = path.join(cwd, "telemetry/sinks/console.ts");
    const before = await readFile(sinkPath, "utf8");
    const edited = `${before}\n// user edit\n`;
    await writeFile(sinkPath, edited);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(runAddSink("console", { cwd })).resolves.toBeUndefined();

    expect(await readFile(sinkPath, "utf8")).toBe(edited);
    expect(logSpy.mock.calls.some((call) => call[0] === "  · skipped existing sink file")).toBe(
      true,
    );
    logSpy.mockRestore();
  });
});


describe("runAddEnricher", () => {
  it("add enricher request without init creates telemetry/enrichers/request-metadata.ts", async () => {
    const cwd = await makeTempDir("amplio-enricher-no-init-");
    await expect(runAddEnricher("request", { cwd })).resolves.toBeUndefined();
    const enricherPath = path.join(cwd, "telemetry/enrichers/request-metadata.ts");
    await access(enricherPath);
  });

  it("add enricher service-metadata without init creates telemetry/enrichers/service-metadata.ts", async () => {
    const cwd = await makeTempDir("amplio-enricher-service-metadata-no-init-");
    await expect(runAddEnricher("service-metadata", { cwd })).resolves.toBeUndefined();
    const enricherPath = path.join(cwd, "telemetry/enrichers/service-metadata.ts");
    await access(enricherPath);
  });

  it("scaffolds request-metadata enricher when alias request is used", async () => {
    const cwd = await makeTempDir("amplio-enricher-");
    await initWithRegistry(cwd);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runAddEnricher("request", { cwd });
    logSpy.mockRestore();

    const enricherPath = path.join(cwd, "telemetry/enrichers/request-metadata.ts");
    await access(enricherPath);

    const source = await readFile(enricherPath, "utf8");
    expect(source).toContain("requestMetadata");

    const loggerSource = await readFile(path.join(cwd, "telemetry/logger.ts"), "utf8");
    expect(loggerSource).not.toContain("requestMetadata");
    expect(loggerSource).not.toContain("./enrichers/request-metadata");
  });

  it("scaffolds service-metadata enricher after init", async () => {
    const cwd = await makeTempDir("amplio-enricher-service-metadata-");
    await initWithRegistry(cwd);
    await runAddEnricher("service-metadata", { cwd });

    const enricherPath = path.join(cwd, "telemetry/enrichers/service-metadata.ts");
    await access(enricherPath);

    const source = await readFile(enricherPath, "utf8");
    expect(source).toContain("serviceMetadata");

    const loggerSource = await readFile(path.join(cwd, "telemetry/logger.ts"), "utf8");
    expect(loggerSource).toContain('from "./enrichers/service-metadata"');
    expect(loggerSource).toMatch(/enrichers:\s*\[[^\]]*serviceMetadata/);
    expect(loggerSource).not.toContain("composeSinks");
  });

  it("scaffolds query-allowlist enricher and wires it into init()", async () => {
    const cwd = await makeTempDir("amplio-enricher-query-allowlist-");
    await initWithRegistry(cwd);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runAddEnricher("query-allowlist", { cwd });
    logSpy.mockRestore();

    const enricherPath = path.join(cwd, "telemetry/enrichers/query-allowlist.ts");
    await access(enricherPath);

    const source = await readFile(enricherPath, "utf8");
    expect(source).toContain("queryAllowlist");

    const loggerSource = await readFile(path.join(cwd, "telemetry/logger.ts"), "utf8");
    expect(loggerSource).toContain('from "./enrichers/query-allowlist"');
    expect(loggerSource).toMatch(/enrichers:\s*\[[^\]]*queryAllowlist\(\)/);
  });

  it("second add request preserves existing enricher file", async () => {
    const cwd = await makeTempDir("amplio-enricher-idempotent-");
    await initWithRegistry(cwd);
    await runAddEnricher("request", { cwd });

    const enricherPath = path.join(cwd, "telemetry/enrichers/request-metadata.ts");
    const before = await readFile(enricherPath, "utf8");
    const edited = `${before}\n// user edit\n`;
    await writeFile(enricherPath, edited);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(runAddEnricher("request", { cwd })).resolves.toBeUndefined();

    expect(await readFile(enricherPath, "utf8")).toBe(edited);
    expect(logSpy.mock.calls.some((call) => call[0] === "  · skipped existing enricher file")).toBe(
      true,
    );
    logSpy.mockRestore();
  });
});

describe("runAddIntegration", () => {
  it("scaffolds resend integration and email.sent event after init", async () => {
    const cwd = await makeTempDir("amplio-int-");
    await initWithRegistry(cwd);
    await runAddIntegration("resend", { cwd });

    const integrationPath = path.join(cwd, "telemetry/integrations/resend.ts");
    await access(integrationPath);

    const eventPath = path.join(cwd, "telemetry/events/email/sent.ts");
    await access(eventPath);

    const integrationSource = await readFile(integrationPath, "utf8");
    expect(integrationSource).toContain("trackResendEmail");

    const eventSource = await readFile(eventPath, "utf8");
    expect(eventSource).toContain('"email.sent"');
    expect(eventSource).toContain("EmailSent");
  });

  it("second add resend preserves existing integration file", async () => {
    const cwd = await makeTempDir("amplio-int-idempotent-");
    await initWithRegistry(cwd);
    await runAddIntegration("resend", { cwd });

    const integrationPath = path.join(cwd, "telemetry/integrations/resend.ts");
    const before = await readFile(integrationPath, "utf8");
    const edited = `${before}\n// user edit\n`;
    await writeFile(integrationPath, edited);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(runAddIntegration("resend", { cwd })).resolves.toBeUndefined();

    expect(await readFile(integrationPath, "utf8")).toBe(edited);
    expect(
      logSpy.mock.calls.some((call) => call[0] === "  · skipped existing integration file"),
    ).toBe(true);
    logSpy.mockRestore();
  });

  it("add integration resend without init creates telemetry/integrations/resend.ts", async () => {
    const cwd = await makeTempDir("amplio-int-resend-no-init-");
    await expect(runAddIntegration("resend", { cwd })).resolves.toBeUndefined();
    const integrationPath = path.join(cwd, "telemetry/integrations/resend.ts");
    await access(integrationPath);
  });

  it("scaffolds better-auth integration and auth events after init", async () => {
    const cwd = await makeTempDir("amplio-int-better-auth-");
    await initWithRegistry(cwd);
    await runAddIntegration("better-auth", { cwd });
    const integrationPath = path.join(cwd, "telemetry/integrations/better-auth.ts");
    await access(integrationPath);
    const signedUpPath = path.join(cwd, "telemetry/events/auth/user-signed-up.ts");
    await access(signedUpPath);
    const signedInPath = path.join(cwd, "telemetry/events/auth/user-signed-in.ts");
    await access(signedInPath);
    const integrationSource = await readFile(integrationPath, "utf8");
    expect(integrationSource).toContain("createBetterAuthAmplioPlugin");
    const signedUpSource = await readFile(signedUpPath, "utf8");
    expect(signedUpSource).toContain('"auth.user.signed_up"');
    expect(signedUpSource).toContain("AuthUserSignedUp");
    const signedInSource = await readFile(signedInPath, "utf8");
    expect(signedInSource).toContain('"auth.user.signed_in"');
    expect(signedInSource).toContain("AuthUserSignedIn");
  });

  it("add integration better-auth without init creates telemetry/integrations/better-auth.ts", async () => {
    const cwd = await makeTempDir("amplio-int-better-auth-no-init-");
    await expect(runAddIntegration("better-auth", { cwd })).resolves.toBeUndefined();
    const integrationPath = path.join(cwd, "telemetry/integrations/better-auth.ts");
    await access(integrationPath);
  });

  it("scaffolds clerk integration and auth events after init", async () => {
    const cwd = await makeTempDir("amplio-int-clerk-");
    await initWithRegistry(cwd);
    await runAddIntegration("clerk", { cwd });
    const integrationPath = path.join(cwd, "telemetry/integrations/clerk.ts");
    await access(integrationPath);
    const signedUpPath = path.join(cwd, "telemetry/events/auth/user-signed-up.ts");
    await access(signedUpPath);
    const signedInPath = path.join(cwd, "telemetry/events/auth/user-signed-in.ts");
    await access(signedInPath);
    const integrationSource = await readFile(integrationPath, "utf8");
    expect(integrationSource).toContain("trackClerkUserCreated");
    expect(integrationSource).toContain("handleClerkWebhook");
    const signedUpSource = await readFile(signedUpPath, "utf8");
    expect(signedUpSource).toContain('"auth.user.signed_up"');
    expect(signedUpSource).toContain("AuthUserSignedUp");
    const signedInSource = await readFile(signedInPath, "utf8");
    expect(signedInSource).toContain('"auth.user.signed_in"');
    expect(signedInSource).toContain("AuthUserSignedIn");
  });

  it("add integration clerk without init creates telemetry/integrations/clerk.ts", async () => {
    const cwd = await makeTempDir("amplio-int-clerk-no-init-");
    await expect(runAddIntegration("clerk", { cwd })).resolves.toBeUndefined();
    const integrationPath = path.join(cwd, "telemetry/integrations/clerk.ts");
    await access(integrationPath);
  });

  it("scaffolds polar integration and payment.order.paid event after init", async () => {
    const cwd = await makeTempDir("amplio-int-polar-");
    await initWithRegistry(cwd);
    await runAddIntegration("polar", { cwd });
    const integrationPath = path.join(cwd, "telemetry/integrations/polar.ts");
    await access(integrationPath);
    const eventPath = path.join(cwd, "telemetry/events/payment/order-paid.ts");
    await access(eventPath);
    const integrationSource = await readFile(integrationPath, "utf8");
    expect(integrationSource).toContain("trackPolarOrderPaid");
    expect(integrationSource).toContain("handlePolarWebhook");
    const eventSource = await readFile(eventPath, "utf8");
    expect(eventSource).toContain('"payment.order.paid"');
    expect(eventSource).toContain("PaymentOrderPaid");
  });

  it("add integration polar without init creates telemetry/integrations/polar.ts", async () => {
    const cwd = await makeTempDir("amplio-int-polar-no-init-");
    await expect(runAddIntegration("polar", { cwd })).resolves.toBeUndefined();
    const integrationPath = path.join(cwd, "telemetry/integrations/polar.ts");
    await access(integrationPath);
  });
});

describe("runInit framework detect", () => {
  it("auto-scaffolds next middleware without auth event when no auth dependency", async () => {
    const cwd = await makeTempDir("amplio-init-next-");
    await writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({ dependencies: { next: "^15.0.0" } }, null, 2),
    );
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });
    await runInit({ cwd, yes: true, skipInstall: true });
    logSpy.mockRestore();

    const middlewarePath = path.join(cwd, "telemetry/middleware/next.ts");
    const eventPath = path.join(cwd, "telemetry/events/auth/user-signed-up.ts");
    await access(middlewarePath);
    await expect(access(eventPath)).rejects.toThrow();

    const middlewareSource = await readFile(middlewarePath, "utf8");
    expect(middlewareSource).toContain("withAmplio");
    expect(middlewareSource).toContain("scheduleFlush");
    expect(logs.join("\n")).toContain("No starter event scaffolded");
  });

  it("auto-scaffolds auth.user.signed_up with --yes when better-auth is present", async () => {
    const cwd = await makeTempDir("amplio-init-next-auth-");
    await writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({
        dependencies: { next: "^15.0.0", "better-auth": "^1.0.0" },
      }, null, 2),
    );
    await runInit({ cwd, yes: true, skipInstall: true });

    await access(path.join(cwd, "telemetry/middleware/next.ts"));
    await access(path.join(cwd, "telemetry/events/auth/user-signed-up.ts"));
  });

  it("respects --middleware none --event none", async () => {
    const cwd = await makeTempDir("amplio-init-skip-");
    await writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({ dependencies: { hono: "^4.0.0" } }, null, 2),
    );
    await runInit({ cwd, yes: true, middleware: "none", event: "none" , skipInstall: true });

    await expect(access(path.join(cwd, "telemetry/middleware/hono.ts"))).rejects.toThrow();
    await expect(access(path.join(cwd, "telemetry/events/auth/user-signed-up.ts"))).rejects.toThrow();
  });

  it("explicit --middleware hono scaffolds hono without package.json", async () => {
    const cwd = await makeTempDir("amplio-init-explicit-mw-");
    await runInit({ cwd, middleware: "hono", event: "none" , skipInstall: true });

    const middlewarePath = path.join(cwd, "telemetry/middleware/hono.ts");
    await access(middlewarePath);
    await expect(access(path.join(cwd, "telemetry/events/auth/user-signed-up.ts"))).rejects.toThrow();
  });

  it("detects npm from package-lock.json in amplio.json", async () => {
    const cwd = await makeTempDir("amplio-init-pm-detect-");
    await writeFile(path.join(cwd, "package-lock.json"), "{}");
    await runInit({ cwd, skipInstall: true });

    const config = JSON.parse(await readFile(path.join(cwd, "amplio.json"), "utf8"));
    expect(config.packageManager).toBe("npm");
  });

  it("creates instrumentation.ts for Next.js projects", async () => {
    const cwd = await makeTempDir("amplio-init-next-instrumentation-");
    await writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({ dependencies: { next: "^15.0.0" } }),
    );
    await mkdir(path.join(cwd, "src/app"), { recursive: true });
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });
    await runInit({ cwd, yes: true, skipInstall: true });
    logSpy.mockRestore();

    const instrumentation = await readFile(path.join(cwd, "src/instrumentation.ts"), "utf8");
    expect(instrumentation).toContain("telemetry/logger");
    expect(instrumentation).toContain("register");
    // Edge-runtime guard: Next compiles instrumentation.ts for Edge too, and
    // telemetry/ may import node: builtins (JSON sink).
    expect(instrumentation).toContain('process.env.NEXT_RUNTIME === "nodejs"');
    expect(logs.join("\n")).toContain("withAmplio");
    expect(logs.join("\n")).toContain("~telemetry/*");
  });

  it("re-run init reports wired instrumentation and skips the starter-event hint when events exist", async () => {
    const cwd = await makeTempDir("amplio-init-rerun-");
    await writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({ dependencies: { next: "^15.0.0" } }),
    );
    await mkdir(path.join(cwd, "src/app"), { recursive: true });
    await runInit({ cwd, yes: true, skipInstall: true });
    await runAddEvent("post.created", { cwd });

    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });
    await runInit({ cwd, yes: true, skipInstall: true });
    logSpy.mockRestore();

    const output = logs.join("\n");
    expect(output).toContain("src/instrumentation.ts already wired");
    expect(output).not.toContain("ensure instrumentation.ts imports");
    expect(output).not.toContain("No starter event scaffolded");
  });

  it("defaults service name from package.json when --service omitted", async () => {
    const cwd = await makeTempDir("amplio-init-pkg-name-");
    await writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({ name: "my-cool-app", dependencies: {} }),
    );
    await runInit({ cwd, skipInstall: true });

    const loggerSource = await readFile(path.join(cwd, "telemetry/logger.ts"), "utf8");
    expect(loggerSource).toContain('service: "my-cool-app"');
  });
});
