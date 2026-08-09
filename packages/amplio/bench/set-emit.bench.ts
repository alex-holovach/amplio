import { bench, describe } from "vitest";
import { init, createLogger, defineEvent } from "../src/index.js";

const noop: (record: Record<string, unknown>) => void = () => {};

init({
  service: "bench",
  env: "test",
  sinks: [noop],
  sampling: { rate: 1 },
});

const checkout = defineEvent("checkout.completed", undefined, { skipValidation: true });

describe("logger set+emit", () => {
  bench("create().set().emit()", () => {
    createLogger()
      .set({ request_id: "req_bench", status: 200 })
      .emit();
  });

  bench("event().set().emit()", () => {
    createLogger()
      .event(checkout)
      .set({ order_id: "ord_1", total: 42 })
      .emit();
  });
});
