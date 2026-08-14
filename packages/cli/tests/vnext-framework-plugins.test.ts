import { request as httpRequest } from "node:http";
import express from "express";
import Fastify from "fastify";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { event, flush, init } from "@useamplio/amplio";
import { createTestSink } from "@useamplio/amplio/testing";
import { z } from "zod";
import { HttpRequest } from "../../../registry/events/http-request.ts";
import { withAmplioRoute } from "../../../registry/plugins/express.ts";
import { FastifyPlugin } from "../../../registry/plugins/fastify.ts";
import { HonoPlugin } from "../../../registry/plugins/hono.ts";
import { withAmplio } from "../../../registry/plugins/next.ts";
import { TrpcPlugin } from "../../../registry/plugins/trpc.ts";

const openServers: Array<{ close: () => unknown }> = [];

afterEach(async () => {
  for (const server of openServers.splice(0)) {
    await server.close();
  }
  await flush({ timeoutMs: 1_000 });
});

describe("vNext framework Plugins", () => {
  it("classifies Hono's final handled-error Response", async () => {
    const sink = createTestSink();
    init({ service: "hono-test", env: "test", sinks: [sink] });
    const app = new Hono();
    app.use("*", HonoPlugin());
    app.onError((_error, context) => context.json({ error: "handled" }, 418));
    app.get("/failure", () => {
      throw new Error("private application detail");
    });

    const response = await app.request(
      "/failure?token=never-record-me",
      undefined,
      { incoming: true },
    );
    expect(response.status).toBe(418);

    const record = sink.single(HttpRequest);
    expect(record.http).toEqual({
      method: "GET",
      route: "/failure",
      status: 418,
    });
    expect(record.success).toBe(false);
    expect(JSON.stringify(record)).not.toContain("never-record-me");
    expect(JSON.stringify(record)).not.toContain("private application detail");
  });

  it("does not invent an HTTP status when Hono's middleware chain rejects", async () => {
    const sink = createTestSink();
    init({ service: "hono-test", env: "test", sinks: [sink] });
    const original = new Error("private application detail");
    const context = {
      req: {
        header: () => "request-hono-rejection",
        method: "GET",
        routePath: "/failure",
      },
      res: new Response(null, { status: 200 }),
    };

    await expect(
      HonoPlugin()(context as never, async () => {
        throw original;
      }),
    ).rejects.toBe(original);

    const record = sink.single(HttpRequest);
    expect(record.http).toEqual({ method: "GET", route: "/failure" });
    expect(record.success).toBe(false);
    expect(record.error).toEqual({ type: "Error" });
    expect(JSON.stringify(record)).not.toContain("private application detail");
  });

  it("rejects a hostile incoming request ID before it enters a Hono Event", async () => {
    const sink = createTestSink();
    init({ service: "hono-test", env: "test", sinks: [sink] });
    const app = new Hono();
    app.use("*", HonoPlugin());
    app.get("/health", (context) => context.json({ ok: true }));

    const hostileRequestId = "customer@example.com/orders?token=private";
    const response = await app.request("/health", {
      headers: { "x-request-id": hostileRequestId },
    });
    expect(response.status).toBe(200);

    const record = sink.single(HttpRequest);
    expect(record.request_id).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    expect(record.request_id).not.toBe(hostileRequestId);
    expect(JSON.stringify(record)).not.toContain(hostileRequestId);
  });

  it("keeps an Express Event open through callback handlers and final response", async () => {
    const sink = createTestSink();
    init({ service: "express-test", env: "test", sinks: [sink] });
    const app = express();

    app.get(
      "/orders/:id",
      ...withAmplioRoute("orders.show", (_request, response) => {
        setTimeout(() => response.status(503).json({ ok: false }), 25);
      }),
    );

    const server = app.listen(0, "127.0.0.1");
    openServers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("missing address");

    const response = await fetch(
      `http://127.0.0.1:${address.port}/orders/ord_1?token=never-record-me`,
      { headers: { "x-request-id": "request-express" } },
    );
    expect(response.status).toBe(503);

    const record = sink.single(HttpRequest);
    expect(record.request_id).toBe("request-express");
    expect(record.http).toEqual({
      method: "GET",
      route: "orders.show",
      status: 503,
    });
    expect(record.success).toBe(false);
    expect(record.duration_ms).toBeGreaterThanOrEqual(20);
    expect(JSON.stringify(record)).not.toContain("never-record-me");
  });

  it("keeps preceding Express route middleware and next(error) in one Event", async () => {
    const sink = createTestSink();
    init({ service: "express-test", env: "test", sinks: [sink] });
    const app = express();
    const original = new Error("private express failure");

    app.get(
      "/orders/:id",
      ...withAmplioRoute(
        "orders.show",
        (_request, response, next) => {
          response.locals.started = true;
          setTimeout(next, 10);
        },
        (_request, response, next) => {
          expect(response.locals.started).toBe(true);
          next(original);
        },
      ),
    );
    app.use(
      (
        error: unknown,
        _request: express.Request,
        response: express.Response,
        _next: express.NextFunction,
      ) => {
        expect(error).toBe(original);
        response.status(502).json({ error: "handled" });
      },
    );

    const server = app.listen(0, "127.0.0.1");
    openServers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("missing address");

    const response = await fetch(
      `http://127.0.0.1:${address.port}/orders/ord_1`,
      { headers: { "x-request-id": "request-express-error" } },
    );
    expect(response.status).toBe(502);

    const record = sink.single(HttpRequest);
    expect(record.request_id).toBe("request-express-error");
    expect(record.http).toEqual({
      method: "GET",
      route: "orders.show",
      status: 502,
    });
    expect(record.success).toBe(false);
    expect(record.error).toEqual({ type: "Error" });
    expect(record.duration_ms).toBeGreaterThanOrEqual(8);
    expect(JSON.stringify(record)).not.toContain("private express failure");
  });

  it("closes an Express Event exactly once when the client disconnects", async () => {
    const sink = createTestSink();
    init({ service: "express-test", env: "test", sinks: [sink] });
    const app = express();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });

    app.get(
      "/stream",
      ...withAmplioRoute("orders.stream", (_request, response) => {
        markStarted();
        setTimeout(() => {
          if (!response.destroyed) response.end("late response");
        }, 40);
      }),
    );

    const server = app.listen(0, "127.0.0.1");
    openServers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("missing address");

    const controller = new AbortController();
    const response = fetch(`http://127.0.0.1:${address.port}/stream`, {
      headers: { "x-request-id": "request-express-close" },
      signal: controller.signal,
    });
    await started;
    controller.abort();
    await expect(response).rejects.toThrow();
    await vi.waitFor(() => expect(sink.all(HttpRequest)).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 60));

    const records = sink.all(HttpRequest);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      request_id: "request-express-close",
      http: { method: "GET", route: "orders.stream" },
      success: false,
      error: { type: "Error", code: "response_closed" },
    });
  });

  it("uses Fastify's final onResponse status without wrapping the handler", async () => {
    const sink = createTestSink();
    init({ service: "fastify-test", env: "test", sinks: [sink] });
    const app = Fastify();
    openServers.push({ close: () => app.close() });

    await app.register(FastifyPlugin);
    app.addHook("onSend", async (request, reply, payload) => {
      if (request.url.startsWith("/hooked")) reply.code(503);
      return payload;
    });
    app.get("/hooked", function ordinarySyncHandler() {
      return { ok: false };
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string")
      throw new Error("missing address");

    const response = await fetch(
      `http://127.0.0.1:${address.port}/hooked?token=never-record-me`,
      { headers: { "x-request-id": "request-fastify" } },
    );
    expect(response.status).toBe(503);

    const record = sink.single(HttpRequest);
    expect(record.request_id).toBe("request-fastify");
    expect(record.http).toEqual({
      method: "GET",
      route: "/hooked",
      status: 503,
    });
    expect(record.success).toBe(false);
    expect(JSON.stringify(record)).not.toContain("never-record-me");
  });

  it("keeps Fastify onError and the handled final response in one Event", async () => {
    const sink = createTestSink();
    init({ service: "fastify-test", env: "test", sinks: [sink] });
    const app = Fastify();
    openServers.push({ close: () => app.close() });

    await app.register(FastifyPlugin);
    app.setErrorHandler((error, _request, reply) => {
      expect(error.message).toBe("private fastify failure");
      reply.code(502).send({ error: "handled" });
    });
    app.get("/failure", async () => {
      throw new Error("private fastify failure");
    });

    const response = await app.inject({
      method: "GET",
      url: "/failure?token=never-record-me",
      headers: { "x-request-id": "request-fastify-error" },
    });
    expect(response.statusCode).toBe(502);

    const record = sink.single(HttpRequest);
    expect(record.request_id).toBe("request-fastify-error");
    expect(record.http).toEqual({
      method: "GET",
      route: "/failure",
      status: 502,
    });
    expect(record.success).toBe(false);
    expect(record.error).toEqual({ type: "Error" });
    expect(JSON.stringify(record)).not.toContain("private fastify failure");
    expect(JSON.stringify(record)).not.toContain("never-record-me");
  });

  it("cancels a Fastify Event exactly once when the incoming request aborts", async () => {
    const sink = createTestSink();
    init({ service: "fastify-test", env: "test", sinks: [sink] });
    const app = Fastify();
    openServers.push({ close: () => app.close() });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });

    await app.register(FastifyPlugin);
    app.addHook("onRequest", (_request, _reply, done) => {
      markStarted();
      done();
    });
    app.post("/upload", async () => ({ ok: true }));
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string")
      throw new Error("missing address");

    const requestClosed = new Promise<void>((resolve) => {
      const request = httpRequest({
        host: "127.0.0.1",
        port: address.port,
        method: "POST",
        path: "/upload?token=never-record-me",
        headers: {
          "content-length": "128",
          "content-type": "application/json",
          "x-request-id": "request-fastify-abort",
        },
      });
      request.once("error", () => resolve());
      request.once("close", () => resolve());
      request.write('{"partial":"body');
      void started.then(() => request.destroy());
    });
    await started;
    await requestClosed;
    await vi.waitFor(() => expect(sink.all(HttpRequest)).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 25));

    const records = sink.all(HttpRequest);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      request_id: "request-fastify-abort",
      http: { method: "POST", route: "/upload" },
      success: false,
      error: { type: "Error", code: "request_aborted" },
    });
    expect(JSON.stringify(records[0])).not.toContain("never-record-me");
    expect(JSON.stringify(records[0])).not.toContain("partial");
  });

  it("preserves a Next handler's Response identity and classifies returned failures", () => {
    const sink = createTestSink();
    init({ service: "next-test", env: "test", sinks: [sink] });
    const expected = new Response("teapot", { status: 418 });
    const request = {
      method: "POST",
      headers: new Headers({ "x-request-id": "request-next" }),
    };
    const context = { params: Promise.resolve({ id: "ord_1" }) };
    const handler = withAmplio("orders.create", (incoming, incomingContext) => {
      expect(incoming).toBe(request);
      expect(incomingContext).toBe(context);
      return expected;
    });

    const actual = handler(request as never, context);
    expect(actual).toBe(expected);

    const record = sink.single(HttpRequest);
    expect(record.request_id).toBe("request-next");
    expect(record.http).toEqual({
      method: "POST",
      route: "orders.create",
      status: 418,
    });
    expect(record.success).toBe(false);
  });

  it("preserves a thrown Next error and keeps request context without inventing status", () => {
    const sink = createTestSink();
    init({ service: "next-test", env: "test", sinks: [sink] });
    const original = new Error("private application detail");
    const request = {
      method: "GET",
      headers: new Headers({ "x-request-id": "request-next-error" }),
    };
    const handler = withAmplio("orders.show", () => {
      throw original;
    });

    expect(() => handler(request as never)).toThrow(original);

    const record = sink.single(HttpRequest);
    expect(record.request_id).toBe("request-next-error");
    expect(record.http).toEqual({ method: "GET", route: "orders.show" });
    expect(record.success).toBe(false);
    expect(record.error).toEqual({ type: "Error" });
    expect(JSON.stringify(record)).not.toContain("private application detail");
  });

  it("records tRPC procedures as nested duration Events and restores failure results", async () => {
    const sink = createTestSink();
    init({ service: "trpc-test", env: "test", sinks: [sink] });
    const Request = event({
      id: "test.request",
      version: 1,
      schema: z.object({ kind: z.literal("test") }),
      tree: { rpc: TrpcPlugin.events },
    });
    const originalError = new Error("private provider detail");
    const failed = { ok: false as const, error: originalError };
    const middleware = TrpcPlugin();

    const run = Request.handle(
      async () => {
        const result = await middleware({
          path: "orders.create",
          type: "mutation",
          next: async () => failed,
        });
        expect(result).toBe(failed);
        return "application-ok";
      },
      { input: () => ({ kind: "test" }) },
    );

    await expect(run()).resolves.toBe("application-ok");
    const record = sink.single(Request);
    expect(record.success).toBe(true);
    expect(record.rpc?.procedures).toHaveLength(1);
    expect(record.rpc?.procedures?.[0]).toMatchObject({
      path: "orders.create",
      type: "mutation",
      success: false,
      error: { type: "Error" },
    });
    expect(JSON.stringify(record)).not.toContain("private provider detail");
  });

  it("leaves subscriptions untouched because this middleware cannot observe stream completion", async () => {
    const sink = createTestSink();
    init({ service: "trpc-test", env: "test", sinks: [sink] });
    const Request = event({
      id: "test.subscription.request",
      version: 1,
      schema: z.object({ kind: z.literal("test") }),
      tree: { rpc: TrpcPlugin.events },
    });
    const middleware = TrpcPlugin();
    const providerResult = Promise.resolve({ ok: true as const });

    const run = Request.handle(
      async () => {
        const returned = middleware({
          path: "orders.changed",
          type: "subscription",
          next: () => providerResult,
        });
        expect(returned).toBe(providerResult);
        await expect(returned).resolves.toBe(await providerResult);
      },
      { input: () => ({ kind: "test" }) },
    );

    await run();
    expect(sink.single(Request).rpc).toBeUndefined();
    sink.assertNoDiagnostics();
  });
});
