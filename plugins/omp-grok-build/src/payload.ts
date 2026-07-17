export function sanitizeProxyPayload(
  payload: unknown,
  supportsReasoning: boolean,
  sessionId?: string,
): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const next = payload as Record<string, unknown>;

  if (Array.isArray(next.input)) {
    next.input = next.input.filter((item) => {
      if (!item || typeof item !== "object") return true;
      const value = item as Record<string, unknown>;
      if (value.type === "reasoning") return false;
      return value.content !== "";
    });
  }

  if (supportsReasoning) {
    const reasoning = next.reasoning;
    if (reasoning && typeof reasoning === "object") {
      const value = reasoning as Record<string, unknown>;
      if (value.effort === "minimal") value.effort = "low";
      delete value.summary;
    }
  } else {
    delete next.reasoning;
    delete next.reasoningEffort;
  }

  const include = next.include;
  if (Array.isArray(include)) {
    const filtered = include.filter((item) => item !== "reasoning.encrypted_content");
    if (filtered.length === 0) delete next.include;
    else next.include = filtered;
  }

  delete next.prompt_cache_retention;
  if (sessionId && !next.prompt_cache_key) next.prompt_cache_key = sessionId;
  return next;
}
