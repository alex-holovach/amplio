import { event } from "@useamplio/amplio";
import { plugin } from "@useamplio/amplio/plugin";
import { z } from "zod";

type TrpcProcedureType = "query" | "mutation" | "subscription";
type TrpcFailure = { ok: false; error: unknown };

const TrpcProcedure = event({
  id: "trpc.procedure",
  version: 1,
  schema: z.object({
    path: z.string(),
    type: z.enum(["query", "mutation"]),
  }),
  timing: "duration",
  cardinality: { many: { max: 64 } },
});

function isFailure(value: unknown): value is TrpcFailure {
  try {
    return (
      typeof value === "object" &&
      value !== null &&
      "ok" in value &&
      value.ok === false &&
      "error" in value
    );
  } catch {
    return false;
  }
}

export const TrpcPlugin = plugin({
  id: "trpc",
  events: { procedures: TrpcProcedure },
  instrument({ events, begin }) {
    return function trpcMiddleware() {
      return <Result>(options: {
        path: string;
        type: TrpcProcedureType;
        next: () => Promise<Result>;
      }): Promise<Result> => {
        // The middleware promise only represents subscription setup, not the
        // stream's lifetime. Preserve it exactly rather than claiming false
        // duration or completion semantics.
        if (options.type === "subscription") return options.next();

        const observation = begin(events.procedures, {
          path: options.path,
          type: options.type,
        });
        return observation.run(async () => {
          try {
            const result = await options.next();
            if (isFailure(result)) observation.fail(result.error);
            else observation.end();
            return result;
          } catch (error) {
            observation.fail(error);
            throw error;
          }
        });
      };
    };
  },
});
