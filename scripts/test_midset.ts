/* Isolated mid_set Gemini smoke test — verify the connection BEFORE live MediaPipe.
 *
 *   PowerShell:  $env:GEMINI_API_KEY="AI..."; npm run test:midset
 *   bash:        GEMINI_API_KEY=AI... npm run test:midset
 *   (optional)   $env:GEMINI_MODEL="gemini-3.5-flash"   # override the model
 *
 * Self-contained: it does NOT import ai/gemini.ts (that reads Vite's import.meta.env,
 * which doesn't exist in Node). It replicates the mid-set request — hardcoded
 * trigger_data + one 1x1 test JPEG — and prints the raw response (or NO_CUE).
 */

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL ?? "gemini-3.6-flash";

if (!API_KEY) {
  console.error("GEMINI_API_KEY not set. PowerShell: $env:GEMINI_API_KEY=\"...\"; npm run test:midset");
  process.exit(1);
}

// A valid 1x1 JPEG (base64, no data: prefix) — enough to exercise the image part.
const TEST_JPEG_B64 =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAAv/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==";

const MIDSET_SYSTEM =
  "You are a knowledgeable squat coach giving real-time feedback during a set. You receive structured JSON data about a detected movement signal plus video frames. " +
  "Assess whether the signal is a real fault or a false positive; if false positive respond with only 'NO_CUE'. Otherwise give ONE concise spoken cue, max 2 sentences. " +
  "Match tone/verbosity to the delivery field; never mention JSON or that you received data. If preset_reason is 'mobility', never suggest going deeper.";

const triggerData = {
  call_type: "mid_set",
  trigger: { type: "forward_lean", sub_signal: null, severity_ratio: 1.4, phase: "bottom", sustained_ms: 150, timestamp_ms: 1000 },
  rep_context: { rep_number: 4, set_number: 1, orientation: "side", depth_ratio_at_trigger: 0.62, depth_preset: "parallel", preset_reason: "preference" },
  measured: { trunk_angle_deg: 46, baseline_trunk_angle_deg: 33, knee_deviation_normalized: null },
  causal_flags: { ankle_restriction_suspected: true, stance_width_normalized: 1.05, butt_wink_depth_flag: false },
  fatigue: { velocity_ratio_vs_baseline: 0.88, rep_in_set: 4 },
  history: { same_fault_this_set: 2, set_trend: "worsening", same_fault_last_set: 0 },
  skipped_calls: [],
  load_mode: "bodyweight",
  delivery: { tone: "encouraging", verbosity: "concise", user_name: "" },
};

const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;

const body = {
  contents: [
    {
      parts: [
        { text: MIDSET_SYSTEM },
        { text: JSON.stringify(triggerData) },
        { inline_data: { mime_type: "image/jpeg", data: TEST_JPEG_B64 } },
      ],
    },
  ],
  // Mirrors the app: mid-set → "low" thinking, no temperature, raised token cap
  // (thinking draws from maxOutputTokens). This is the exact live request shape.
  generationConfig: { maxOutputTokens: 1024, thinkingConfig: { thinkingLevel: "low" } },
};

console.log(`→ POST ${MODEL} (mid_set, forward_lean, 1 test frame, thinking=low)…`);
const res = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
if (!res.ok) {
  console.error(`FAIL  Gemini ${res.status}: ${(await res.text()).slice(0, 400)}`);
  process.exit(1);
}
const json = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
const text = (json.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim();
console.log("← response:", text || "(empty)");
console.log(text === "NO_CUE" ? "(model judged it a false positive → no cue)" : "PASS  connection + mid_set path works.");
