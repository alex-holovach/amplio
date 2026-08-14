import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest";
import {
  embedMany,
  generateText,
  registerTelemetry,
  rerank,
  simulateReadableStream,
  streamText,
  type Telemetry,
} from "ai";
import {
  MockEmbeddingModelV4,
  MockLanguageModelV4,
  MockRerankingModelV4,
} from "ai/test";
import { event, init, type SinkRecord } from "@useamplio/amplio";
import { z } from "zod";
import { AiSdkPlugin } from "../registry/plugins/ai-sdk.ts";

const previousIntegrations = globalThis.AI_SDK_TELEMETRY_INTEGRATIONS;

const AiRequest = event({
  id: "test.ai_request",
  version: 1,
  schema: z.object({ request_id: z.string() }),
  tree: { ai: AiSdkPlugin.events },
});

describe("AiSdkPlugin", () => {
  const records: SinkRecord[] = [];

  it("returns the same native Telemetry integration and exact Event tree", () => {
    expectTypeOf(AiSdkPlugin).toMatchTypeOf<() => Telemetry>();
    expectTypeOf(AiSdkPlugin.streamText(streamText)).toEqualTypeOf(streamText);
    expect(AiSdkPlugin()).toBe(AiSdkPlugin());
    expect(AiSdkPlugin.events.operations).toMatchObject({
      id: "ai.operation",
      version: 2,
      timing: "duration",
      cardinality: { many: { max: 32 } },
    });
  });

  it("is lifecycle-idempotent when the same integration is registered twice", async () => {
    const integrations = [...(globalThis.AI_SDK_TELEMETRY_INTEGRATIONS ?? [])];
    try {
      registerTelemetry(AiSdkPlugin());
      const run = AiRequest.handle(
        () =>
          generateText({
            model: new MockLanguageModelV4({
              doGenerate: async () => ({
                content: [{ type: "text", text: "private duplicate output" }],
                finishReason: { unified: "stop", raw: undefined },
                usage: {
                  inputTokens: {
                    total: 1,
                    noCache: 1,
                    cacheRead: undefined,
                    cacheWrite: undefined,
                  },
                  outputTokens: { total: 1, text: 1, reasoning: undefined },
                },
                warnings: [],
              }),
            }),
            prompt: "private duplicate prompt",
          }),
        { input: () => ({ request_id: "request_ai_duplicate" }) },
      );

      await run();
      expect(records).toHaveLength(1);
      expect(
        (records[0]?.ai as { operations?: JsonRecord[] }).operations,
      ).toEqual([
        expect.objectContaining({
          operation: "generate_text",
          success: true,
        }),
      ]);
    } finally {
      globalThis.AI_SDK_TELEMETRY_INTEGRATIONS = integrations;
    }
  });

  beforeAll(() => {
    globalThis.AI_SDK_TELEMETRY_INTEGRATIONS = undefined;
    init({
      service: "ai-service",
      env: "test",
      sinks: [(record) => records.push(record)],
    });
    registerTelemetry(AiSdkPlugin());
  });

  beforeEach(() => {
    records.length = 0;
  });

  afterAll(() => {
    globalThis.AI_SDK_TELEMETRY_INTEGRATIONS = previousIntegrations as
      Telemetry[] | undefined;
  });

  it("records a real generateText lifecycle without capturing private content", async () => {
    const privateSystem = "private system policy: internal-only";
    const privatePrompt = "private prompt: customer@example.com";
    const privateOutput = "private generated answer";
    const model = new MockLanguageModelV4({
      provider: "openai.responses",
      modelId: "gpt-5-mini-private-tenant-deployment",
      doGenerate: async () => ({
        content: [{ type: "text", text: privateOutput }],
        finishReason: { unified: "stop", raw: "private_raw_reason" },
        usage: {
          inputTokens: {
            total: 3,
            noCache: 2,
            cacheRead: 1,
            cacheWrite: 2,
          },
          outputTokens: { total: 5, text: 4, reasoning: 1 },
          raw: { secretUsage: "private_usage" },
        },
        providerMetadata: {
          mock: { privateMetadata: "private_provider_metadata" },
        },
        request: { body: { privatePrompt } },
        response: {
          headers: { authorization: "Bearer private_response_token" },
          body: { privateOutput },
        },
        warnings: [
          {
            type: "other",
            message: "private provider warning detail",
          },
        ],
      }),
    });

    let applicationResult: Awaited<ReturnType<typeof generateText>> | undefined;
    const run = AiRequest.handle(
      async () => {
        applicationResult = await generateText({
          model,
          system: privateSystem,
          prompt: privatePrompt,
          maxRetries: 4,
          maxOutputTokens: 256,
          temperature: 0.2,
          topP: 0.9,
          topK: 40,
          presencePenalty: 0.1,
          frequencyPenalty: -0.1,
          seed: 42,
          stopSequences: ["private stop sequence"],
          reasoning: "low",
          timeout: {
            totalMs: 10_000,
            stepMs: 4_000,
            toolMs: 3_000,
          },
          telemetry: { functionId: "private_tenant_support_reply" },
        });
        return applicationResult;
      },
      { input: () => ({ request_id: "request_ai_1" }) },
    );

    const returned = await run();
    expect(returned).toBe(applicationResult);
    expect(returned.text).toBe(privateOutput);

    expect(records).toHaveLength(1);
    expect(records[0]?.ai).toEqual({
      operations: [
        expect.objectContaining({
          operation: "generate_text",
          provider: "openai",
          model_family: "gpt-5",
          max_retries: 4,
          max_output_tokens: 256,
          temperature: 0.2,
          top_p: 0.9,
          top_k: 40,
          presence_penalty: 0.1,
          frequency_penalty: -0.1,
          seeded: true,
          reasoning_effort: "low",
          stop_sequence_count: 1,
          timeout_ms: 10_000,
          step_timeout_ms: 4_000,
          tool_timeout_ms: 3_000,
          finish_reason: "stop",
          input_tokens: 3,
          output_tokens: 5,
          total_tokens: 8,
          cached_input_tokens: 1,
          cache_write_input_tokens: 2,
          text_tokens: 4,
          reasoning_tokens: 1,
          step_count: 1,
          tool_call_count: 0,
          tool_result_count: 0,
          warning_count: 1,
          model_call_count: 1,
          content_part_count: 1,
          file_count: 0,
          source_count: 0,
          response_message_count: 1,
          provider_response_ms: expect.any(Number),
          step_time_ms: expect.any(Number),
          tool_execution_ms: 0,
          success: true,
          duration_ms: expect.any(Number),
        }),
      ],
    });

    const serialized = JSON.stringify(records[0]?.ai);
    for (const forbidden of [
      privateSystem,
      privatePrompt,
      privateOutput,
      "private_raw_reason",
      "private_usage",
      "private_provider_metadata",
      "private provider warning detail",
      "private_response_token",
      "private stop sequence",
      "private_tenant_support_reply",
      "openai.responses",
      "gpt-5-mini-private-tenant-deployment",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("keeps streamText lazy and retains the root until external consumption completes", async () => {
    const privatePrompt = "stream prompt: private@example.com";
    const privateOutput = "private streamed answer";
    const model = new MockLanguageModelV4({
      provider: "anthropic.messages",
      modelId: "claude-sonnet-4-5-private-tenant-deployment",
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "text-1" },
            { type: "text-delta", id: "text-1", delta: privateOutput },
            { type: "text-end", id: "text-1" },
            {
              type: "finish",
              finishReason: { unified: "length", raw: "private_limit" },
              logprobs: undefined,
              usage: {
                inputTokens: {
                  total: 7,
                  noCache: 7,
                  cacheRead: undefined,
                  cacheWrite: undefined,
                },
                outputTokens: { total: 9, text: 9, reasoning: undefined },
              },
            },
          ],
        }),
      }),
    });

    let resultIdentity: ReturnType<typeof streamText> | undefined;
    let onEndCalls = 0;
    let onEndText: string | undefined;
    const run = AiRequest.handle(
      () => {
        resultIdentity = AiSdkPlugin.streamText(streamText)({
          model,
          prompt: privatePrompt,
          maxOutputTokens: 128,
          timeout: {
            totalMs: 8_000,
            stepMs: 4_000,
            chunkMs: 1_000,
            toolMs: 3_000,
          },
          onEnd(event) {
            onEndCalls += 1;
            onEndText = event.text;
          },
        });
        return resultIdentity;
      },
      { input: () => ({ request_id: "request_ai_stream" }) },
    );

    const returned = run();
    expect(returned).toBe(resultIdentity);
    expect(records).toEqual([]);
    expect(await returned.text).toBe(privateOutput);
    expect(onEndCalls).toBe(1);
    expect(onEndText).toBe(privateOutput);
    expect(records).toHaveLength(1);
    expect(records[0]?.ai).toEqual({
      operations: [
        expect.objectContaining({
          operation: "stream_text",
          provider: "anthropic",
          model_family: "claude-sonnet",
          max_output_tokens: 128,
          output_kind: "text",
          tool_count: 0,
          timeout_ms: 8_000,
          step_timeout_ms: 4_000,
          chunk_timeout_ms: 1_000,
          tool_timeout_ms: 3_000,
          finish_reason: "length",
          input_tokens: 7,
          output_tokens: 9,
          total_tokens: 16,
          step_count: 1,
          tool_call_count: 0,
          success: true,
        }),
      ],
    });
    expect(JSON.stringify(records[0])).not.toContain(privatePrompt);
    expect(JSON.stringify(records[0])).not.toContain(privateOutput);
    expect(JSON.stringify(records[0])).not.toContain("private_limit");
    expect(JSON.stringify(records[0])).not.toContain("anthropic.messages");
    expect(JSON.stringify(records[0])).not.toContain(
      "claude-sonnet-4-5-private-tenant-deployment",
    );
  });

  it("does not claim lifecycle telemetry for an unwrapped stream", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "text-unwrapped" },
            {
              type: "text-delta",
              id: "text-unwrapped",
              delta: "private unwrapped output",
            },
            { type: "text-end", id: "text-unwrapped" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: undefined },
              logprobs: undefined,
              usage: {
                inputTokens: {
                  total: 1,
                  noCache: 1,
                  cacheRead: undefined,
                  cacheWrite: undefined,
                },
                outputTokens: { total: 1, text: 1, reasoning: undefined },
              },
            },
          ],
        }),
      }),
    });
    const run = AiRequest.handle(
      () => streamText({ model, prompt: "private unwrapped prompt" }),
      { input: () => ({ request_id: "request_ai_unwrapped" }) },
    );

    const result = run();
    expect(records).toHaveLength(1);
    expect(records[0]?.ai).toBeUndefined();
    expect(records[0]?.["@amplio"]).toBeUndefined();
    expect(await result.text).toBe("private unwrapped output");
    expect(records).toHaveLength(1);
  });

  it("honors current and legacy per-call telemetry selection", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            {
              type: "finish",
              finishReason: { unified: "stop", raw: undefined },
              logprobs: undefined,
              usage: {
                inputTokens: {
                  total: 0,
                  noCache: 0,
                  cacheRead: undefined,
                  cacheWrite: undefined,
                },
                outputTokens: { total: 0, text: 0, reasoning: undefined },
              },
            },
          ],
        }),
      }),
    });
    const observedStreamText = AiSdkPlugin.streamText(streamText);
    type Selection = { isEnabled: false } | { integrations: Telemetry[] };
    const run = (
      requestId: string,
      options: { telemetry: Selection } | { experimental_telemetry: Selection },
    ) =>
      AiRequest.handle(
        () =>
          observedStreamText({
            model,
            prompt: "private disabled prompt",
            ...options,
          }),
        { input: () => ({ request_id: requestId }) },
      )();

    const results = [
      run("request_ai_disabled", { telemetry: { isEnabled: false } }),
      run("request_ai_replaced", { telemetry: { integrations: [] } }),
      run("request_ai_legacy_disabled", {
        experimental_telemetry: { isEnabled: false },
      }),
      run("request_ai_legacy_replaced", {
        experimental_telemetry: { integrations: [] },
      }),
    ];
    await expect(
      Promise.all(results.map((result) => result.text)),
    ).resolves.toEqual(["", "", "", ""]);
    expect(records).toHaveLength(4);
    expect(records.every((record) => record.ai === undefined)).toBe(true);
  });

  it("does not stack instrumentation when streamText is wrapped twice", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            {
              type: "finish",
              finishReason: { unified: "stop", raw: undefined },
              logprobs: undefined,
              usage: {
                inputTokens: {
                  total: 0,
                  noCache: 0,
                  cacheRead: undefined,
                  cacheWrite: undefined,
                },
                outputTokens: { total: 0, text: 0, reasoning: undefined },
              },
            },
          ],
        }),
      }),
    });
    const once = AiSdkPlugin.streamText(streamText);
    const twice = AiSdkPlugin.streamText(once);

    expect(twice).toBe(once);
    const result = AiRequest.handle(
      () => twice({ model, prompt: "private double-wrap prompt" }),
      { input: () => ({ request_id: "request_ai_double_wrap" }) },
    )();

    expect(await result.text).toBe("");
    expect(
      (records[0]?.ai as { operations?: JsonRecord[] }).operations,
    ).toHaveLength(1);
    expect(JSON.stringify(records[0])).not.toContain(
      "private double-wrap prompt",
    );
  });

  it("settles a streamed provider error without consuming or replacing the result", async () => {
    const marker = new Error("private streamed provider failure");
    let callbackError: unknown;
    let callbackCalls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [{ type: "error", error: marker }],
        }),
      }),
    });
    const observedStreamText = AiSdkPlugin.streamText(streamText);
    let identity: ReturnType<typeof streamText> | undefined;
    const run = AiRequest.handle(
      () => {
        identity = observedStreamText({
          model,
          prompt: "private streamed failure prompt",
          onError(event) {
            callbackCalls += 1;
            callbackError = event.error;
          },
        });
        return identity;
      },
      { input: () => ({ request_id: "request_ai_stream_failure" }) },
    );

    const result = run();
    expect(result).toBe(identity);
    expect(records).toEqual([]);
    await expect(result.text).resolves.toBe("");
    expect(callbackCalls).toBe(1);
    expect(callbackError).toBe(marker);
    expect(records).toHaveLength(1);
    expect(
      (records[0]?.ai as { operations?: JsonRecord[] }).operations,
    ).toEqual([
      expect.objectContaining({
        operation: "stream_text",
        success: false,
        error: { type: "Error" },
      }),
    ]);
    expect(JSON.stringify(records[0])).not.toContain(marker.message);
    expect(JSON.stringify(records[0])).not.toContain(
      "private streamed failure prompt",
    );
  });

  it("preserves AI SDK's default streamed-error callback", async () => {
    const marker = new Error("private default streamed error");
    const defaultError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      const model = new MockLanguageModelV4({
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: [{ type: "error", error: marker }],
          }),
        }),
      });
      const result = AiRequest.handle(
        () =>
          AiSdkPlugin.streamText(streamText)({
            model,
            prompt: "private default error prompt",
          }),
        { input: () => ({ request_id: "request_ai_default_error" }) },
      )();

      await expect(result.text).resolves.toBe("");
      expect(defaultError).toHaveBeenCalledTimes(1);
      expect(defaultError).toHaveBeenCalledWith(marker);
      expect(records).toHaveLength(1);
      expect(JSON.stringify(records[0])).not.toContain(marker.message);
    } finally {
      defaultError.mockRestore();
    }
  });

  it("records only aggregate counts for embeddings and reranking", async () => {
    const privateValues = ["private embedding one", "private embedding two"];
    const privateDocuments = ["private document one", "private document two"];
    const privateQuery = "private rerank query";
    const embeddingModel = new MockEmbeddingModelV4({
      provider: "openai.embedding",
      modelId: "text-embedding-3-small-private-tenant",
      maxEmbeddingsPerCall: 2,
      doEmbed: async () => ({
        embeddings: [
          [0.1, 0.2],
          [0.3, 0.4],
        ],
        usage: { tokens: 11 },
        providerMetadata: {
          mock: { privateMetadata: "private_embedding_metadata" },
        },
        response: { body: { privateValues } },
        warnings: [],
      }),
    });
    const rerankingModel = new MockRerankingModelV4({
      provider: "cohere.rerank",
      modelId: "rerank-v3-private-tenant",
      doRerank: async () => ({
        ranking: [
          { index: 1, relevanceScore: 0.9 },
          { index: 0, relevanceScore: 0.5 },
        ],
        providerMetadata: {
          mock: { privateMetadata: "private_rerank_metadata" },
        },
        response: { body: { privateQuery, privateDocuments } },
        warnings: [],
      }),
    });

    const run = AiRequest.handle(
      async () => {
        const embedded = await embedMany({
          model: embeddingModel,
          values: privateValues,
        });
        expect(embedded.embeddings).toEqual([
          [0.1, 0.2],
          [0.3, 0.4],
        ]);
        const ranked = await rerank({
          model: rerankingModel,
          documents: privateDocuments,
          query: privateQuery,
          topN: 2,
        });
        expect(ranked.ranking.map((entry) => entry.originalIndex)).toEqual([
          1, 0,
        ]);
      },
      { input: () => ({ request_id: "request_ai_vectors" }) },
    );

    await run();
    const operations = (records[0]?.ai as { operations?: JsonRecord[] })
      .operations;
    expect(operations).toEqual([
      expect.objectContaining({
        operation: "embed_many",
        provider: "openai",
        model_family: "embedding",
        item_count: 2,
        result_count: 2,
        input_tokens: 11,
        success: true,
      }),
      expect.objectContaining({
        operation: "rerank",
        provider: "cohere",
        model_family: "rerank",
        item_count: 2,
        result_count: 2,
        requested_result_count: 2,
        success: true,
      }),
    ]);

    const serialized = JSON.stringify(records[0]?.ai);
    for (const forbidden of [
      ...privateValues,
      ...privateDocuments,
      privateQuery,
      "private_embedding_metadata",
      "private_rerank_metadata",
      "openai.embedding",
      "text-embedding-3-small-private-tenant",
      "cohere.rerank",
      "rerank-v3-private-tenant",
      JSON.stringify([0.1, 0.2]),
      "relevanceScore",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("omits hostile or out-of-domain metadata without dropping the operation", async () => {
    const sparseStops = new Array(1_000_000_000);
    const hostileTimings = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("private hostile timing enumeration");
        },
      },
    );
    const integration = AiSdkPlugin();
    const run = AiRequest.handle(
      () => {
        Reflect.apply(integration.onStart!, integration, [
          {
            callId: "internal-hostile-correlation",
            operationId: "ai.generateText",
            provider: "https://secret@evil.example/?route=anthropic",
            modelId: "tenant-secret-gpt-5-api-key",
            maxRetries: 101,
            maxOutputTokens: Number.MAX_SAFE_INTEGER,
            temperature: 2.000_001,
            topP: 1.000_001,
            topK: 1_000_001,
            presencePenalty: -2.000_001,
            frequencyPenalty: 2.000_001,
            stopSequences: sparseStops,
            timeout: 31_536_000_001,
          },
        ]);
        expect(() =>
          Reflect.apply(integration.onEnd!, integration, [
            {
              callId: "internal-hostile-correlation",
              finishReason: { unified: "stop" },
              usage: {
                inputTokens: Number.MAX_SAFE_INTEGER,
                outputTokens: Number.POSITIVE_INFINITY,
              },
              steps: [
                {
                  performance: {
                    responseTimeMs: 1.234_567_89,
                    stepTimeMs: 2.345_678_9,
                    toolExecutionMs: hostileTimings,
                  },
                },
              ],
            },
          ]),
        ).not.toThrow();
      },
      { input: () => ({ request_id: "request_ai_hostile_metadata" }) },
    );

    run();
    const operations = (records[0]?.ai as { operations?: JsonRecord[] })
      .operations;
    expect(operations).toEqual([
      expect.objectContaining({
        operation: "generate_text",
        provider: "other",
        model_family: "other",
        output_kind: "text",
        tool_count: 0,
        finish_reason: "stop",
        success: true,
      }),
    ]);
    for (const omitted of [
      "max_retries",
      "max_output_tokens",
      "temperature",
      "top_p",
      "top_k",
      "presence_penalty",
      "frequency_penalty",
      "stop_sequence_count",
      "timeout_ms",
      "input_tokens",
      "output_tokens",
      "provider_response_ms",
      "step_time_ms",
      "tool_execution_ms",
    ]) {
      expect(operations?.[0]).not.toHaveProperty(omitted);
    }
    const serialized = JSON.stringify(records[0]);
    expect(serialized).not.toContain("secret@evil");
    expect(serialized).not.toContain("tenant-secret");
    expect(serialized).not.toContain("internal-hostile-correlation");
    expect(serialized).not.toContain("private hostile timing enumeration");
  });

  it("bounds high-cardinality numeric settings before recording them", () => {
    const integration = AiSdkPlugin();
    AiRequest.handle(
      () => {
        Reflect.apply(integration.onStart!, integration, [
          {
            callId: "internal-bounded-config",
            operationId: "ai.generateText",
            maxOutputTokens: 257,
            temperature: 0.123_456,
            topP: 0.987_654,
            topK: 41,
            presencePenalty: 0.126,
            frequencyPenalty: -0.126,
            timeout: 6_001,
          },
        ]);
        Reflect.apply(integration.onEnd!, integration, [
          {
            callId: "internal-bounded-config",
            finishReason: { unified: "stop" },
          },
        ]);
      },
      { input: () => ({ request_id: "request_ai_bounded_config" }) },
    )();

    const operation = (records[0]?.ai as { operations?: JsonRecord[] })
      .operations?.[0];
    expect(operation).toMatchObject({
      max_output_tokens: 512,
      temperature: 0.12,
      top_p: 0.99,
      top_k: 50,
      presence_penalty: 0.13,
      frequency_penalty: -0.13,
      timeout_ms: 8_000,
      success: true,
    });
    expect(JSON.stringify(operation)).not.toContain("internal-bounded-config");
  });

  it("settles safely when a provider returns a revoked embedding proxy", () => {
    const integration = AiSdkPlugin();
    const revocable = Proxy.revocable([], {});
    revocable.revoke();
    AiRequest.handle(
      () => {
        Reflect.apply(integration.onStart!, integration, [
          {
            callId: "internal-revoked-embedding",
            operationId: "ai.embed",
            value: "private embedding input",
          },
        ]);
        expect(() =>
          Reflect.apply(integration.onEnd!, integration, [
            {
              callId: "internal-revoked-embedding",
              embedding: [revocable.proxy],
              usage: { tokens: 3 },
            },
          ]),
        ).not.toThrow();
      },
      { input: () => ({ request_id: "request_ai_revoked_embedding" }) },
    )();

    expect(records).toHaveLength(1);
    expect(
      (records[0]?.ai as { operations?: JsonRecord[] }).operations,
    ).toEqual([
      expect.objectContaining({
        operation: "embed",
        input_tokens: 3,
        success: true,
      }),
    ]);
    expect(
      (records[0]?.ai as { operations?: JsonRecord[] }).operations?.[0],
    ).not.toHaveProperty("result_count");
    expect(JSON.stringify(records[0])).not.toContain("private embedding input");
  });

  it("preserves the exact AI SDK rejection and records a safe failure", async () => {
    const marker = new Error("private provider failure: sk-secret-value");
    const model = new MockLanguageModelV4({
      provider: "failure-provider",
      modelId: "failure-model-v1",
      doGenerate: async () => {
        throw marker;
      },
    });
    const run = AiRequest.handle(
      () => generateText({ model, prompt: "private failing prompt" }),
      { input: () => ({ request_id: "request_ai_failure" }) },
    );

    await expect(run()).rejects.toBe(marker);
    expect(records).toHaveLength(1);
    expect(records[0]?.ai).toEqual({
      operations: [
        expect.objectContaining({
          operation: "generate_text",
          success: false,
          error: { type: "Error" },
        }),
      ],
    });
    expect(JSON.stringify(records[0])).not.toContain(marker.message);
    expect(JSON.stringify(records[0])).not.toContain("private failing prompt");
  });

  it("isolates concurrent operations by their native call ids", async () => {
    let invocation = 0;
    const model = new MockLanguageModelV4({
      provider: "concurrent-provider",
      modelId: "concurrent-model-v1",
      doGenerate: async () => {
        const current = invocation++;
        await new Promise((resolve) =>
          setTimeout(resolve, current === 0 ? 8 : 1),
        );
        return {
          content: [{ type: "text", text: `private answer ${current}` }],
          finishReason: { unified: "stop", raw: undefined },
          usage: {
            inputTokens: {
              total: 1,
              noCache: 1,
              cacheRead: undefined,
              cacheWrite: undefined,
            },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
          warnings: [],
        };
      },
    });

    const request = (requestId: string) =>
      AiRequest.handle(
        () => generateText({ model, prompt: `private ${requestId}` }),
        { input: () => ({ request_id: requestId }) },
      )();

    const [first, second] = await Promise.all([
      request("request_ai_concurrent_a"),
      request("request_ai_concurrent_b"),
    ]);
    expect(first.text).toBe("private answer 0");
    expect(second.text).toBe("private answer 1");
    expect(records).toHaveLength(2);
    for (const requestId of [
      "request_ai_concurrent_a",
      "request_ai_concurrent_b",
    ]) {
      const record = records.find(
        (candidate) => candidate.request_id === requestId,
      );
      expect(
        (record?.ai as { operations?: unknown[] }).operations,
      ).toHaveLength(1);
      expect(JSON.stringify(record)).not.toContain("private answer");
    }
  });

  it("is telemetry-inert when no declaring root Event is active", async () => {
    const result = await generateText({
      model: new MockLanguageModelV4({
        doGenerate: async () => ({
          content: [{ type: "text", text: "private inert output" }],
          finishReason: { unified: "stop", raw: undefined },
          usage: {
            inputTokens: {
              total: 1,
              noCache: 1,
              cacheRead: undefined,
              cacheWrite: undefined,
            },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
          warnings: [],
        }),
      }),
      prompt: "private inert prompt",
    });

    expect(result.text).toBe("private inert output");
    expect(records).toEqual([]);
  });

  it("closes an aborted stream exactly once without consuming it", async () => {
    const abortReason = new Error("private abort reason");
    const controller = new AbortController();
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunkDelayInMs: 20,
          chunks: [
            { type: "text-start", id: "text-abort" },
            {
              type: "text-delta",
              id: "text-abort",
              delta: "private partial output",
            },
            { type: "text-end", id: "text-abort" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: undefined },
              logprobs: undefined,
              usage: {
                inputTokens: {
                  total: 1,
                  noCache: 1,
                  cacheRead: undefined,
                  cacheWrite: undefined,
                },
                outputTokens: { total: 1, text: 1, reasoning: undefined },
              },
            },
          ],
        }),
      }),
    });
    const run = AiRequest.handle(
      async () => {
        const result = AiSdkPlugin.streamText(streamText)({
          model,
          prompt: "private abort prompt",
          abortSignal: controller.signal,
        });
        setTimeout(() => controller.abort(abortReason), 25);
        return result.text;
      },
      { input: () => ({ request_id: "request_ai_abort" }) },
    );

    await expect(run()).rejects.toBe(abortReason);
    expect(records).toHaveLength(1);
    const operations = (records[0]?.ai as { operations?: JsonRecord[] })
      .operations;
    expect(operations).toEqual([
      expect.objectContaining({
        operation: "stream_text",
        success: false,
        error: { type: "Error", code: "ai_aborted" },
      }),
    ]);
    expect(JSON.stringify(records[0])).not.toContain(abortReason.message);
    expect(JSON.stringify(records[0])).not.toContain("private partial output");
  });
});

type JsonRecord = Record<string, unknown>;
