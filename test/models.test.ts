import { describe, expect, test } from "bun:test";
import { fetchGrokCliModels, GROK_CLI_MODELS, mapProxyModel } from "../src/models";

const HEADERS = { "x-grok-client-version": "9.8.7" };

function jsonResponse(body: unknown): Response {
  return Response.json(body);
}

describe("fetchGrokCliModels", () => {
  test("returns the static catalog when no API key is provided", async () => {
    const models = await fetchGrokCliModels(undefined, HEADERS, (async () => {
      throw new Error("fetch should not be called without an API key");
    }) as unknown as typeof fetch);
    expect(models).toBe(GROK_CLI_MODELS);
  });

  test("maps a dynamically discovered reasoning model", async () => {
    const fakeFetch = (async () =>
      jsonResponse({
        data: [
          {
            id: "grok-5",
            name: "Grok 5",
            context_window: 1_000_000,
            supports_reasoning_effort: true,
            reasoning_efforts: [{ value: "low" }, { value: "high" }],
          },
        ],
      })) as typeof fetch;

    const models = await fetchGrokCliModels("key", HEADERS, fakeFetch);
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: "grok-5",
      name: "Grok 5",
      reasoning: true,
      supportsReasoningEffort: true,
      contextWindow: 1_000_000,
      thinking: { mode: "openai", efforts: ["low", "high"] },
    });
  });

  test("falls back to the static catalog on HTTP 200 with invalid JSON", async () => {
    const fakeFetch = (async () =>
      new Response("<html>proxy error</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })) as typeof fetch;

    const models = await fetchGrokCliModels("key", HEADERS, fakeFetch);
    expect(models).toBe(GROK_CLI_MODELS);
  });

  test("falls back to the static catalog on an unexpected shape", async () => {
    const fakeFetch = (async () => jsonResponse({ unexpected: true })) as typeof fetch;
    const models = await fetchGrokCliModels("key", HEADERS, fakeFetch);
    expect(models).toBe(GROK_CLI_MODELS);
  });

  test("falls back to the static catalog on a non-2xx response", async () => {
    const fakeFetch = (async () => new Response("nope", { status: 503 })) as typeof fetch;
    const models = await fetchGrokCliModels("key", HEADERS, fakeFetch);
    expect(models).toBe(GROK_CLI_MODELS);
  });
});

describe("mapProxyModel", () => {
  test("drops reasoning metadata when the proxy reports no controllable efforts", () => {
    const mapped = mapProxyModel({
      id: "grok-composer-3",
      name: "Composer 3",
      supports_reasoning_effort: true,
      reasoning_efforts: [],
    });
    expect(mapped).toMatchObject({ id: "grok-composer-3", reasoning: false, supportsReasoningEffort: false });
    expect(mapped).not.toHaveProperty("thinking");
  });
});
