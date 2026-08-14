import { event } from "@useamplio/amplio";
import { plugin } from "@useamplio/amplio/plugin";
import { z } from "zod";
import type {
  Order,
  PlaceOrderDependencies,
} from "../domain/place-order.js";

const UserLoad = event({
  id: "database.user.load",
  version: 1,
  schema: z.object({
    user_id: z.string(),
    plan: z.enum(["free", "pro"]).optional(),
    found: z.boolean().optional(),
  }),
  timing: "duration",
});

const PaymentCharge = event({
  id: "payment.charge",
  version: 1,
  schema: z.object({
    user_id: z.string(),
    total_cents: z.number().int(),
    payment_id: z.string().optional(),
    decline_code: z.string().optional(),
  }),
  timing: "duration",
  cardinality: { many: { max: 2 } },
});

const OrderSave = event({
  id: "database.order.save",
  version: 1,
  schema: z.object({
    user_id: z.string(),
    total_cents: z.number().int(),
    order_id: z.string().optional(),
  }),
  timing: "duration",
});

export const PlaceOrderPlugin = plugin({
  id: "place-order-dependencies",
  events: {
    user_load: UserLoad,
    payment_attempts: PaymentCharge,
    order_save: OrderSave,
  },
  instrument({ events, observe }) {
    return function instrumentDependencies(
      dependencies: PlaceOrderDependencies,
    ): PlaceOrderDependencies {
      return {
        loadUser: observe(events.user_load, dependencies.loadUser, {
          input: ({ args: [id] }) => ({ user_id: id }),
          result: ({ result }) => ({ found: true, plan: result.plan }),
        }),
        charge: observe(events.payment_attempts, dependencies.charge, {
          input: ({ args: [input] }) => ({
            user_id: input.userId,
            total_cents: input.totalCents,
          }),
          result: ({ result }) => ({ payment_id: result.id }),
          error: ({ error }) => ({
            decline_code:
              error instanceof Error && "code" in error
                ? String((error as Error & { code: unknown }).code)
                : "unknown",
          }),
        }),
        saveOrder: observe(events.order_save, dependencies.saveOrder, {
          input: ({ args: [input] }) => ({
            user_id: input.userId,
            total_cents: input.totalCents,
          }),
          result: ({ result }) => ({ order_id: result.id }),
        }),
      };
    };
  },
});

export const PlaceOrder = event({
  id: "api.order.place",
  version: 1,
  schema: z.object({}),
  tree: {
    dependencies: PlaceOrderPlugin.events,
  },
});

export const instrumentDependencies = PlaceOrderPlugin;

export function observePlaceOrderRoute<
  TRequest,
  TResult,
  THandler extends (request: TRequest) => TResult | Promise<TResult>,
>(handler: THandler): THandler {
  return PlaceOrder.handle(handler);
}

export type { Order };
