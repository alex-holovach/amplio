export interface PlaceOrderInput {
  userId: string;
  totalCents: number;
}

export interface User {
  id: string;
  plan: "free" | "pro";
}

export interface Order {
  id: string;
  userId: string;
  totalCents: number;
}

export interface PlaceOrderDependencies {
  loadUser(id: string): Promise<User>;
  charge(input: {
    userId: string;
    totalCents: number;
  }): Promise<{ id: string }>;
  saveOrder(input: Omit<Order, "id">): Promise<Order>;
}

export function createPlaceOrder(dependencies: PlaceOrderDependencies) {
  return async function placeOrder(input: PlaceOrderInput) {
    const user = await dependencies.loadUser(input.userId);
    const payment = await dependencies.charge({
      userId: user.id,
      totalCents: input.totalCents,
    });
    const order = await dependencies.saveOrder({
      userId: user.id,
      totalCents: input.totalCents,
    });

    return { order, payment, user };
  };
}
