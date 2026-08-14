import { event } from "@useamplio/amplio";
import { z } from "zod";

export const PageRender = event({
  id: "page.render",
  version: 1,
  schema: z.object({
    page: z.object({ name: z.string() }),
  }),
});
