import assert from "node:assert/strict";
import {
  embed,
  embedMany,
  generateObject,
  generateText,
  registerTelemetry,
  rerank,
  simulateReadableStream,
  streamText,
} from "ai";
import {
  MockEmbeddingModelV4,
  MockLanguageModelV4,
  MockRerankingModelV4,
} from "ai/test";
import { event, init } from "@useamplio/amplio";
import { createTestSink } from "@useamplio/amplio/testing";
import { z } from "zod";
import { AiSdkPlugin } from "./telemetry/plugins/ai-sdk.js";

const sink = createTestSink();
init({ service: "provider-compatibility", env: "test", sinks: [sink] });
registerTelemetry(AiSdkPlugin());
assert.equal(AiSdkPlugin.events.operations.version, 2);

const Request = event({
  id: "compatibility.ai.request",
  version: 1,
  schema: z.object({ request_id: z.string() }),
  tree: { ai: AiSdkPlugin.events },
});

const model = new MockLanguageModelV4({
  provider: "openai.private-compatibility-provider",
  modelId: "gpt-5-private-compatibility-model",
  doGenerate: async ({ responseFormat }) => ({
    content: [
      {
        type: "text",
        text:
          responseFormat?.type === "json"
            ? JSON.stringify({ answer: "private structured content" })
            : "private generated content",
      },
    ],
    finishReason: { unified: "stop", raw: "private_raw_reason" },
    usage: {
      inputTokens: {
        total: 3,
        noCache: 3,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
      outputTokens: { total: 4, text: 4, reasoning: undefined },
    },
    warnings: [],
    request: { body: { privateRequest: "private_generate_request_body" } },
    response: { body: { privateResponse: "private_generate_response_body" } },
    providerMetadata: {
      mock: { privateMetadata: "private_generate_provider_metadata" },
    },
  }),
  doStream: async () => ({
    stream: simulateReadableStream({
      chunks: [
        { type: "text-start", id: "text-1" },
        {
          type: "text-delta",
          id: "text-1",
          delta: "private streamed content",
        },
        { type: "text-end", id: "text-1" },
        {
          type: "finish",
          finishReason: { unified: "tool-calls", raw: "private_tool_reason" },
          logprobs: undefined,
          usage: {
            inputTokens: {
              total: 5,
              noCache: 5,
              cacheRead: undefined,
              cacheWrite: undefined,
            },
            outputTokens: { total: 6, text: 6, reasoning: undefined },
          },
        },
      ],
    }),
  }),
});
const embeddingModel = new MockEmbeddingModelV4({
  provider: "google.private-compatibility-provider",
  modelId: "text-embedding-private-compatibility-model",
  maxEmbeddingsPerCall: 2,
  doEmbed: async ({ values }) => ({
    embeddings: values.map((_, index) => [index + 0.1, index + 0.2]),
    usage: { tokens: values.length * 7 },
    warnings: [],
    response: { body: { private: "private_embedding_response_body" } },
    providerMetadata: {
      mock: { privateMetadata: "private_embedding_provider_metadata" },
    },
  }),
});
const rerankingModel = new MockRerankingModelV4({
  provider: "cohere.private-compatibility-provider",
  modelId: "rerank-private-compatibility-model",
  doRerank: async () => ({
    ranking: [
      { index: 1, relevanceScore: 0.9 },
      { index: 0, relevanceScore: 0.4 },
    ],
    warnings: [],
    response: { body: { private: "private_rerank_response_body" } },
    providerMetadata: {
      mock: { privateMetadata: "private_rerank_provider_metadata" },
    },
  }),
});
const observedStreamText = AiSdkPlugin.streamText(streamText);

const run = Request.handle(
  async () => {
    const generated = await generateText({
      model,
      prompt: "private generated prompt",
      maxRetries: 3,
      maxOutputTokens: 512,
      seed: 42,
      reasoning: "low",
      stopSequences: ["private stop sequence"],
      timeout: { totalMs: 10_000, stepMs: 4_000, toolMs: 3_000 },
      telemetry: { functionId: "private.compatibility.generate" },
    });
    assert.equal(generated.text, "private generated content");

    const generatedObject = await generateObject({
      model,
      schema: z.object({ answer: z.string() }),
      schemaName: "private_compatibility_schema",
      schemaDescription: "private compatibility schema description",
      prompt: "private structured prompt",
      maxRetries: 2,
      maxOutputTokens: 256,
      seed: 7,
      telemetry: { functionId: "private.compatibility.object" },
    });
    assert.deepEqual(generatedObject.object, {
      answer: "private structured content",
    });

    const singleEmbedding = await embed({
      model: embeddingModel,
      value: "private single embedding",
      maxRetries: 1,
      telemetry: { functionId: "private.compatibility.embed" },
    });
    assert.deepEqual(singleEmbedding.embedding, [0.1, 0.2]);

    const embedded = await embedMany({
      model: embeddingModel,
      values: ["private embedding one", "private embedding two"],
      maxRetries: 4,
      telemetry: { functionId: "private.compatibility.embed_many" },
    });
    assert.deepEqual(embedded.embeddings, [
      [0.1, 0.2],
      [1.1, 1.2],
    ]);
    const ranked = await rerank({
      model: rerankingModel,
      documents: ["private document one", "private document two"],
      query: "private rerank query",
      topN: 2,
      maxRetries: 5,
      telemetry: { functionId: "private.compatibility.rerank" },
    });
    assert.deepEqual(
      ranked.ranking.map((entry) => entry.originalIndex),
      [1, 0],
    );

    const streamed = observedStreamText({
      model,
      prompt: "private streamed prompt",
      maxRetries: 6,
      maxOutputTokens: 1_024,
      seed: 99,
      reasoning: "medium",
      stopSequences: ["private streamed stop sequence"],
      timeout: { totalMs: 20_000, stepMs: 8_000, toolMs: 6_000 },
      telemetry: { functionId: "private.compatibility.stream" },
    });
    return { generated, generatedObject, singleEmbedding, streamed };
  },
  { input: () => ({ request_id: "request-ai-compatibility" }) },
);

const applicationResult = await run();
assert.equal(applicationResult.generated.text, "private generated content");
assert.deepEqual(applicationResult.generatedObject.object, {
  answer: "private structured content",
});
assert.deepEqual(applicationResult.singleEmbedding.embedding, [0.1, 0.2]);
assert.equal(await applicationResult.streamed.text, "private streamed content");
const record = sink.single(Request);
assert.equal(record.ai?.operations?.length, 6);
assert.deepEqual(
  record.ai?.operations?.map((operation) => ({
    operation: operation.operation,
    provider: operation.provider,
    modelFamily: operation.model_family,
    maxRetries: operation.max_retries,
    finishReason: operation.finish_reason,
    success: operation.success,
  })),
  [
    {
      operation: "generate_text",
      provider: "openai",
      modelFamily: "gpt-5",
      maxRetries: 3,
      finishReason: "stop",
      success: true,
    },
    {
      operation: "generate_object",
      provider: "openai",
      modelFamily: "gpt-5",
      maxRetries: 2,
      finishReason: "stop",
      success: true,
    },
    {
      operation: "embed",
      provider: "google",
      modelFamily: "embedding",
      maxRetries: 1,
      finishReason: undefined,
      success: true,
    },
    {
      operation: "embed_many",
      provider: "google",
      modelFamily: "embedding",
      maxRetries: 4,
      finishReason: undefined,
      success: true,
    },
    {
      operation: "rerank",
      provider: "cohere",
      modelFamily: "rerank",
      maxRetries: 5,
      finishReason: undefined,
      success: true,
    },
    {
      operation: "stream_text",
      provider: "openai",
      modelFamily: "gpt-5",
      maxRetries: 6,
      finishReason: "tool_calls",
      success: true,
    },
  ],
);

assert.equal(record.ai?.operations?.[0]?.max_output_tokens, 512);
assert.equal(record.ai?.operations?.[0]?.seeded, true);
assert.equal(record.ai?.operations?.[0]?.reasoning_effort, "low");
assert.equal(record.ai?.operations?.[0]?.stop_sequence_count, 1);
assert.equal(record.ai?.operations?.[0]?.timeout_ms, 10_000);
assert.equal(record.ai?.operations?.[0]?.step_timeout_ms, 4_000);
assert.equal(record.ai?.operations?.[0]?.tool_timeout_ms, 3_000);
assert.equal(record.ai?.operations?.[2]?.item_count, 1);
assert.equal(record.ai?.operations?.[2]?.result_count, 1);
assert.equal(record.ai?.operations?.[3]?.item_count, 2);
assert.equal(record.ai?.operations?.[3]?.result_count, 2);
assert.equal(record.ai?.operations?.[4]?.item_count, 2);
assert.equal(record.ai?.operations?.[4]?.result_count, 2);
assert.equal(record.ai?.operations?.[5]?.max_output_tokens, 1_024);
assert.equal(record.ai?.operations?.[5]?.seeded, true);
assert.equal(record.ai?.operations?.[5]?.reasoning_effort, "medium");
assert.equal(record.ai?.operations?.[5]?.stop_sequence_count, 1);
assert.equal(record.ai?.operations?.[5]?.timeout_ms, 30_000);
assert.equal(record.ai?.operations?.[5]?.step_timeout_ms, 8_000);
assert.equal(record.ai?.operations?.[5]?.tool_timeout_ms, 8_000);

const serialized = JSON.stringify(record);
for (const forbidden of [
  "private generated content",
  "private structured content",
  "private streamed content",
  "private generated prompt",
  "private structured prompt",
  "private streamed prompt",
  "private single embedding",
  "private embedding one",
  "private embedding two",
  "private document one",
  "private document two",
  "private rerank query",
  "openai.private-compatibility-provider",
  "gpt-5-private-compatibility-model",
  "google.private-compatibility-provider",
  "text-embedding-private-compatibility-model",
  "cohere.private-compatibility-provider",
  "rerank-private-compatibility-model",
  "private.compatibility.generate",
  "private.compatibility.object",
  "private.compatibility.embed",
  "private.compatibility.embed_many",
  "private.compatibility.rerank",
  "private.compatibility.stream",
  "private_compatibility_schema",
  "private compatibility schema description",
  "private stop sequence",
  "private streamed stop sequence",
  "private_generate_request_body",
  "private_generate_response_body",
  "private_generate_provider_metadata",
  "private_embedding_response_body",
  "private_embedding_provider_metadata",
  "private_rerank_response_body",
  "private_rerank_provider_metadata",
  "private_raw_reason",
  "private_tool_reason",
]) {
  assert.equal(serialized.includes(forbidden), false, forbidden);
}

const streamFailure = new Error("private compatibility stream failure");
let observedStreamFailure: unknown;
const failureModel = new MockLanguageModelV4({
  doStream: async () => ({
    stream: simulateReadableStream({
      chunks: [{ type: "error", error: streamFailure }],
    }),
  }),
});
const failed = Request.handle(
  () =>
    observedStreamText({
      model: failureModel,
      prompt: "private compatibility failure prompt",
      onError(event) {
        observedStreamFailure = event.error;
      },
    }),
  { input: () => ({ request_id: "request-ai-stream-failure" }) },
)();
try {
  await failed.text;
} catch (error) {
  assert.equal(error, streamFailure);
}
assert.equal(observedStreamFailure, streamFailure);
const failureRecord = sink.all(Request)[1];
assert.equal(failureRecord?.ai?.operations?.[0]?.success, false);
assert.equal(failureRecord?.ai?.operations?.[0]?.error?.type, "Error");
assert.doesNotMatch(JSON.stringify(failureRecord), /private compatibility/);

const abortReason = new Error("private compatibility abort reason");
const abortController = new AbortController();
const abortModel = new MockLanguageModelV4({
  doStream: async () => ({
    stream: simulateReadableStream({
      chunkDelayInMs: 20,
      chunks: [
        { type: "text-start", id: "abort" },
        { type: "text-delta", id: "abort", delta: "private partial" },
        { type: "text-end", id: "abort" },
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
const aborted = Request.handle(
  () => {
    const result = observedStreamText({
      model: abortModel,
      prompt: "private compatibility abort prompt",
      abortSignal: abortController.signal,
    });
    setTimeout(() => abortController.abort(abortReason), 25);
    return result;
  },
  { input: () => ({ request_id: "request-ai-stream-abort" }) },
)();
await assert.rejects(
  Promise.resolve(aborted.text),
  (error: unknown) => error === abortReason,
);
const abortRecord = sink.all(Request)[2];
assert.equal(abortRecord?.ai?.operations?.[0]?.success, false);
assert.equal(abortRecord?.ai?.operations?.[0]?.error?.type, "Error");
assert.equal(abortRecord?.ai?.operations?.[0]?.error?.code, "ai_aborted");
assert.doesNotMatch(JSON.stringify(abortRecord), /private compatibility/);
