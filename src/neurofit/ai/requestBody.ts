/**
 * The generateContent request body. PURE — shared by ai/gemini.ts (the app) and
 * scripts/replay_calls.ts (dev A/B replay) so a replayed call is byte-for-byte the shape the
 * app sent. If they drifted, a model comparison would also be a request comparison.
 */
export function generateBody(
  system: string,
  payload: unknown,
  images: readonly string[],
  generationConfig: Record<string, unknown>,
): { contents: { parts: Record<string, unknown>[] }[]; generationConfig: Record<string, unknown> } {
  const parts: Record<string, unknown>[] = [{ text: system }, { text: JSON.stringify(payload) }];
  for (const b64 of images) parts.push({ inline_data: { mime_type: "image/jpeg", data: b64 } });
  return { contents: [{ parts }], generationConfig };
}

export const generateEndpoint = (model: string): string =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
