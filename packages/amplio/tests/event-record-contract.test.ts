import { execFileSync } from "node:child_process";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { event, init, type SinkRecord } from "../src/index.js";
import { resetConfigForTests } from "../src/legacy.js";
import { plugin } from "../src/plugin.js";

const packageRoot = path.resolve(import.meta.dirname, "..");
const typeFixtureConfig = path.join(
  packageRoot,
  "tests/fixtures/event-record-contract/tsconfig.json",
);

beforeEach(() => {
  resetConfigForTests();
});

describe("EventRecord public contract", () => {
  it("keeps runtime and mounted Plugin fields authoritative in strict consumer types", () => {
    execFileSync("pnpm", ["exec", "tsc", "-p", typeFixtureConfig], {
      cwd: packageRoot,
      env: { ...process.env, FORCE_COLOR: "0" },
      stdio: "pipe",
    });
  });

  it("delivers runtime envelope and mounted Plugin values over colliding schema output", () => {
    const ProviderEntry = event({
      id: "provider.collision_entry",
      version: 1,
      schema: z.object({ value: z.string() }),
      timing: "instant",
    });
    const ProviderPlugin = plugin({
      id: "collision-provider",
      events: { entry: ProviderEntry },
      instrument({ events, record }) {
        return (value: string): void => record(events.entry, { value });
      },
    });
    const CollisionRoot = event({
      id: "contract.runtime_collision",
      version: 1,
      schema: z.object({ semantic: z.string() }).transform((value) => ({
        ...value,
        service: "schema-service" as const,
        provider: "schema-provider" as const,
      })),
      tree: { provider: ProviderPlugin.events },
    });
    const delivered: SinkRecord[] = [];
    init({
      service: "runtime-service",
      env: "test",
      sinks: [(record) => delivered.push(record)],
    });

    const run = CollisionRoot.handle(
      () => ProviderPlugin("runtime-provider-value"),
      { input: () => ({ semantic: "safe" }) },
    );

    expect(run()).toBeUndefined();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      "@event": "contract.runtime_collision",
      service: "runtime-service",
      semantic: "safe",
      provider: { entry: { value: "runtime-provider-value" } },
    });
    expect(JSON.stringify(delivered[0])).not.toContain("schema-service");
    expect(JSON.stringify(delivered[0])).not.toContain("schema-provider");
  });

  it("drops non-finite schema output instead of delivering a value outside EventRecord", () => {
    const NonFinite = event({
      id: "contract.non_finite_output",
      version: 1,
      schema: z
        .object({ raw: z.number() })
        .transform(() => ({ value: Number.POSITIVE_INFINITY })),
    });
    const delivered: SinkRecord[] = [];
    init({
      service: "runtime-service",
      env: "test",
      sinks: [(record) => delivered.push(record)],
    });

    const result = { ok: true };
    const run = NonFinite.handle(() => result, {
      input: () => ({ raw: 1 }),
    });

    expect(run()).toBe(result);
    expect(delivered).toEqual([]);
  });
});
