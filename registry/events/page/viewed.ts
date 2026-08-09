import { defineEvent } from "@useamplio/amplio";
import { z } from "zod";

export const PageViewed = defineEvent(
  "page.viewed",
  z.object({
    page: z.object({
      // Pathname only ("/pricing") — query strings carry PII; if you need a
      // param, add it as its own typed field instead.
      path: z.string(),
      title: z.string().optional(),
      referrer: z.string().optional(),
    }),
    visitor: z
      .object({
        // Authenticated user id or anonymous visitor id — whichever you have.
        id: z.string(),
        authenticated: z.boolean().optional(),
      })
      .optional(),
  }),
);
