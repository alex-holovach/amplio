import type { PlaceOrderInput } from "../domain/place-order.js";

export interface PlaceOrderResult {
  order: { id: string; totalCents: number };
}

export function createPlaceOrderRoute(dependencies: {
  placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult>;
}) {
  return async function post(request: { json(): Promise<PlaceOrderInput> }) {
    const result = await dependencies.placeOrder(await request.json());

    return {
      body: result.order,
      status: 201,
    };
  };
}
