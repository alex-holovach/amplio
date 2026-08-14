import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hydrateRegistryPluginContracts } from "../src/registry/plugin-contracts.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const resendSource = await readFile(
  path.join(repoRoot, "registry/plugins/resend.ts"),
  "utf8",
);

function contract(source: string) {
  return hydrateRegistryPluginContracts([
    {
      name: "plugin-resend",
      kind: "plugin",
      role: "contributor",
      placement: { branch: "email" },
      provider: {
        package: "resend",
        instrumenter: "ResendPlugin",
        seam: "constructor",
        constructor: "Resend",
      },
      wiringActions: [
        { type: "wrap-constructor" },
        { type: "mount-event-subtree" },
      ],
      events: [{ id: "resend.send", version: 1 }],
      nativeTransform: { version: 1 },
      files: [{ path: "registry/plugins/resend.ts", content: source }],
    },
  ])[0] as {
    semanticDigest: string;
    events: Array<{ semanticDigest: string }>;
    nativeTransform: { version: number; digest: string };
  };
}

describe("registry Plugin contract derivation", () => {
  it.each([
    [
      "schema",
      resendSource.replace("z.string().optional()", "z.number().optional()"),
    ],
    [
      "Event tree",
      resendSource.replace(
        "events: { sends: ResendSend }",
        "events: { deliveries: ResendSend }",
      ),
    ],
    ["timing", resendSource.replace('timing: "duration"', 'timing: "point"')],
    ["cardinality", resendSource.replace("max: 16", "max: 32")],
  ])(
    "detects a %s semantic change without misclassifying it as native",
    (_field, changedSource) => {
      const installed = contract(resendSource);
      const changed = contract(changedSource);

      expect(changed.semanticDigest).not.toBe(installed.semanticDigest);
      expect(changed.events[0]?.semanticDigest).not.toBe(
        installed.events[0]?.semanticDigest,
      );
      expect(changed.nativeTransform).toEqual(installed.nativeTransform);
    },
  );

  it("ignores comments and formatting while retaining semantic tokens", () => {
    const reformatted = resendSource
      .replace("schema: z.object({", "schema: z.object(  {\n    // schema note")
      .replace("  }),\n  timing", "    }  ),\n  timing");

    const installed = contract(resendSource);
    const changed = contract(reformatted);
    expect(changed.semanticDigest).toBe(installed.semanticDigest);
    expect(changed.events).toEqual(installed.events);
    expect(changed.nativeTransform).toEqual(installed.nativeTransform);
  });

  it("fails closed for a dynamic Event semantic spread", () => {
    const dynamic = resendSource.replace(
      'id: "resend.send",',
      '...dynamicContract,\n  id: "resend.send",',
    );

    expect(() => contract(dynamic)).toThrow(
      /unsupported spread in semantic metadata.*No files were changed/i,
    );
  });
});
