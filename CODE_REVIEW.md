# Neuro-Fit — logistical review

Findings from a full read of `src/neurofit/`, `scripts/`, and the config/docs.
Ordered by consequence.

> **Status as of 2026-07-31:** items **1** (idempotency) and **2** (deep-analysis button) are
> **done**. Item **11**'s documentation drift is **partly** cleared — `CLAUDE.md` and
> `TOLERANCE_VALIDATION.md` were corrected; `scripts/test_midset.ts` still tests the removed
> path. Everything else below is still open. **The repo is still not a git repository**, which
> is why none of these deletions are trivially reversible — that remains the single highest-value
> thing to fix before touching any of the rest.

---

## Fixed in this change

### 1. `finishWorkout` was not idempotent — duplicate post-workout charge
`hooks/useWorkout.ts`

A second call re-ran `synthesize()` and fired a **second `callPostWorkout`** for
the same session. Hard to hit today (the button disables and the report view
replaces the camera), but it was the one money-spending path with no gate in front
of it, and I was adding a usage write there. Now guarded:

```ts
if (phaseRef.current === "finished") return;
```

---

## Cost / correctness — recommend action

### 2. ✅ DONE — The "Generate" deep-analysis button costs money and *replaces better output with worse*
`components/SynthesisReport.tsx` → `useWorkout.runDeepAnalysis` → `gemini.deepAnalysis`

**Resolved 2026-07-31:** the button, `runDeepAnalysis` and `deepAnalysis()` were all deleted;
`analysis` renders read-only. Original finding kept below for the rationale.

On finish, `firePostWorkout()` already writes a good summary into `analysis`. The
`AI DEEP ANALYSIS / Generate` button then calls the **legacy** `deepAnalysis()`,
which uses an older, weaker prompt with none of the evidence-binding rules, and
**overwrites** the good summary. So a click buys a second API call to make the
output worse.

**Recommend:** delete the button and `runDeepAnalysis`, and render `analysis`
read-only. If a regenerate affordance is wanted, point it at `firePostWorkout`.

### 3. Client-side quota is a spend guard, not enforcement
`usage/usageStore.ts` (added in this change)

Worth stating plainly since the point of the ledger is future limiting: the cap
reads localStorage, so clearing site data resets it. The API key is also inlined
into the bundle at build time and readable in devtools on any deployed build.
**Real per-user limiting requires the key to move behind a proxy** — the ledger is
the measurement layer that tells you what the limit should be, not the mechanism
that enforces it. The panel copy says this.

---

## Dead code and vestigial UI (from the removed mid-set tier)

### 4. "Mid-set cues" report section can never populate
`session/synthesis.ts`, `components/SynthesisReport.tsx`, `hooks/useWorkout.ts`

`coachingByRepRef` is read and cleared but **never written** — nothing calls
`.set()`. So `RepRecord.coaching` is always null, `report.coachingCues` is always
empty, and every expanded set renders *"No mid-set cues this set."*

**Recommend:** remove the section, plus `CoachingCue`, `RepCoaching`,
`RepRecord.coaching`, and `coachingByRepRef`.

### 5. ~140 lines of unreachable Gemini code
`ai/gemini.ts`

`requestCoaching()` has zero callers. With it: `CoachingInput`, `Coaching`,
`CoachingResult`, `COACHING_SCHEMA`, `buildCoachingPrompt`, `contextBlock`,
`triggerPhrase`, `parseCoaching`, `fmt`, `CheckSnapshot`.

It also still sends `temperature: 0.4`, which contradicts the documented Gemini 3.x
guidance in `config.ts` (omit temperature; lowering it risks thinking loops). If
anyone revives it as a template, they inherit a known-wrong parameter.

**Recommend:** delete. Git history is the archive — except this isn't a git repo
(see #11), which is its own argument for deleting rather than keeping "just in case".

### 6. `npm run test:midset` tests a request shape the app no longer sends
`scripts/test_midset.ts`

It exercises a `mid_set` call type that was removed. It spends real API quota to
validate nothing that ships. `CLAUDE.md` still describes it as *"the exact live
Gemini request shape."*

**Recommend:** repoint it at the post-set shape, or delete it.

### 7. `MetricTier: "midset"` no longer means what it says
`squat/metrics.ts`

`forwardLean`, `eccentricControl` and `kneeValgus` are tagged `tier: "midset"`, and
`ai/coaching.ts` still documents "Only MID-SET-tier metrics ever reach here."
Accurate mechanically — those three are exactly the triggers that can tag a frame —
but the name now means "can archive a fault frame for the post-set debrief," not
"can cue mid-set."

**Recommend:** rename to `"trigger"` or update the doc comments.

---

## Production polish

### 8. Debug calibration overlays render for end users
`App.tsx:127-128` → `CoachCamera.drawCoachPose`

`debugGap` / `debugValgus` are passed unconditionally, so `gap +0.02` and
`valgus 0.85` are drawn on the live video in production builds. These are
calibration instruments, and they make the app read as a dev tool on camera.

**Recommend:** gate behind `import.meta.env.DEV` or a Settings toggle — they're
genuinely useful for tuning, so a toggle is probably better than deletion.

### 9. The whole app re-renders 10×/sec regardless of phase
`hooks/useWorkout.ts` — the 100 ms interval calls `setLive({...})` with a fresh
object every tick, including while sitting on the Settings tab or the finished
report, where nothing it produces is displayed.

Not urgent on desktop; it is a battery cost on the phone the product is aimed at.

**Recommend:** skip the `setLive` when `phase === "finished"` and the values are
unchanged, or shallow-compare before setting.

---

## Documentation drift

These will actively mislead anyone (or any agent) working from them:

| File | Says | Reality | Status |
|---|---|---|---|
| `CLAUDE.md` | Mid-set cues T1/T2/T7 fire coaching through a rate limiter | Mid-set tier removed; triggers only archive frames | ✅ corrected |
| `CLAUDE.md` | `test:midset` = "exact live Gemini request shape" | Tests a removed call type | ✅ corrected (now flagged stale) |
| `TOLERANCE_VALIDATION.md` | `valgusRatioWarn` 0.8 | Actually **0.72** | ✅ corrected |
| `TOLERANCE_VALIDATION.md` | front parallel target 0.66 | Actually **0.60** | ✅ corrected |
| `TOLERANCE_VALIDATION.md` | see `SPIKE_EXCLUDED` in `ai/coaching.ts` | No longer exists | ✅ corrected |
| `TOLERANCE_VALIDATION.md` | T1/T2/T7/T11 threshold table | All four moved in the 2026-07-31 fix batch | ✅ corrected |
| `ai/gemini.ts` header | "Two calls: requestCoaching / deepAnalysis" | Live tiers are `callPostSet` + `callPostWorkout` | ✅ corrected |
| `App.tsx` footer | "the AI coach is consulted only when rep speed drops (fatigue), not on a timer" | Both halves wrong — velocity collapse is deliberately context-only and never fires; analysis fires only on an explicit click | ❌ **open — user-facing** |
| `scripts/test_midset.ts` | — | Still wired to `npm run test:midset`, still tests the removed mid-set path | ❌ open |
| `.claude/launch.json` | dev config named `stakefit` | Deleted predecessor project | ❌ open |

### 10. `App.tsx` header comment claims StakeFit source is still on disk
> "StakeFit source remains on disk as reference but isn't rendered."

It was deleted (2026-06-22).

### 11. Not a git repository
`git status` reports no repo. Every deletion recommended above is currently
irreversible, which is precisely why they keep not happening. **`git init` first**
— it makes the rest of this list cheap and safe.
