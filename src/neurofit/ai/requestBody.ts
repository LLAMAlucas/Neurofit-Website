/**
 * The generateContent request body. PURE module (no fetch, no import.meta) so `check:analyze`
 * can prove the live coach's requests did not change when Analyze added options.
 * ----------------------------------------------------------------------------
 * Without `opts` the output is byte-for-byte what `geminiGenerate` sent before (system prompt as
 * the first user text part, the JSON payload as the second, inline JPEGs after; thinking level
 * and NO temperature on Gemini 3.x). Analyze adds a request-wide `mediaResolution` (the cost
 * lever: LOW = 280 tokens per image vs 1120 by default) and JSON output with a schema.
 */

export interface GenerateOptions {
  /** Request-wide image resolution, e.g. "MEDIA_RESOLUTION_LOW". */
  mediaResolution?: string;
  responseMimeType?: string;
  responseSchema?: Record<string, unknown>;
}

/** @param thinkingLevel null = thinking not sent (then temperature 0.4, the pre-3.x setting). */
export function buildGenerateBody(
  system: string,
  payload: unknown,
  images: readonly string[],
  maxTokens: number,
  thinkingLevel: string | null,
  opts?: GenerateOptions,
): string {
  const parts: Record<string, unknown>[] = [{ text: system }, { text: JSON.stringify(payload) }];
  for (const b64 of images) parts.push({ inline_data: { mime_type: "image/jpeg", data: b64 } });
  const generationConfig: Record<string, unknown> = { maxOutputTokens: maxTokens };
  if (thinkingLevel !== null) {
    // REST v1beta: thinking is nested under generationConfig.thinkingConfig.
    generationConfig.thinkingConfig = { thinkingLevel };
  } else {
    generationConfig.temperature = 0.4;
  }
  if (opts?.mediaResolution) generationConfig.mediaResolution = opts.mediaResolution;
  if (opts?.responseMimeType) generationConfig.responseMimeType = opts.responseMimeType;
  if (opts?.responseSchema) generationConfig.responseSchema = opts.responseSchema;
  return JSON.stringify({ contents: [{ parts }], generationConfig });
}
