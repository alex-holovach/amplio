import { describe, expect, it } from "vitest";
import { z } from "zod";
import { event, init, type SinkRecord } from "../src/index.js";
import { plugin } from "../src/plugin.js";

const EmailSend = event({
  id: "resend.send",
  version: 1,
  schema: z.object({
    template: z.string(),
    provider: z.literal("resend"),
  }),
  timing: "duration",
  cardinality: { many: { max: 4 } },
});

const ResendPlugin = plugin({
  id: "resend",
  events: { sends: EmailSend },
  instrument({ events, observe }) {
    return function instrumentSend<
      F extends (input: { template: { id: string } }) => { id: string },
    >(send: F): F {
      return observe(events.sends, send, {
        input: ({ args: [input] }) => ({
          template: input.template.id,
          provider: "resend",
        }),
      });
    };
  },
});

const HttpRequest = event({
  id: "http.request",
  version: 1,
  schema: z.object({ request_id: z.string() }),
  tree: {
    email: ResendPlugin.events,
  },
});

describe("Plugin public runtime", () => {
  it("contributes a mounted provider observation to the active Event", () => {
    const delivered: SinkRecord[] = [];
    init({
      service: "orders-api",
      env: "test",
      sinks: [(record) => delivered.push(record)],
    });

    const providerResult = { id: "email_1" };
    const send = ResendPlugin((_input) => providerResult);

    const handleRequest = HttpRequest.handle(
      () =>
        send({
          template: { id: "order_confirmation" },
        }),
      { input: () => ({ request_id: "req_1" }) },
    );

    expect(handleRequest()).toBe(providerResult);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      "@event": "http.request",
      "@event_version": 1,
      request_id: "req_1",
      success: true,
      email: {
        sends: [
          {
            template: "order_confirmation",
            provider: "resend",
            duration_ms: expect.any(Number),
            success: true,
          },
        ],
      },
    });
  });
});
