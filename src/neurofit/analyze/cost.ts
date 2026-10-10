/**
 * What an Analyze call will roughly cost, shown on the button before anything is sent. PURE.
 * ----------------------------------------------------------------------------
 * An estimate from ANALYZE.price / ANALYZE.tokens — the real token counts land in the usage
 * panel after each call. The user pays with their own key, so they see the number first.
 */
import { ANALYZE, type MediaResolution } from "./config";

export interface CostEstimate {
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

export function estimateCost(args: {
  images: number;
  resolution: MediaResolution;
  /** System prompt + JSON payload characters. */
  textChars: number;
  expectedOutputTokens: number;
}): CostEstimate {
  const inputTokens = Math.ceil(args.images * ANALYZE.tokens.perImage[args.resolution] + args.textChars / ANALYZE.tokens.charsPerToken);
  const outputTokens = args.expectedOutputTokens;
  const usd = (inputTokens * ANALYZE.price.inputPerMTok + outputTokens * ANALYZE.price.outputPerMTok) / 1e6;
  return { inputTokens, outputTokens, usd };
}

/** "under 1¢", "about 1¢", "about 3¢", "about $0.12". */
export function formatCost(usd: number): string {
  if (!(usd > 0)) return "free";
  const cents = usd * 100;
  if (cents < 0.95) return "under 1¢";
  if (cents < 99.5) return `about ${Math.round(cents)}¢`;
  return `about $${usd.toFixed(2)}`;
}
