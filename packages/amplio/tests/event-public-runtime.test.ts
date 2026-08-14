import { describe, expect, it } from "vitest";
import { z } from "zod";
import { event, init, type SinkRecord } from "../src/index.js";

const HttpRequest = event({
  id: "http.request",
  version: 1,
  schema: z.object({
    request_id: z.string(),
    http: z.object({
      method: z.string(),
      route: z.string(),
      status: z.number().int(),
    }),
  }),
});

describe("Event public runtime", () => {
  it("turns one ordinary handler invocation into one canonical Event record", () => {
    const delivered: SinkRecord[] = [];

    init({
      service: "orders-api",
      env: "test",
      sinks: [(record) => delivered.push(record)],
    });

    const response = { status: 201, body: { id: "ord_1" } };
    const owner = { prefix: "req" };

    const handler = HttpRequest.handle(
      function handleRequest(
        this: typeof owner,
        request: { id: string; method: string; route: string },
      ) {
        expect(this).toBe(owner);
        expect(request.id).toBe("01K2ORDER");
        return response;
      },
      {
        input: ({ args: [request] }) => ({
          request_id: `${owner.prefix}_${request.id}`,
          http: {
            method: request.method,
            route: request.route,
          },
        }),
        result: ({ result }) => ({
          http: { status: result.status },
        }),
        success: ({ result }) => result.status < 400,
      },
    );

    const result = handler.call(owner, {
      id: "01K2ORDER",
      method: "POST",
      route: "/api/orders",
    });

    expect(result).toBe(response);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toEqual({
      "@event": "http.request",
      "@event_version": 1,
      service: "orders-api",
      env: "test",
      timestamp: expect.any(String),
      request_id: "req_01K2ORDER",
      duration_ms: expect.any(Number),
      success: true,
      http: {
        method: "POST",
        route: "/api/orders",
        status: 201,
      },
    });
  });
});
