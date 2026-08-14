import { event } from "@useamplio/amplio";
import { z } from "zod";
// amplio:plugin-imports

export const HttpRequest = event({
  id: "http.request",
  version: 1,
  schema: z.object({
    request_id: z.string(),
    http: z.object({
      method: z.string(),
      route: z.string().optional(),
      status: z.number().int().optional(),
    }),
  }),
  tree: {
    // amplio:plugins
  },
});

export function resolveRequestId(value: unknown): string {
  if (typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    return value;
  }
  return crypto.randomUUID();
}
