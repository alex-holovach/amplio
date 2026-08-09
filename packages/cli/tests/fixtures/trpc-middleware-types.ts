/**
 * Type-level contract: amplioTrpcMiddleware must plug into tRPC v11 without casts.
 */
import { initTRPC } from "@trpc/server";
import { amplioTrpcMiddleware } from "../../../../registry/middleware/trpc";

const t = initTRPC.create();
const middleware = amplioTrpcMiddleware();

// Must assign without `as` casts — enforced at compile time by tsc in registry-strict-typecheck.test.ts
const _viaMiddleware = t.middleware(middleware);
const _viaProcedure = t.procedure.use(middleware);

void _viaMiddleware;
void _viaProcedure;
