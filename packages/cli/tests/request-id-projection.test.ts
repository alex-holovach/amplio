import { describe, expect, it } from "vitest";
import { resolveRequestId as resolveRegistryRequestId } from "../../../registry/events/http-request.ts";
import { resolveRequestId as resolveBasicRequestId } from "../../../examples/basic/telemetry/events/http-request.ts";
import { resolveRequestId as resolveExpressRequestId } from "../../../examples/express-smoke/telemetry/events/http-request.ts";
import { resolveRequestId as resolveFastifyRequestId } from "../../../examples/fastify-smoke/telemetry/events/http-request.ts";
import { resolveRequestId as resolveNextRequestId } from "../../../examples/next-smoke/telemetry/events/http-request.ts";

const resolvers = [
  ["registry", resolveRegistryRequestId],
  ["basic example", resolveBasicRequestId],
  ["Express example", resolveExpressRequestId],
  ["Fastify example", resolveFastifyRequestId],
  ["Next example", resolveNextRequestId],
] as const;

describe.each(resolvers)(
  "%s request ID projection",
  (_name, resolveRequestId) => {
    it.each(["a", "request_ABC-123", "A".repeat(128)])(
      "preserves allowlisted value %j",
      (value) => {
        expect(resolveRequestId(value)).toBe(value);
      },
    );

    it.each([
      "",
      " request",
      "request ",
      "request/id",
      "request.id",
      "request:id",
      "request@example.com",
      "π",
      "A".repeat(129),
      "line\nbreak",
      "line\rbreak",
    ])("replaces hostile value %j before projection", (value) => {
      const resolved = resolveRequestId(value);

      expect(resolved).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
      expect(resolved).not.toBe(value);
    });
  },
);
