import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import type { FetchImpl, OAuthCredentials, OAuthLoginCallbacks } from "@oh-my-pi/pi-ai";
import { loginToGrok, nextDevicePollingInterval, parseGrokAuth, refreshGrokCredentials } from "../src/auth";

const originalGrokHome = process.env.GROK_HOME;
const temporaryHomes: string[] = [];

function callbacks(fetchImpl: FetchImpl, signal?: AbortSignal): OAuthLoginCallbacks {
  return {
    fetch: fetchImpl,
    signal,
    onAuth: () => {},
    onPrompt: async () => "",
  };
}

afterEach(async () => {
  if (originalGrokHome === undefined) delete process.env.GROK_HOME;
  else process.env.GROK_HOME = originalGrokHome;
  await Promise.all(temporaryHomes.splice(0).map(home => rm(home, { force: true, recursive: true })));
});

describe("parseGrokAuth", () => {
  test("prefers the configured OIDC client over other OIDC and legacy credentials", () => {
    const expires = "2026-07-12T12:00:00.000Z";
    const credentials = parseGrokAuth({
      "https://accounts.x.ai/sign-in": { key: "legacy-token" },
      "https://auth.x.ai::other-client": {
        key: "other-access",
        refresh_token: "other-refresh",
        expires_at: expires,
      },
      "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": {
        key: "oidc-access",
        refresh_token: "oidc-refresh",
        expires_at: expires,
        email: "user@example.com",
      },
    });

    expect(credentials).toEqual({
      access: "oidc-access",
      refresh: "oidc-refresh",
      expires: Date.parse(expires),
      email: "user@example.com",
    });
  });

  test("trims fields and makes malformed refreshable expiry immediately refreshable", () => {
    expect(
      parseGrokAuth(
        {
          "https://auth.x.ai::client-id": {
            key: " access ",
            refresh_token: " refresh ",
            expires_at: "invalid",
            email: " user@example.com ",
          },
        },
        42,
      ),
    ).toEqual({ access: "access", refresh: "refresh", expires: 42, email: "user@example.com" });
  });

  test("accepts the legacy CLI token format", () => {
    expect(
      parseGrokAuth({
        "https://accounts.x.ai/sign-in": { key: "legacy-token" },
      }),
    ).toBe("legacy-token");
  });

  test("rejects malformed credential files", () => {
    expect(parseGrokAuth(null)).toBeUndefined();
    expect(parseGrokAuth({ "https://auth.x.ai::client-id": { key: "" } })).toBeUndefined();
  });
});

describe("refreshGrokCredentials", () => {
  const current: OAuthCredentials = {
    access: "old-access",
    refresh: "old-refresh",
    expires: 1,
  };

  test("uses the xAI token endpoint with bounded no-redirect JSON requests", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return Response.json({ access_token: "new-access", expires_in: 3600 });
    }) as FetchImpl;

    const refreshed = await refreshGrokCredentials(current, "0.2.93", fakeFetch);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://auth.x.ai/oauth2/token");
    expect(requests[0]?.init).toMatchObject({ method: "POST", redirect: "error" });
    expect(requests[0]?.init?.headers).toMatchObject({
      accept: "application/json",
      "x-grok-client-version": "0.2.93",
      "x-grok-client-surface": "grok-build",
    });
    expect(requests[0]?.init?.signal).toBeInstanceOf(AbortSignal);
    expect(String(requests[0]?.init?.body)).toContain("grant_type=refresh_token");
    expect(String(requests[0]?.init?.body)).toContain("refresh_token=old-refresh");
    expect(refreshed).toMatchObject({ access: "new-access", refresh: "old-refresh" });
    expect(refreshed.expires).toBeGreaterThan(Date.now() + 3_500_000);
  });

  test("rejects malformed successful token responses", async () => {
    const fakeFetch = (async () => Response.json({ access_token: "new-access", expires_in: 0 })) as FetchImpl;
    await expect(refreshGrokCredentials(current, "0.2.93", fakeFetch)).rejects.toThrow(
      "Invalid Grok token refresh response",
    );
  });

  test("does not disclose OAuth response descriptions", async () => {
    const fakeFetch = (async () =>
      Response.json(
        { error: "invalid_grant", error_description: "secret-refresh" },
        { status: 400 },
      )) as FetchImpl;

    await expect(refreshGrokCredentials(current, "0.2.93", fakeFetch)).rejects.toThrow(
      "Grok token refresh failed: HTTP 400 invalid_grant",
    );
    await expect(refreshGrokCredentials(current, "0.2.93", fakeFetch)).rejects.not.toThrow("secret-refresh");
  });
});

describe("loginToGrok", () => {
  test("does not fetch when login is already cancelled", async () => {
    process.env.GROK_HOME = `${import.meta.dir}/missing-${crypto.randomUUID()}`;
    const controller = new AbortController();
    const cancelled = new Error("cancelled");
    controller.abort(cancelled);
    let fetches = 0;
    const fakeFetch = (async () => {
      fetches += 1;
      return Response.json({});
    }) as FetchImpl;

    await expect(loginToGrok(callbacks(fakeFetch, controller.signal), "0.2.93")).rejects.toBe(cancelled);
    expect(fetches).toBe(0);
  });

  test("propagates cancellation through an expired stored-credential refresh", async () => {
    const home = `${import.meta.dir}/.tmp-grok-auth-${crypto.randomUUID()}`;
    temporaryHomes.push(home);
    await mkdir(home, { recursive: true });
    await writeFile(
      `${home}/auth.json`,
      JSON.stringify({
        "https://auth.x.ai::client-id": {
          key: "access",
          refresh_token: "refresh",
          expires_at: "1970-01-01T00:00:00.000Z",
        },
      }),
    );
    process.env.GROK_HOME = home;
    const controller = new AbortController();
    const cancelled = new Error("cancelled");
    let fetches = 0;
    const fakeFetch = (async () => {
      fetches += 1;
      controller.abort(cancelled);
      throw cancelled;
    }) as FetchImpl;

    await expect(loginToGrok(callbacks(fakeFetch, controller.signal), "0.2.93")).rejects.toBe(cancelled);
    expect(fetches).toBe(1);
  });
  test("increases the next device polling interval after slow_down", () => {
    expect(nextDevicePollingInterval(1_000, "slow_down")).toBe(6_000);
    expect(nextDevicePollingInterval(1_000, "authorization_pending")).toBe(1_000);
  });

  test("rejects malformed successful device authorization responses", async () => {
    process.env.GROK_HOME = `${import.meta.dir}/missing-${crypto.randomUUID()}`;
    const requests: RequestInit[] = [];
    const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(init ?? {});
      return Response.json({ device_code: "device" });
    }) as FetchImpl;

    await expect(loginToGrok(callbacks(fakeFetch), "0.2.93")).rejects.toThrow(
      "Invalid Grok device authorization response",
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: "POST", redirect: "error" });
    expect(requests[0]?.signal).toBeInstanceOf(AbortSignal);
  });
});
