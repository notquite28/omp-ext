import type { FetchImpl, OAuthCredentials, OAuthLoginCallbacks } from "@oh-my-pi/pi-ai";

const DEFAULT_ISSUER = "https://auth.x.ai";
const DEFAULT_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const DEFAULT_SCOPE = "openid profile email offline_access grok-cli:access api:access";
const DEVICE_CODE_ENDPOINT = `${DEFAULT_ISSUER}/oauth2/device/code`;
const TOKEN_ENDPOINT = `${DEFAULT_ISSUER}/oauth2/token`;
const GROK_SURFACE = "grok-build";
const EARLY_REFRESH_MS = 5 * 60 * 1000;
const AUTH_REQUEST_TIMEOUT_MS = 20_000;
const FALLBACK_VERSION = "0.2.93";
const LEGACY_AUTH_SCOPE = "https://accounts.x.ai/sign-in";
const SAFE_OAUTH_ERRORS: Record<string, true> = {
  invalid_request: true,
  invalid_client: true,
  invalid_grant: true,
  unauthorized_client: true,
  unsupported_grant_type: true,
  invalid_scope: true,
};

interface GrokAuthEntry {
  key?: unknown;
  refresh_token?: unknown;
  expires_at?: unknown;
  email?: unknown;
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function positiveFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function nextDevicePollingInterval(intervalMs: number, error: string | undefined): number {
  return error === "slow_down" ? intervalMs + 5_000 : intervalMs;
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error("Authentication cancelled");
}


function oauthFailure(operation: string, response: Response, payload: unknown): Error {
  const code = isRecord(payload) ? nonEmptyString(payload.error) : undefined;
  return new Error(`${operation} failed: HTTP ${response.status}${code && SAFE_OAUTH_ERRORS[code] ? ` ${code}` : ""}`);
}

async function responseJson(response: Response): Promise<unknown> {
  return response.json().catch(() => undefined);
}

function parseDeviceCodeResponse(payload: unknown): DeviceCodeResponse {
  if (!isRecord(payload)) throw new Error("Invalid Grok device authorization response");

  const deviceCode = nonEmptyString(payload.device_code);
  const userCode = nonEmptyString(payload.user_code);
  const verificationUri = nonEmptyString(payload.verification_uri);
  const expiresIn = positiveFiniteNumber(payload.expires_in);
  const interval = payload.interval === undefined ? undefined : positiveFiniteNumber(payload.interval);
  if (!deviceCode || !userCode || !verificationUri || !expiresIn || (payload.interval !== undefined && !interval)) {
    throw new Error("Invalid Grok device authorization response");
  }

  return {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: verificationUri,
    ...(nonEmptyString(payload.verification_uri_complete)
      ? { verification_uri_complete: nonEmptyString(payload.verification_uri_complete) }
      : {}),
    expires_in: expiresIn,
    ...(interval ? { interval } : {}),
  };
}

function parseTokenResponse(
  payload: unknown,
  operation: string,
  refreshFallback?: string,
): OAuthCredentials {
  if (!isRecord(payload)) throw new Error(`Invalid ${operation} response`);

  const access = nonEmptyString(payload.access_token);
  const refresh = nonEmptyString(payload.refresh_token) ?? nonEmptyString(refreshFallback);
  const expiresIn = positiveFiniteNumber(payload.expires_in);
  if (!access || !refresh || !expiresIn) throw new Error(`Invalid ${operation} response`);

  return {
    access,
    refresh,
    expires: Date.now() + expiresIn * 1000,
  };
}

export function resolveGrokVersion(): string {
  const configured = process.env.GROK_CLI_VERSION?.trim();
  if (configured) return configured;

  try {
    const result = Bun.spawnSync(["grok", "--version"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const match = result.stdout.toString().match(/\bgrok\s+([0-9]+\.[0-9]+\.[0-9]+(?:-[^\s]+)?)/i);
    return match?.[1] ?? FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
}

function parseAuthEntry(entry: unknown, now: number): OAuthCredentials | string | undefined {
  if (!isRecord(entry)) return undefined;

  const { key, refresh_token: refreshToken, expires_at: expiresAt, email } = entry as GrokAuthEntry;
  const access = nonEmptyString(key);
  if (!access) return undefined;

  const refresh = nonEmptyString(refreshToken);
  if (!refresh) return access;

  const expiryText = nonEmptyString(expiresAt);
  const parsedExpiry = expiryText ? Date.parse(expiryText) : Number.NaN;
  return {
    access,
    refresh,
    expires: Number.isFinite(parsedExpiry) ? parsedExpiry : now,
    ...(nonEmptyString(email) ? { email: nonEmptyString(email) } : {}),
  };
}

export function parseGrokAuth(auth: unknown, now = Date.now()): OAuthCredentials | string | undefined {
  if (!isRecord(auth)) return undefined;

  const entries = Object.entries(auth);
  const exactOidc = entries.find(([scope]) => scope === `${DEFAULT_ISSUER}::${DEFAULT_CLIENT_ID}`)?.[1];
  const preferred = parseAuthEntry(exactOidc, now);
  if (preferred) return preferred;

  for (const [scope, entry] of entries) {
    if (!scope.startsWith(`${DEFAULT_ISSUER}::`)) continue;
    const parsed = parseAuthEntry(entry, now);
    if (parsed) return parsed;
  }

  return parseAuthEntry(entries.find(([scope]) => scope === LEGACY_AUTH_SCOPE)?.[1], now);
}

export async function loadGrokCliCredentials(): Promise<OAuthCredentials | string | undefined> {
  const home = process.env.GROK_HOME?.trim() || `${process.env.HOME}/.grok`;
  try {
    return parseGrokAuth(await Bun.file(`${home}/auth.json`).json());
  } catch {
    return undefined;
  }
}

function requestHeaders(version: string): Record<string, string> {
  return {
    accept: "application/json",
    "content-type": "application/x-www-form-urlencoded",
    "x-grok-client-version": version,
    "x-grok-client-surface": GROK_SURFACE,
  };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfCancelled(signal);

  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const timer = setTimeout(() => {
    signal?.removeEventListener("abort", abort);
    resolve();
  }, ms);
  const abort = () => {
    clearTimeout(timer);
    reject(signal?.reason ?? new Error("Authentication cancelled"));
  };
  signal?.addEventListener("abort", abort, { once: true });
  return promise;
}

export async function refreshGrokCredentials(
  credentials: OAuthCredentials,
  version = resolveGrokVersion(),
  fetchImpl: FetchImpl = fetch,
  signal?: AbortSignal,
): Promise<OAuthCredentials> {
  throwIfCancelled(signal);
  const response = await fetchImpl(TOKEN_ENDPOINT, {
    method: "POST",
    headers: requestHeaders(version),
    body: new URLSearchParams({
      client_id: DEFAULT_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: credentials.refresh,
    }),
    redirect: "error",
    signal: requestSignal(signal),
  });
  const payload = await responseJson(response);
  if (!response.ok) throw oauthFailure("Grok token refresh", response, payload);

  const refreshed = parseTokenResponse(payload, "Grok token refresh", credentials.refresh);
  return { ...credentials, ...refreshed };
}

export async function loginToGrok(
  callbacks: OAuthLoginCallbacks,
  version = resolveGrokVersion(),
): Promise<OAuthCredentials | string> {
  throwIfCancelled(callbacks.signal);
  const stored = await loadGrokCliCredentials();
  if (typeof stored === "string") {
    callbacks.onProgress?.("Using credentials from the Grok Build CLI");
    return stored;
  }
  if (stored) {
    if (stored.expires > Date.now() + EARLY_REFRESH_MS) {
      callbacks.onProgress?.("Using credentials from the Grok Build CLI");
      return stored;
    }
    try {
      callbacks.onProgress?.("Refreshing Grok Build CLI credentials");
      return await refreshGrokCredentials(stored, version, callbacks.fetch ?? fetch, callbacks.signal);
    } catch (error) {
      throwIfCancelled(callbacks.signal);
      callbacks.onProgress?.("Stored Grok credentials expired; starting device login");
    }
  }

  throwIfCancelled(callbacks.signal);
  const fetchImpl = callbacks.fetch ?? fetch;
  const deviceResponse = await fetchImpl(DEVICE_CODE_ENDPOINT, {
    method: "POST",
    headers: requestHeaders(version),
    body: new URLSearchParams({ client_id: DEFAULT_CLIENT_ID, scope: DEFAULT_SCOPE }),
    redirect: "error",
    signal: requestSignal(callbacks.signal),
  });
  const devicePayload = await responseJson(deviceResponse);
  if (!deviceResponse.ok) throw oauthFailure("Grok device authorization", deviceResponse, devicePayload);
  const device = parseDeviceCodeResponse(devicePayload);
  callbacks.onAuth({
    url: device.verification_uri_complete || device.verification_uri,
    instructions: `Confirm code ${device.user_code}. Only continue with a code you requested.`,
  });

  const deadline = Date.now() + device.expires_in * 1000;
  let intervalMs = Math.max(device.interval ?? 5, 1) * 1000;
  callbacks.onProgress?.("Waiting for Grok authorization");

  while (Date.now() < deadline) {
    await delay(intervalMs, callbacks.signal);
    throwIfCancelled(callbacks.signal);
    const response = await fetchImpl(TOKEN_ENDPOINT, {
      method: "POST",
      headers: requestHeaders(version),
      body: new URLSearchParams({
        client_id: DEFAULT_CLIENT_ID,
        device_code: device.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
      redirect: "error",
      signal: requestSignal(callbacks.signal),
    });
    const payload = await responseJson(response);
    const error = isRecord(payload) ? nonEmptyString(payload.error) : undefined;
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      intervalMs = nextDevicePollingInterval(intervalMs, error);
      continue;
    }
    if (error === "access_denied") throw new Error("Grok authorization was denied");
    if (error === "expired_token") throw new Error("Grok device code expired");
    if (!response.ok) throw oauthFailure("Grok token exchange", response, payload);
    return parseTokenResponse(payload, "Grok token exchange");
  }

  throw new Error("Grok device code expired");
}
