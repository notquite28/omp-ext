import { describe, expect, test } from "bun:test";
import { sanitizeProxyPayload } from "../src/payload";

describe("sanitizeProxyPayload", () => {
  test("keeps reasoning params for a reasoning-capable model and normalizes minimal effort", () => {
    const result = sanitizeProxyPayload(
      { reasoning: { effort: "minimal", summary: "auto" }, reasoningEffort: "minimal" },
      true,
    ) as Record<string, unknown>;
    expect(result.reasoning).toEqual({ effort: "low" });
    expect(result.reasoningEffort).toBe("minimal");
  });

  test("preserves reasoning for a dynamically discovered model reported as reasoning-capable", () => {
    // Model id is not in the static catalog, but the live metadata says it
    // supports reasoning effort, so the params must survive.
    const result = sanitizeProxyPayload(
      { reasoning: { effort: "high" } },
      true,
    ) as Record<string, unknown>;
    expect(result.reasoning).toEqual({ effort: "high" });
  });

  test("strips reasoning params for a non-reasoning model", () => {
    const result = sanitizeProxyPayload(
      { reasoning: { effort: "high" }, reasoningEffort: "high" },
      false,
    ) as Record<string, unknown>;
    expect(result).not.toHaveProperty("reasoning");
    expect(result).not.toHaveProperty("reasoningEffort");
  });

  test("removes reasoning input items and encrypted-content includes", () => {
    const result = sanitizeProxyPayload(
      {
        input: [
          { type: "reasoning", content: "thinking" },
          { type: "message", content: "" },
          { type: "message", content: "keep" },
        ],
        include: ["reasoning.encrypted_content"],
      },
      true,
    ) as Record<string, unknown>;
    expect(result.input).toEqual([{ type: "message", content: "keep" }]);
    expect(result).not.toHaveProperty("include");
  });

  test("injects the session id as the prompt cache key and drops retention", () => {
    const result = sanitizeProxyPayload(
      { prompt_cache_retention: "24h" },
      false,
      "session-123",
    ) as Record<string, unknown>;
    expect(result).not.toHaveProperty("prompt_cache_retention");
    expect(result.prompt_cache_key).toBe("session-123");
  });
});
