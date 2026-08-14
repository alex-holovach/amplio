import { bench, describe } from "vitest";
import { z } from "zod";
import { event, init } from "../src/index.js";

const noop: (record: Record<string, unknown>) => void = () => {};

init({
  service: "bench",
  env: "test",
  sinks: [noop],
  sampling: { rate: 1 },
});

const Checkout = event({
  id: "checkout.completed",
  version: 1,
  schema: z.object({ order_id: z.string(), total: z.number() }),
});

const recordCheckout = Checkout.handle(
  (order_id: string, total: number) => ({ order_id, total }),
  {
    input: ({ args: [order_id, total] }) => ({ order_id, total }),
  },
);

describe("semantic event", () => {
  bench("handle() + project + finalize", () => {
    recordCheckout("ord_1", 42);
  });
});
