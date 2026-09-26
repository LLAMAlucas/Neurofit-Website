/**
 * DEV A/B replay: re-send the Gemini calls saved in an eval log to a model of your choice
 * and print the old reply next to the new one.
 *
 *   GEMINI_API_KEY=… npm run replay:calls -- neurofit_eval_<stamp>.json --model <id>
 *     [--tier post_set|post_workout|all]   default post_set
 *     [--out results.json]                 also write every reply + token counts as JSON
 *     [--dry-run]                          show what would be sent; no key, no network
 *
 * Each call is rebuilt from the log alone — the system prompt as sent, the payload, the frames
 * as sent and the generationConfig — through the same generateBody() the app uses, so only
 * the model changes. Logs exported before 2026-09-26 have no frames or prompt and are skipped.
 * The key is read from this process's env: a Node script, never bundled into the app.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { generateBody, generateEndpoint } from "../src/neurofit/ai/requestBody";

interface LoggedCall {
  tier: string;
  timestampMs: number;
  set: number | null;
  payload: unknown;
  frames_sent: { count: number; images?: { jpegBase64: string }[] };
  request?: { model: string; system: string; generationConfig: Record<string, unknown> } | null;
  response_raw: string | null;
  finish_reason: string | null;
  prompt_tokens: number | null;
  candidates_tokens: number | null;
  thoughts_tokens: number | null;
  skipped: boolean;
}

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

const file = process.argv.slice(2).find((a, i, all) => !a.startsWith("--") && !(i > 0 && ["--model", "--tier", "--out"].includes(all[i - 1])));
if (!file) {
  console.error("usage: npm run replay:calls -- <eval.json> --model <id> [--tier post_set|post_workout|all] [--out file] [--dry-run]");
  process.exit(1);
}
const tier = arg("--tier") ?? "post_set";
const dryRun = process.argv.includes("--dry-run");
const log = JSON.parse(readFileSync(file, "utf8")) as { gemini_calls?: LoggedCall[] };
const calls = (log.gemini_calls ?? []).filter((c) => !c.skipped && (tier === "all" || c.tier === tier));

const key = process.env.GEMINI_API_KEY ?? "";
if (!dryRun && !key) {
  console.error("Set GEMINI_API_KEY (or pass --dry-run).");
  process.exit(1);
}

const results: unknown[] = [];
let replayable = 0;
for (const c of calls) {
  const label = `${c.tier} set ${c.set ?? "?"} @${c.timestampMs}`;
  const images = (c.frames_sent.images ?? []).map((f) => f.jpegBase64);
  if (!c.request || images.length !== c.frames_sent.count) {
    console.log(`\n## ${label}\nSKIPPED — this log has no saved ${c.request ? "frames" : "prompt"} for it (exported before 2026-09-26?).`);
    continue;
  }
  replayable++;
  const model = arg("--model") ?? c.request.model;
  const body = generateBody(c.request.system, c.payload, images, c.request.generationConfig);
  if (dryRun) {
    const kb = Math.round(JSON.stringify(body).length / 1024);
    console.log(`\n## ${label}\nwould send to ${model}: ${images.length} frames, ${kb} KB, config ${JSON.stringify(c.request.generationConfig)}`);
    continue;
  }
  const t0 = Date.now();
  const res = await fetch(generateEndpoint(model), {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify(body),
  });
  const latencyMs = Date.now() - t0;
  const json = (await res.json().catch(() => null)) as {
    candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
    error?: { message?: string };
  } | null;
  const cand = json?.candidates?.[0];
  const text = cand?.content?.parts?.map((p) => p.text ?? "").join("").trim() || null;
  const um = json?.usageMetadata;
  const out = {
    tier: c.tier,
    set: c.set,
    timestampMs: c.timestampMs,
    frames: images.length,
    original: {
      model: c.request.model,
      text: c.response_raw,
      finish_reason: c.finish_reason,
      tokens: { prompt: c.prompt_tokens, output: c.candidates_tokens, thinking: c.thoughts_tokens },
    },
    replay: {
      model,
      status: res.status,
      latency_ms: latencyMs,
      text,
      finish_reason: cand?.finishReason ?? null,
      tokens: { prompt: um?.promptTokenCount ?? null, output: um?.candidatesTokenCount ?? null, thinking: um?.thoughtsTokenCount ?? null },
      error: res.ok ? null : json?.error?.message ?? `HTTP ${res.status}`,
    },
  };
  results.push(out);
  const tok = (t: { prompt: number | null; output: number | null; thinking: number | null }) =>
    `${t.prompt ?? "?"} in / ${t.output ?? "?"} out / ${t.thinking ?? "?"} thinking`;
  console.log(`\n## ${label} (${images.length} frames)`);
  console.log(`--- original · ${out.original.model} · ${out.original.finish_reason ?? "?"} · ${tok(out.original.tokens)}\n${c.response_raw ?? "(no text)"}`);
  console.log(`--- replay · ${model} · ${out.replay.finish_reason ?? out.replay.error} · ${tok(out.replay.tokens)} · ${latencyMs} ms\n${text ?? "(no text)"}`);
}

console.log(`\n${replayable}/${calls.length} ${tier} call(s) replayable${dryRun ? " (dry run — nothing sent)" : ""}.`);
const outFile = arg("--out");
if (outFile && !dryRun) {
  writeFileSync(outFile, JSON.stringify(results, null, 2));
  console.log(`wrote ${outFile}`);
}
