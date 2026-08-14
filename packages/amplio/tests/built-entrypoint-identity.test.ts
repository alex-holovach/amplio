import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import pkg from "../package.json" with { type: "json" };

const packageRoot = path.resolve(import.meta.dirname, "..");

const builtConsumerScript = String.raw`
  import * as main from "./dist/index.js";
  import * as authoring from "./dist/plugin.js";
  import * as testing from "./dist/testing.js";

  const schema = () => ({
    "~standard": {
      version: 1,
      vendor: "built-entrypoint-contract",
      validate(value) {
        return { value };
      },
    },
  });

  const Seen = main.event({
    id: "contract.built_seen",
    version: 1,
    schema: schema(),
    timing: "instant",
    cardinality: { many: { max: 4 } },
  });

  const SeenPlugin = authoring.plugin({
    id: "built-seen",
    events: { seen: Seen },
    instrument({ events, record }) {
      return (value) => record(events.seen, value);
    },
  });

  const Root = main.event({
    id: "contract.built_root",
    version: 1,
    schema: schema(),
    tree: { contributor: SeenPlugin.events },
  });
  const SameSemanticId = main.event({
    id: "contract.built_root",
    version: 1,
    schema: schema(),
  });

  const events = testing.createTestSink();
  main.init({
    service: "built-entrypoint-contract",
    env: "test",
    sinks: [events],
  });

  const applicationResult = { status: "ok" };
  const handler = Root.handle(
    () => {
      SeenPlugin({ label: "cross_subpath" });
      return applicationResult;
    },
    { input: () => ({ request_id: "req_built" }) },
  );
  const returned = handler();
  const record = events.single(Root);

  process.stdout.write(JSON.stringify({
    applicationIdentity: returned === applicationResult,
    exactIdentityCount: events.all(Root).length,
    sameIdDifferentIdentityCount: events.all(SameSemanticId).length,
    nestedLabel: record.contributor?.seen?.[0]?.label,
    runtimeExports: {
      main: Object.keys(main).sort(),
      plugin: Object.keys(authoring).sort(),
      testing: Object.keys(testing).sort(),
    },
  }));
`;

const readDeclarationGraph = async (entry: string): Promise<string> => {
  const visited = new Set<string>();
  const declarations: string[] = [];

  const visit = async (filePath: string): Promise<void> => {
    const resolved = path.resolve(filePath);
    if (visited.has(resolved)) return;
    visited.add(resolved);

    const source = await readFile(resolved, "utf8");
    declarations.push(source);
    for (const match of source.matchAll(
      /(?:from\s+|import\()["'](\.[^"']+)["']/g,
    )) {
      const specifier = match[1]!;
      await visit(
        path.resolve(
          path.dirname(resolved),
          specifier.endsWith(".js")
            ? `${specifier.slice(0, -3)}.d.ts`
            : specifier,
        ),
      );
    }
  };

  await visit(path.join(packageRoot, entry));
  return declarations.join("\n");
};

const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("built package entrypoints", () => {
  it("shares exact Event identity across main, Plugin, and testing bundles", () => {
    const output = execFileSync(
      process.execPath,
      ["--input-type=module", "--eval", builtConsumerScript],
      {
        cwd: packageRoot,
        encoding: "utf8",
      },
    );

    expect(JSON.parse(output)).toEqual({
      applicationIdentity: true,
      exactIdentityCount: 1,
      sameIdDifferentIdentityCount: 0,
      nestedLabel: "cross_subpath",
      runtimeExports: {
        main: ["event", "flush", "init"],
        plugin: ["openEvent", "plugin"],
        testing: ["assertEvent", "createTestSink"],
      },
    });
  });

  it("publishes only vNext entrypoints plus the explicit legacy quarantine", () => {
    expect(pkg.exports).toEqual({
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js",
      },
      "./plugin": {
        types: "./dist/plugin.d.ts",
        import: "./dist/plugin.js",
      },
      "./testing": {
        types: "./dist/testing.d.ts",
        import: "./dist/testing.js",
      },
      "./legacy": {
        types: "./dist/legacy.d.ts",
        import: "./dist/legacy.js",
      },
    });
  });

  it("keeps alpha semantic concepts out of every vNext declaration graph", async () => {
    const graph = withoutComments(
      (
        await Promise.all([
          readDeclarationGraph("dist/index.d.ts"),
          readDeclarationGraph("dist/plugin.d.ts"),
          readDeclarationGraph("dist/testing.d.ts"),
        ])
      ).join("\n"),
    );
    const forbiddenNames = [
      "Fact",
      "Operation",
      "Component",
      "Workload",
      "Logger",
      "LoggerFacade",
      "EventLogger",
      "LegacySink",
      "LogRecord",
      "EventShape",
      "AmplioConfig",
      "Enricher",
      "canonicalKeyOnly",
      "defineFact",
      "defineOperation",
      "defineComponent",
      "defineWorkload",
      "createLogger",
      "createRequestLogger",
      "getLogger",
      "useLogger",
      "runWithLogger",
    ];

    for (const name of forbiddenNames) {
      expect(
        graph,
        `${name} leaked into a vNext declaration graph`,
      ).not.toMatch(new RegExp(`\\b${name}\\b`));
    }
  });

  it("keeps vendor modules out of the complete vNext declaration graph", async () => {
    const graph = (
      await Promise.all([
        readDeclarationGraph("dist/index.d.ts"),
        readDeclarationGraph("dist/plugin.d.ts"),
        readDeclarationGraph("dist/testing.d.ts"),
      ])
    ).join("\n");
    const moduleSpecifiers = [
      ...graph.matchAll(/(?:from\s+|import\()["']([^"']+)["']/g),
    ].map((match) => match[1]!);

    expect(moduleSpecifiers.length).toBeGreaterThan(0);
    expect(
      moduleSpecifiers.filter((specifier) => !specifier.startsWith(".")),
    ).toEqual([]);
  });
});
