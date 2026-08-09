import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

describe("registry item metadata", () => {
  it("every public/r item has non-empty title and description", async () => {
    const registryDir = path.join(repoRoot, "public/r");
    const entries = await readdir(registryDir);
    const itemFiles = entries
      .filter((name) => name.endsWith(".json") && name !== "registry.json")
      .sort();

    expect(itemFiles.length).toBeGreaterThan(0);

    for (const fileName of itemFiles) {
      const filePath = path.join(registryDir, fileName);
      const item = JSON.parse(await readFile(filePath, "utf8")) as {
        name?: string;
        title?: unknown;
        description?: unknown;
      };

      expect(
        typeof item.title === "string" && item.title.trim().length > 0,
        `${fileName}: title must be a non-empty string`,
      ).toBe(true);

      expect(
        typeof item.description === "string" &&
          item.description.trim().length > 0,
        `${fileName}: description must be a non-empty string`,
      ).toBe(true);

      expect(
        !String(item.description).startsWith("amplio registry item:"),
        `${fileName}: description must not use the build fallback prefix`,
      ).toBe(true);
    }
  });

  it("generated titles follow naming rules", async () => {
    const expectations: Array<{ name: string; title: string }> = [
      { name: "sink-console", title: "Console Sink" },
      { name: "sink-json", title: "JSON Sink" },
      { name: "sink-otlp", title: "OTLP Sink" },
      { name: "middleware-hono", title: "Hono Middleware" },
      { name: "middleware-next", title: "Next.js Route Handler Wrapper" },
      { name: "enricher-request-metadata", title: "Request Metadata Enricher" },
      { name: "integration-resend", title: "Resend Integration" },
      { name: "event-auth-user-signed-up", title: "Auth User Signed Up" },
    ];

    for (const { name, title } of expectations) {
      const filePath = path.join(repoRoot, "public/r", `${name}.json`);
      const item = JSON.parse(await readFile(filePath, "utf8")) as {
        title?: string;
      };
      expect(item.title, `${name} title`).toBe(title);
    }
  });

    it("sink-console has a human description", async () => {
    const filePath = path.join(repoRoot, "public/r/sink-console.json");
    const item = JSON.parse(await readFile(filePath, "utf8")) as {
      description?: string;
    };

    expect(item.description).toBe(
      "Console sink that prints wide events as JSON.",
    );
    expect(item.description?.startsWith("amplio registry item:")).toBe(false);
  });
});
