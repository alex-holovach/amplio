import { execFileSync } from "node:child_process";
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { valid } from "semver";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const REQUIRED_BASE_ITEMS = [
  "event-http-request",
  "plugin-hono",
  "plugin-express",
  "plugin-fastify",
  "plugin-next",
  "plugin-trpc",
  "plugin-better-auth",
  "plugin-ai-sdk",
  "plugin-resend",
  "runtime",
  "sink-console",
  "sink-json",
  "sink-otlp",
  "enricher-service-metadata",
] as const;

type RegistryManifest = {
  items: Array<{
    name: string;
    kind: "event" | "plugin" | "runtime" | "sink" | "enricher";
    recipeVersion: string;
    privacy?: {
      includes?: string[];
      excludes?: string[];
    };
    devDependencies?: string[];
    events?: Array<{
      id: string;
      version: number;
      semanticDigest?: string;
    }>;
    nativeTransform?: { version?: number; digest?: string };
  }>;
};

async function readManifest(): Promise<RegistryManifest> {
  return JSON.parse(
    await readFile(
      path.join(repoRoot, "registry/registry.manifest.json"),
      "utf8",
    ),
  ) as RegistryManifest;
}

async function listFiles(root: string, relative = ""): Promise<string[]> {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const child = path.join(relative, entry.name);
      return entry.isDirectory() ? listFiles(root, child) : [child];
    }),
  );
  return files.flat().sort();
}

describe("vNext registry build", () => {
  beforeAll(() => {
    execFileSync("node", ["scripts/build-registry.mjs"], {
      cwd: repoRoot,
      stdio: "pipe",
    });
  });

  it("publishes only Event, Plugin, runtime, sink, and enricher items", async () => {
    const manifest = await readManifest();
    const expectedItems = manifest.items.map((item) => item.name);
    const registryPath = path.join(repoRoot, "public/r/registry.json");
    await access(registryPath);

    const registry = JSON.parse(await readFile(registryPath, "utf8")) as {
      $schema: string;
      items: Array<{
        name: string;
        type: string;
        title: string;
        description: string;
      }>;
    };
    expect(registry.$schema).toBe("https://ui.shadcn.com/schema/registry.json");
    expect(registry.items.map((item) => item.name)).toEqual(expectedItems);
    expect(expectedItems).toEqual(
      expect.arrayContaining([...REQUIRED_BASE_ITEMS]),
    );

    for (const item of registry.items) {
      expect(item.type).toBe("registry:lib");
      expect(item.title.trim(), `${item.name} title`).not.toBe("");
      expect(item.description.trim(), `${item.name} description`).not.toBe("");
    }

    for (const item of manifest.items) {
      expect(typeof item.recipeVersion, `${item.name} recipeVersion type`).toBe(
        "string",
      );
      expect(
        valid(item.recipeVersion),
        `${item.name} recipeVersion SemVer`,
      ).toBe(item.recipeVersion);
      expect(item.name, `${item.name} registry vocabulary`).toMatch(
        /^(?:event|plugin|sink|enricher)-|^runtime$/,
      );
      expect(item.kind, `${item.name} manifest kind`).toMatch(
        /^(?:event|plugin|runtime|sink|enricher)$/,
      );
    }

    const jsonFiles = (await readdir(path.join(repoRoot, "public/r")))
      .filter((name) => name.endsWith(".json"))
      .sort();
    expect(jsonFiles).toEqual(
      [...expectedItems.map((name) => `${name}.json`), "registry.json"].sort(),
    );
  });

  it("embeds editable Event and Plugin source at canonical telemetry targets", async () => {
    const rootEvent = JSON.parse(
      await readFile(
        path.join(repoRoot, "public/r/event-http-request.json"),
        "utf8",
      ),
    );
    expect(rootEvent.title).toBe("HTTP Request Event");
    expect(rootEvent.files?.[0]?.target).toBe(
      "~/telemetry/events/http-request.ts",
    );
    expect(rootEvent.files?.[0]?.content).toContain('id: "http.request"');
    expect(rootEvent.files?.[0]?.content).toContain("// amplio:plugins");

    const resend = JSON.parse(
      await readFile(
        path.join(repoRoot, "public/r/plugin-resend.json"),
        "utf8",
      ),
    );
    expect(resend.title).toBe("Resend Plugin");
    expect(resend.files?.[0]?.target).toBe("~/telemetry/plugins/resend.ts");
    expect(resend.files?.[0]?.content).toContain(
      'from "@useamplio/amplio/plugin"',
    );
    expect(resend.files?.[0]?.content).toContain("export const ResendPlugin");

    const aiSdk = JSON.parse(
      await readFile(
        path.join(repoRoot, "public/r/plugin-ai-sdk.json"),
        "utf8",
      ),
    );
    expect(aiSdk.title).toBe("AI SDK Plugin");
    expect(aiSdk.files?.[0]?.target).toBe("~/telemetry/plugins/ai-sdk.ts");
    expect(aiSdk.files?.[0]?.content).toContain("export const AiSdkPlugin");
    expect(aiSdk.files?.[0]?.content).toContain('id: "ai.operation"');
    expect(aiSdk.files?.[0]?.content).toContain("version: 2");
    expect(aiSdk.files?.[0]?.content).toContain("model_family");
    expect(aiSdk.files?.[0]?.content).toContain("MAX_AGGREGATE_COUNT");
    expect(aiSdk.files?.[0]?.content).not.toContain("call_id");
    expect(aiSdk.meta?.amplio).toMatchObject({
      recipeVersion: "1.1.0",
      events: [
        {
          id: "ai.operation",
          version: 2,
          semanticDigest: expect.stringMatching(/^sha256-[a-f0-9]{64}$/),
        },
      ],
      nativeTransform: {
        version: 2,
        digest: expect.stringMatching(/^sha256-[a-f0-9]{64}$/),
      },
      privacy: {
        includes: expect.arrayContaining([
          expect.stringMatching(/provider/u),
          expect.stringMatching(/model family/u),
        ]),
        excludes: expect.arrayContaining([
          "prompts",
          "messages",
          "generated content",
          "raw errors",
        ]),
      },
    });
  });

  it("publishes the hardened HTTP, Next, and OTLP contracts", async () => {
    const readSource = async (name: string): Promise<string> => {
      const item = JSON.parse(
        await readFile(path.join(repoRoot, "public/r", `${name}.json`), "utf8"),
      ) as { files?: Array<{ content?: string }> };
      return item.files?.[0]?.content ?? "";
    };

    const http = await readSource("event-http-request");
    expect(http).toContain("/^[A-Za-z0-9_-]{1,128}$/.test(value)");
    expect(http).not.toContain("value.trim()");

    const hono = await readSource("plugin-hono");
    expect(hono).not.toContain("context.res?.status >= 400");
    expect(hono).not.toContain(": 500");

    const next = await readSource("plugin-next");
    expect(next).toContain("route: string");
    expect(next).toContain("handler: F");
    expect(next).not.toContain("routeOrHandler");

    const otlp = await readSource("sink-otlp");
    expect(otlp).toContain('"http.status"');
    expect(otlp).toContain('"rpc.procedures"');
    expect(otlp).toContain("record.resource");
    expect(otlp).toContain('warnExportFailure("network_error")');
    expect(otlp).not.toContain("error.message");
    expect(otlp).not.toContain("String(error)");
    expect(otlp).not.toContain('"http.path"');
    expect(otlp).not.toContain('"trpc.path"');
  });

  it("pins runtime dependencies and prefixes registry dependencies", async () => {
    const rootPkg = JSON.parse(
      await readFile(path.join(repoRoot, "package.json"), "utf8"),
    );
    const hono = JSON.parse(
      await readFile(path.join(repoRoot, "public/r/plugin-hono.json"), "utf8"),
    );

    expect(hono.dependencies).toContain(
      `@useamplio/amplio@^${rootPkg.version}`,
    );
    expect(hono.dependencies).toContain("hono@^4.7.4");
    expect(hono.registryDependencies).toEqual([
      "@useamplio/event-http-request",
      "@useamplio/runtime",
    ]);
    expect(hono.devDependencies).toBeUndefined();
  });

  it("keeps provider and type dependencies on the Plugin that imports them", async () => {
    const rootPkg = JSON.parse(
      await readFile(path.join(repoRoot, "package.json"), "utf8"),
    );
    const core = `@useamplio/amplio@^${rootPkg.version}`;
    const httpEvent = JSON.parse(
      await readFile(
        path.join(repoRoot, "public/r/event-http-request.json"),
        "utf8",
      ),
    );
    const trpcPlugin = JSON.parse(
      await readFile(path.join(repoRoot, "public/r/plugin-trpc.json"), "utf8"),
    );
    const expressPlugin = JSON.parse(
      await readFile(
        path.join(repoRoot, "public/r/plugin-express.json"),
        "utf8",
      ),
    );

    expect(httpEvent.dependencies).toEqual(["zod", core]);
    expect(httpEvent.devDependencies).toBeUndefined();
    expect(trpcPlugin.dependencies).toEqual([
      "zod",
      core,
      "@trpc/server@^11.0.0",
    ]);
    expect(expressPlugin.devDependencies).toEqual(["@types/express@^5.0.0"]);
  });

  it("ships every Plugin as editable source at the canonical target", async () => {
    const manifest = await readManifest();
    for (const manifestItem of manifest.items.filter(
      (item) => item.kind === "plugin",
    )) {
      const { name } = manifestItem;
      const item = JSON.parse(
        await readFile(path.join(repoRoot, "public/r", `${name}.json`), "utf8"),
      );
      expect(item.title, name).toMatch(/ Plugin$/);
      expect(item.files?.[0]?.target, name).toMatch(
        /^~\/telemetry\/plugins\/[a-z0-9-]+\.ts$/,
      );
      expect(item.files?.[0]?.content?.trim(), name).not.toBe("");
      expect(item.devDependencies, name).toEqual(manifestItem.devDependencies);
    }
  });

  it("documents an explicit privacy boundary for every Plugin", async () => {
    const manifest = await readManifest();

    for (const item of manifest.items.filter(
      (candidate) => candidate.kind === "plugin",
    )) {
      expect(
        item.privacy?.includes?.length,
        `${item.name} privacy includes`,
      ).toBeGreaterThan(0);
      expect(
        item.privacy?.excludes?.length,
        `${item.name} privacy excludes`,
      ).toBeGreaterThan(0);
    }
  });

  it("publishes derived semantic and explicit native transform contracts for every Plugin", async () => {
    const manifest = await readManifest();

    for (const item of manifest.items.filter(
      (candidate) => candidate.kind === "plugin",
    )) {
      expect(
        item.nativeTransform?.version,
        `${item.name} native version`,
      ).toEqual(expect.any(Number));
      expect(
        item.nativeTransform?.version,
        `${item.name} positive native version`,
      ).toBeGreaterThan(0);
      const generated = JSON.parse(
        await readFile(
          path.join(repoRoot, "public/r", `${item.name}.json`),
          "utf8",
        ),
      ) as {
        meta?: {
          amplio?: {
            semanticDigest?: string;
            events?: Array<{ semanticDigest?: string }>;
            nativeTransform?: { version?: number; digest?: string };
          };
        };
      };
      const metadata = generated.meta?.amplio;
      expect(metadata?.semanticDigest, `${item.name} semantic digest`).toMatch(
        /^sha256-[a-f0-9]{64}$/,
      );
      expect(metadata?.events, `${item.name} Event contracts`).toHaveLength(
        item.events?.length,
      );
      for (const event of metadata?.events ?? []) {
        expect(
          event.semanticDigest,
          `${item.name} Event semantic digest`,
        ).toMatch(/^sha256-[a-f0-9]{64}$/);
      }
      expect(
        metadata?.nativeTransform,
        `${item.name} native transform`,
      ).toEqual({
        version: item.nativeTransform?.version,
        digest: expect.stringMatching(/^sha256-[a-f0-9]{64}$/),
      });
    }
  });

  it("teaches only the Event and Plugin installation model", async () => {
    const registryIndex = await readFile(
      path.join(repoRoot, "public/r/index.html"),
      "utf8",
    );
    const rootIndex = await readFile(
      path.join(repoRoot, "public/index.html"),
      "utf8",
    );
    const notFound = await readFile(
      path.join(repoRoot, "public/404.html"),
      "utf8",
    );
    const help = `${rootIndex}\n${registryIndex}\n${notFound}`;

    expect(rootIndex).toBe(registryIndex);
    expect(help).toContain("add event &lt;event-id&gt;");
    expect(help).toContain("add plugin &lt;name&gt; --event &lt;event-id&gt;");
    expect(help).toContain("copies open-code source only");
    expect(help).not.toMatch(/add component|doctor --fix/i);
    expect(help).not.toMatch(
      /add (?:integration|workload|middleware)|@useamplio\/(?:integration|workload|middleware)-/i,
    );
  });

  it("keeps the website registry byte-identical to the canonical artifacts", async () => {
    const canonicalRoot = path.join(repoRoot, "public/r");
    const websiteRoot = path.join(repoRoot, "apps/www/public/r");
    const canonicalFiles = await listFiles(canonicalRoot);
    const websiteFiles = await listFiles(websiteRoot);

    expect(websiteFiles).toEqual(canonicalFiles);
    for (const relative of canonicalFiles) {
      const canonical = await readFile(path.join(canonicalRoot, relative));
      const website = await readFile(path.join(websiteRoot, relative));
      expect(Buffer.compare(website, canonical), relative).toBe(0);
    }
  });
});
