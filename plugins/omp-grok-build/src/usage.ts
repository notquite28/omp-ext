import type { FetchImpl } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { loadGrokCliCredentials } from "./auth";

const BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing";
const BILLING_REQUEST_TIMEOUT_MS = 10_000;

export interface BillingUsage {
  monthly: {
    limit: number;
    used: number;
    resetsAt: string;
  };
  weekly?: {
    percentUsed: number;
    resetsAt: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function numericValue(value: unknown): number | undefined {
  const candidate = isRecord(value) ? value.val : value;
  if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  if (typeof candidate !== "string" || !candidate.trim()) return undefined;
  const parsed = Number(candidate);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function validTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const timestamp = value.trim();
  return timestamp && Number.isFinite(Date.parse(timestamp)) ? timestamp : undefined;
}

function configFrom(payload: unknown): Record<string, unknown> | undefined {
  return isRecord(payload) && isRecord(payload.config) ? payload.config : undefined;
}

function billingHeaders(token: string): Record<string, string> {
  return {
    accept: "application/json",
    authorization: `Bearer ${token}`,
    "x-xai-token-auth": "xai-grok-cli",
  };
}

function requestOptions(headers: Record<string, string>): RequestInit {
  return {
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(BILLING_REQUEST_TIMEOUT_MS),
  };
}

export async function fetchBillingUsage(token: string, fetchImpl: FetchImpl = fetch): Promise<BillingUsage> {
  const headers = billingHeaders(token);
  let monthlyResponse: Response;
  try {
    monthlyResponse = await fetchImpl(BILLING_URL, requestOptions(headers));
  } catch {
    throw new Error("Grok billing request failed");
  }
  if (!monthlyResponse.ok) throw new Error(`Grok billing endpoint returned HTTP ${monthlyResponse.status}`);

  let monthlyPayload: unknown;
  try {
    monthlyPayload = await monthlyResponse.json();
  } catch {
    throw new Error("Invalid Grok monthly billing response");
  }
  const monthlyConfig = configFrom(monthlyPayload);
  const limit = monthlyConfig ? numericValue(monthlyConfig.monthlyLimit) : undefined;
  const used = monthlyConfig ? numericValue(monthlyConfig.used) : undefined;
  const resetsAt = monthlyConfig ? validTimestamp(monthlyConfig.billingPeriodEnd) : undefined;
  if (limit === undefined || used === undefined || limit < 0 || used < 0 || !resetsAt) {
    throw new Error("Invalid Grok monthly billing response");
  }

  const usage: BillingUsage = { monthly: { limit, used, resetsAt } };
  try {
    const weeklyResponse = await fetchImpl(`${BILLING_URL}?format=credits`, requestOptions(headers));
    if (!weeklyResponse.ok) return usage;

    const weeklyConfig = configFrom(await weeklyResponse.json());
    if (!weeklyConfig) return usage;
    const currentPeriod = isRecord(weeklyConfig.currentPeriod) ? weeklyConfig.currentPeriod : undefined;
    const percentUsed = numericValue(weeklyConfig.creditUsagePercent);
    const weeklyReset = validTimestamp(currentPeriod?.end) ?? validTimestamp(weeklyConfig.billingPeriodEnd);
    if (percentUsed !== undefined && percentUsed >= 0 && percentUsed <= 100 && weeklyReset) {
      usage.weekly = { percentUsed, resetsAt: weeklyReset };
    }
  } catch {
    // Weekly data is optional: malformed, unavailable, or timed-out credits
    // data must not hide the already-parsed monthly balance.
  }
  return usage;
}

function formatReset(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value;
}

export function formatBillingUsage(usage: BillingUsage): string {
  const percent = usage.monthly.limit > 0 ? Math.round((usage.monthly.used / usage.monthly.limit) * 100) : 0;
  const remaining = Math.max(usage.monthly.limit - usage.monthly.used, 0);
  const lines = [
    "Grok Build usage",
    `Monthly: ${usage.monthly.used.toLocaleString()} / ${usage.monthly.limit.toLocaleString()} credits (${percent}% used)`,
    `Remaining: ${remaining.toLocaleString()} credits`,
    `Monthly reset: ${formatReset(usage.monthly.resetsAt)}`,
  ];
  if (usage.weekly) {
    lines.push(
      `Weekly: ${Math.round(usage.weekly.percentUsed)}% used`,
      `Weekly reset: ${formatReset(usage.weekly.resetsAt)}`,
    );
  }
  return lines.join("\n");
}

const PROVIDER_ID = "grok-build";

export async function resolveUsageToken(ctx: ExtensionContext): Promise<string | undefined> {
  // Prefer OMP's provider auth storage: it covers credentials created by
  // `/login grok-build` and runs them through the provider refresh pipeline,
  // re-minting expired access tokens instead of returning a billing 401.
  try {
    const token = await ctx.modelRegistry?.getApiKeyForProvider(
      PROVIDER_ID,
      ctx.sessionManager?.getSessionId(),
    );
    if (token) return token;
  } catch {
    // Fall through to the local Grok CLI credentials.
  }

  const credentials = await loadGrokCliCredentials();
  return typeof credentials === "string" ? credentials : credentials?.access;
}

export function registerUsageCommand(pi: ExtensionAPI): void {
  pi.registerCommand("grok-build-usage", {
    description: "Show Grok Build subscription usage",
    handler: async (_args, ctx) => {
      const token = await resolveUsageToken(ctx);
      if (!token) throw new Error("No Grok Build login found. Run `/login grok-build` or `grok login`.");
      ctx.ui.notify(formatBillingUsage(await fetchBillingUsage(token)), "info");
    },
  });
}
