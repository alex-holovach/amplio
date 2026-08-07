import { logger } from "../logger";
import { PaymentOrderPaid } from "../events/payment/order-paid";

type PolarOrderData = {
  id: string;
  checkout_id?: string | null;
  checkoutId?: string | null;
  total_amount?: number;
  totalAmount?: number;
  currency: string;
  customer?: {
    id: string;
    email?: string | null;
  };
  customer_id?: string;
  customerId?: string;
};

type PolarCheckoutData = {
  id: string;
  status: string;
  total_amount?: number;
  totalAmount?: number;
  currency: string;
  customer_id?: string | null;
  customerId?: string | null;
  customer_email?: string | null;
  customerEmail?: string | null;
};

export type PolarWebhookEvent =
  | { type: "order.paid"; data: PolarOrderData }
  | { type: "checkout.updated"; data: PolarCheckoutData };

export function trackPolarOrderPaid(input: {
  checkout: { id: string; amount: number; currency: string };
  customer: { id: string; email?: string };
  method?: "card" | "bank" | "wallet" | "other";
}) {
  return logger
    .event(PaymentOrderPaid)
    .set({
      order: {
        id: input.checkout.id,
        currency: input.checkout.currency.toUpperCase(),
        amount_cents: input.checkout.amount,
      },
      customer: {
        id: input.customer.id,
        ...(input.customer.email ? { email: input.customer.email } : {}),
      },
      payment: {
        provider: "polar",
        ...(input.method ? { method: input.method } : {}),
      },
    })
    .emit();
}

function readAmount(data: { total_amount?: number; totalAmount?: number }): number {
  return data.totalAmount ?? data.total_amount ?? 0;
}

function mapPolarOrderPaid(data: PolarOrderData) {
  const customerId = data.customer?.id ?? data.customerId ?? data.customer_id;
  if (!customerId) {
    return undefined;
  }
  const checkoutId = data.checkoutId ?? data.checkout_id ?? data.id;
  return trackPolarOrderPaid({
    checkout: {
      id: checkoutId,
      amount: readAmount(data),
      currency: data.currency,
    },
    customer: {
      id: customerId,
      ...(data.customer?.email ? { email: data.customer.email } : {}),
    },
  });
}

function mapPolarCheckoutPaid(data: PolarCheckoutData) {
  const customerId = data.customerId ?? data.customer_id;
  if (!customerId) {
    return undefined;
  }
  const customerEmail = data.customerEmail ?? data.customer_email;
  return trackPolarOrderPaid({
    checkout: {
      id: data.id,
      amount: readAmount(data),
      currency: data.currency,
    },
    customer: {
      id: customerId,
      ...(customerEmail ? { email: customerEmail } : {}),
    },
  });
}

export function handlePolarWebhook(event: PolarWebhookEvent) {
  switch (event.type) {
    case "order.paid":
      return mapPolarOrderPaid(event.data);
    case "checkout.updated":
      if (event.data.status !== "paid") {
        return undefined;
      }
      return mapPolarCheckoutPaid(event.data);
    default:
      return undefined;
  }
}
