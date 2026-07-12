import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { fetchBillingUsage, formatBillingUsage, registerUsageCommand } from "../src/usage";

describe("Grok Build billing", () => {
  test("fetches monthly and weekly subscription usage from the CLI proxy", async () => {
    const requests: Array<{ url: string; authorization?: string; tokenAuth?: string }> = [];
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      const url = String(input);
      requests.push({
        url,
        authorization: headers.authorization,
        tokenAuth: headers["x-xai-token-auth"],
      });
      if (url.endsWith("?format=credits")) {
        return Response.json({
          config: {
            creditUsagePercent: 42,
            currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-07-15T00:00:00Z" },
          },
        });
      }
      return Response.json({
        config: {
          monthlyLimit: { val: 15_000 },
          used: { val: 3_000 },
          billingPeriodEnd: "2026-08-01T00:00:00Z",
        },
      });
    }) as typeof fetch;

    const usage = await fetchBillingUsage("subscription-token", fakeFetch);

    expect(requests.map((request) => request.url)).toEqual([
      "https://cli-chat-proxy.grok.com/v1/billing",
      "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
    ]);
    expect(requests.every((request) => request.authorization === "Bearer subscription-token")).toBe(true);
    expect(requests.every((request) => request.tokenAuth === "xai-grok-cli")).toBe(true);
    expect(usage.monthly).toEqual({
      limit: 15_000,
      used: 3_000,
      resetsAt: "2026-08-01T00:00:00Z",
    });
    expect(usage.weekly).toEqual({ percentUsed: 42, resetsAt: "2026-07-15T00:00:00Z" });
    expect(formatBillingUsage(usage)).toContain("12,000 credits");
  });

  test("keeps monthly usage when the weekly credits endpoint returns malformed data", async () => {
    const fakeFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("?format=credits")) {
        return new Response("<html>error</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      return Response.json({
        config: {
          monthlyLimit: { val: 15_000 },
          used: { val: 3_000 },
          billingPeriodEnd: "2026-08-01T00:00:00Z",
        },
      });
    }) as typeof fetch;

    const usage = await fetchBillingUsage("subscription-token", fakeFetch);
    expect(usage.monthly).toEqual({ limit: 15_000, used: 3_000, resetsAt: "2026-08-01T00:00:00Z" });
    expect(usage.weekly).toBeUndefined();
  });

  test("omits weekly usage when the credits endpoint has an unexpected shape", async () => {
    const fakeFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("?format=credits")) {
        return Response.json({ config: { unexpected: true } });
      }
      return Response.json({
        config: {
          monthlyLimit: { val: 15_000 },
          used: { val: 3_000 },
          billingPeriodEnd: "2026-08-01T00:00:00Z",
        },
      });
    }) as typeof fetch;

    const usage = await fetchBillingUsage("subscription-token", fakeFetch);
    expect(usage.monthly.used).toBe(3_000);
    expect(usage.weekly).toBeUndefined();
  });

  test("still fails when the monthly response is malformed", async () => {
    const fakeFetch = (async () => Response.json({ config: { unexpected: true } })) as typeof fetch;
    await expect(fetchBillingUsage("subscription-token", fakeFetch)).rejects.toThrow(
      "Invalid Grok monthly billing response",
    );
  });
});

describe("grok-build-usage command", () => {
  const realFetch = globalThis.fetch;
  const originalGrokHome = process.env.GROK_HOME;

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (originalGrokHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = originalGrokHome;
  });

  function captureHandler() {
    let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
    const pi = {
      registerCommand(_name: string, config: { handler: (args: string, ctx: unknown) => Promise<void> }) {
        handler = config.handler;
      },
    } as unknown as ExtensionAPI;
    registerUsageCommand(pi);
    if (!handler) throw new Error("usage command was not registered");
    return handler;
  }

  function billingFetch(tokens: string[]): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      tokens.push(headers.authorization);
      const url = String(input);
      if (url.endsWith("?format=credits")) {
        return Response.json({
          config: { creditUsagePercent: 10, currentPeriod: { end: "2026-07-15T00:00:00Z" } },
        });
      }
      return Response.json({
        config: { monthlyLimit: { val: 100 }, used: { val: 10 }, billingPeriodEnd: "2026-08-01T00:00:00Z" },
      });
    }) as typeof fetch;
  }

  test("resolves the billing token through OMP provider auth before CLI credentials", async () => {
    const tokens: string[] = [];
    globalThis.fetch = billingFetch(tokens);
    const requestedProviders: string[] = [];
    let notified: string | undefined;

    const handler = captureHandler();
    await handler("", {
      modelRegistry: {
        async getApiKeyForProvider(provider: string) {
          requestedProviders.push(provider);
          return "omp-token";
        },
      },
      sessionManager: { getSessionId: () => "session-1" },
      ui: { notify: (message: string) => { notified = message; } },
    });

    expect(requestedProviders).toEqual(["grok-build"]);
    expect(tokens.every((token) => token === "Bearer omp-token")).toBe(true);
    expect(notified).toContain("Grok Build usage");
  });

  test("errors clearly when neither OMP auth nor CLI credentials resolve a token", async () => {
    // Point GROK_HOME at a directory with no auth.json so the CLI fallback misses.
    process.env.GROK_HOME = `${import.meta.dir}/no-such-grok-home`;
    const handler = captureHandler();
    await expect(
      handler("", {
        modelRegistry: { async getApiKeyForProvider() { return undefined; } },
        sessionManager: { getSessionId: () => "session-1" },
        ui: { notify: () => {} },
      }),
    ).rejects.toThrow("No Grok Build login found");
  });
});
