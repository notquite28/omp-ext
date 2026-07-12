import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI, ProviderConfig } from "@oh-my-pi/pi-coding-agent";
import grokBuildExtension from "../src/main";

const originalVersion = process.env.GROK_CLI_VERSION;
const BASE_URL = "https://cli-chat-proxy.grok.com/v1";
type ProviderHook = (
  event: { payload: unknown },
  ctx: {
    model?: {
      provider?: string;
      baseUrl?: string;
      thinking?: { efforts?: string[] };
    };
    sessionManager?: { getSessionId(): string | undefined };
  },
) => unknown;

afterEach(() => {
  if (originalVersion === undefined) delete process.env.GROK_CLI_VERSION;
  else process.env.GROK_CLI_VERSION = originalVersion;
});

describe("Grok Build provider", () => {
  test("routes only through the CLI entitlement proxy with required headers", async () => {
    process.env.GROK_CLI_VERSION = "9.8.7";
    let registration: { name: string; config: ProviderConfig } | undefined;
    const pi = {
      registerProvider(name: string, config: ProviderConfig) {
        registration = { name, config };
      },
      registerCommand() {},
      on() {},
    } as unknown as ExtensionAPI;

    grokBuildExtension(pi);

    expect(registration?.name).toBe("grok-build");
    expect(registration?.config.baseUrl).toBe(BASE_URL);
    expect(registration?.config.baseUrl).not.toContain("api.x.ai");
    expect(registration?.config.api).toBe("openai-responses");
    expect(registration?.config.authHeader).toBe(true);
    expect(registration?.config.headers).toBeUndefined();
    expect(registration?.config.models).toBeUndefined();
    expect(registration?.config.fetchDynamicModels).toBeFunction();

    const models = await registration?.config.fetchDynamicModels?.(undefined);
    expect(models?.map((model) => model.id)).toEqual([
      "grok-4.5",
      "grok-composer-2.5-fast",
    ]);
    expect(models?.find((model) => model.id === "grok-4.5")).toMatchObject({
      id: "grok-4.5",
      reasoning: true,
      contextWindow: 500_000,
      maxTokens: 30_000,
      compat: { promptCacheSessionHeader: "x-grok-conv-id", supportsReasoningEffort: true },
      headers: {
        "X-XAI-Token-Auth": "xai-grok-cli",
        "x-grok-model-override": "grok-4.5",
        "x-grok-client-version": "9.8.7",
        "x-grok-client-identifier": "grok-pager",
      },
    });
  });

  test("sanitizes only canonical Grok Build requests", () => {
    let hook: ProviderHook | undefined;
    const pi = {
      registerProvider() {},
      registerCommand() {},
      on(_event: string, handler: ProviderHook) {
        hook = handler;
      },
    } as unknown as ExtensionAPI;

    grokBuildExtension(pi);
    expect(hook).toBeDefined();

    const otherPayload = { reasoning: { effort: "high", summary: "auto" } };
    expect(
      hook?.({ payload: otherPayload }, { model: { provider: "other", baseUrl: "https://example.com/v1" } }),
    ).toBeUndefined();
    expect(otherPayload).toEqual({ reasoning: { effort: "high", summary: "auto" } });

    const payload = { reasoning: { effort: "minimal", summary: "auto" }, prompt_cache_retention: "24h" };
    expect(
      hook?.(
        { payload },
        {
          model: { provider: "grok-build", baseUrl: BASE_URL, thinking: { efforts: ["low", "high"] } },
          sessionManager: { getSessionId: () => "session-123" },
        },
      ),
    ).toEqual({ reasoning: { effort: "low" }, prompt_cache_key: "session-123" });

    expect(() =>
      hook?.({ payload: {} }, { model: { provider: "grok-build", baseUrl: "https://example.com/v1" } }),
    ).toThrow(`Grok Build requests require the canonical base URL ${BASE_URL}`);
  });
});
