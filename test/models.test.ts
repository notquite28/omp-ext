import { describe, expect, test } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { fetchGrokCliModels, GROK_CLI_MODELS, mapProxyModel } from "../src/models";

const HEADERS = { "x-grok-client-version": "9.8.7" };

function jsonResponse(body: unknown): Response {
  return Response.json(body);
}

describe("fetchGrokCliModels", () => {
  test("returns the static catalog when no API key is provided", async () => {
    const models = await fetchGrokCliModels(undefined, HEADERS, (async () => {
      throw new Error("fetch should not be called without an API key");
    }) as FetchImpl);
    expect(models).toBe(GROK_CLI_MODELS);
  });

  test("maps discovered models with exact proxy compatibility and bounded requests", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return jsonResponse({
        data: [
          {
            id: " grok-5 ",
            name: " Grok 5 ",
            context_window: 1_000_000,
            supports_reasoning_effort: true,
            reasoning_efforts: [{ value: "low" }, { value: "high" }],
          },
        ],
      });
    }) as FetchImpl;

    const models = await fetchGrokCliModels("key", HEADERS, fakeFetch);
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: "grok-5",
      name: "Grok 5",
      reasoning: true,
      supportsReasoningEffort: true,
      contextWindow: 1_000_000,
      thinking: { mode: "effort", efforts: ["low", "high"] },
      compat: {
        reasoningEffortMap: { minimal: "low" },
        includeEncryptedReasoning: false,
        filterReasoningHistory: true,
        supportsImageDetailOriginal: false,
        promptCacheSessionHeader: "x-grok-conv-id",
        supportsReasoningEffort: true,
        omitReasoningEffort: false,
      },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: "https://cli-chat-proxy.grok.com/v1/models",
      init: {
        redirect: "error",
        headers: {
          "x-grok-client-version": "9.8.7",
          accept: "application/json",
          authorization: "Bearer key",
        },
      },
    });
    expect(requests[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  test("treats valid empty and all-filtered discovery responses as authoritative", async () => {
    const empty = await fetchGrokCliModels("key", HEADERS, (async () => jsonResponse({ data: [] })) as FetchImpl);
    const filtered = await fetchGrokCliModels(
      "key",
      HEADERS,
      (async () => jsonResponse({ data: [{ id: "grok-imagine-v1" }] })) as FetchImpl,
    );

    expect(empty).toEqual([]);
    expect(filtered).toEqual([]);
  });

  test("deduplicates models and falls back from invalid context metadata", async () => {
    const models = await fetchGrokCliModels(
      "key",
      HEADERS,
      (async () =>
        jsonResponse({
          data: [
            { id: "grok-4.5", name: "First", context_window: 0 },
            { id: "grok-4.5", name: "Second", context_window: 999 },
            { id: "grok-new", context_window: 1.5 },
          ],
        })) as FetchImpl,
    );

    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({ id: "grok-4.5", name: "First", contextWindow: 500_000 });
    expect(models[1]).toMatchObject({ id: "grok-new", contextWindow: 200_000 });
  });

  test("falls back to the static catalog when discovery is unavailable or malformed", async () => {
    const invalidJson = await fetchGrokCliModels(
      "key",
      HEADERS,
      (async () => new Response("<html>proxy error</html>", { status: 200 })) as FetchImpl,
    );
    const unexpectedShape = await fetchGrokCliModels(
      "key",
      HEADERS,
      (async () => jsonResponse({ unexpected: true })) as FetchImpl,
    );
    const failedStatus = await fetchGrokCliModels(
      "key",
      HEADERS,
      (async () => new Response("nope", { status: 503 })) as FetchImpl,
    );
    const failedNetwork = await fetchGrokCliModels(
      "key",
      HEADERS,
      (async () => {
        throw new Error("network unavailable");
      }) as FetchImpl,
    );

    expect(invalidJson).toBe(GROK_CLI_MODELS);
    expect(unexpectedShape).toBe(GROK_CLI_MODELS);
    expect(failedStatus).toBe(GROK_CLI_MODELS);
    expect(failedNetwork).toBe(GROK_CLI_MODELS);
  });
});

describe("mapProxyModel", () => {
  test("filters all non-chat model families", () => {
    for (const id of ["grok-imagine-v1", "grok-stt-v1", "grok-voice-v1"]) {
      expect(mapProxyModel({ id })).toBeUndefined();
    }
  });

  test("drops reasoning metadata when the proxy reports no controllable efforts", () => {
    const mapped = mapProxyModel({
      id: "grok-composer-3",
      name: "Composer 3",
      supports_reasoning_effort: true,
      reasoning_efforts: [],
    });
    expect(mapped).toMatchObject({
      id: "grok-composer-3",
      reasoning: false,
      supportsReasoningEffort: false,
      compat: {
        supportsReasoningEffort: false,
        omitReasoningEffort: true,
        promptCacheSessionHeader: "x-grok-conv-id",
      },
    });
    expect(mapped).not.toHaveProperty("thinking");
  });
});
