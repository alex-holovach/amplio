import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const fixtureRoot = path.resolve(
  import.meta.dirname,
  "fixtures/no-logger-consumer",
);

function typescriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return typescriptFiles(absolute);
    return entry.isFile() && entry.name.endsWith(".ts") ? [absolute] : [];
  });
}

const forbiddenApplicationSyntax = [
  /@useamplio\//,
  /logger/i,
  /\bgetLogger\b/,
  /\buseLogger\b/,
  /\.set\s*\(/,
  /\.emit\s*\(/,
  /\.capture\s*\(/,
  /\.observe\s*\(/,
  /\.handle\s*\(/,
] as const;

describe("no-logger consumer source", () => {
  it("keeps observability machinery out of application and domain call sites", () => {
    const applicationFiles = ["app", "domain"].flatMap((directory) =>
      typescriptFiles(path.join(fixtureRoot, directory)),
    );

    expect(applicationFiles.length).toBeGreaterThanOrEqual(2);

    for (const file of applicationFiles) {
      const source = readFileSync(file, "utf8");
      for (const forbidden of forbiddenApplicationSyntax) {
        expect(
          source,
          `${path.relative(fixtureRoot, file)} contains ${forbidden}`,
        ).not.toMatch(forbidden);
      }
    }
  });

  it("keeps the runtime dependency inside editable telemetry code", () => {
    const telemetryFiles = typescriptFiles(path.join(fixtureRoot, "telemetry"));
    const telemetrySource = telemetryFiles
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");

    expect(telemetryFiles.length).toBeGreaterThanOrEqual(1);
    expect(telemetrySource).toContain('from "@useamplio/amplio"');
  });

  it("initializes by side effect without exporting a logger object", () => {
    const source = readFileSync(
      path.join(fixtureRoot, "telemetry/init.ts"),
      "utf8",
    );

    expect(source).toMatch(/\binit\s*\(/);
    expect(source).not.toMatch(
      /export\s+(?:const|let|var|\{)[^\n]*\blogger\b/i,
    );
  });
});
