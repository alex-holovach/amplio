import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  deriveComponentsJsonOptions,
  upsertComponentsJson,
} from "../src/utils/components-json.js";

const REGISTRY_URL = "https://amplio-ruddy.vercel.app/r/{name}.json";

async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

describe("components.json", () => {
  it("creates minimal config with empty aliases when no tsconfig paths", async () => {
    const cwd = await makeTempDir("amplio-components-minimal-");
    const config = await deriveComponentsJsonOptions(cwd, REGISTRY_URL);
    expect(config.$schema).toBe("https://ui.shadcn.com/schema.json");
    expect(config.style).toBe("new-york");
    expect(config.aliases).toEqual({});
    expect(config.tailwind.config).toBe("");
    expect(config.tailwind.css).toBe("");
    expect(config.registries["@useamplio"]).toBe(REGISTRY_URL);
    expect(config).not.toHaveProperty("rsc");
    expect(config).not.toHaveProperty("tsx");
  });

  it("derives aliases from tsconfig paths when present", async () => {
    const cwd = await makeTempDir("amplio-components-derive-");
    await writeFile(
      path.join(cwd, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          paths: { "~/*": ["./src/*"] },
        },
      }),
    );

    const config = await deriveComponentsJsonOptions(cwd, REGISTRY_URL);
    expect(config.aliases.components).toBe("~/components");
    expect(config.aliases.lib).toBe("~/lib");
  });

  it("merges @useamplio registry into existing components.json", async () => {
    const cwd = await makeTempDir("amplio-components-merge-");
    const existing = {
      style: "default",
      rsc: true,
      aliases: { components: "@/components" },
      registries: {},
    };
    await writeFile(path.join(cwd, "components.json"), `${JSON.stringify(existing, null, 2)}\n`);

    const result = await upsertComponentsJson(cwd, REGISTRY_URL);
    expect(result).toBe("updated");

    const merged = JSON.parse(await readFile(path.join(cwd, "components.json"), "utf8"));
    expect(merged.style).toBe("default");
    expect(merged.rsc).toBe(true);
    expect(merged.registries["@useamplio"]).toBe(REGISTRY_URL);
  });

  it("skips when @useamplio registry already matches", async () => {
    const cwd = await makeTempDir("amplio-components-skip-");
    await writeFile(
      path.join(cwd, "components.json"),
      JSON.stringify({ registries: { "@useamplio": REGISTRY_URL } }),
    );

    expect(await upsertComponentsJson(cwd, REGISTRY_URL)).toBe("skipped");
  });
});
