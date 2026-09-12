# Neuro-Fit — 5-set evaluation protocol (run 2)

**31 reps · 5 sets · bodyweight only · ~20 minutes**

This executes `SCRIPT_PROTOCOL_V2`, already baked into `debug/evalLog.ts` as the
ground truth for every rep. Do **not** change the rep order — the exported log
labels each rep from this script, so a deviation silently mislabels the data.

> **Safety.** You are deliberately performing bad reps. **Bodyweight only, no load.**
> The lean and hip-shift reps are the ones that bite. Go to the *edge* of the fault,
> not past it. If anything pinches or hurts, stop that rep and note it — a missing
> rep is fine, an injury ends the test.

### What changed since the 2026-07-31 run

- **Faults are performed THROUGHOUT the rep**, not held at the bottom. That is what you
  actually did last time, it is what a real lifter does, and the depth gates were widened
  to match (lean 0.5 → 0.3, valgus 0.30 → 0.15). Hip shift is now read across the rep
  instead of from the bottom frame alone.
- **Set 1 has 7 reps** — a deliberate bounce rep was added, because `bounceMaxMs` was raised
  150 → 300 ms and has still never once fired. Nothing limits reps per set; just do 7 and
  press End set.
- **Set 3's baseline reps must stop VISIBLY ABOVE parallel.** Last run they measured
  0.032/0.036 against a 0.03 hygiene gate — over the line by thousandths — so the control
  never executed.

---

## Setup

1. `npm run dev` — dev mode is what enables the eval logger.
2. Console should print `[eval] DEV evaluation logging ON`. If not, the export won't exist.
3. **Settings → Squat depth target: PARALLEL.** Set 3's control only works at this preset.
4. **Settings → Training mode: BODYWEIGHT.**
5. **Settings → API calls: ON** (you're testing the AI tiers).
6. **Settings → Usage limit: OFF** (default — leave it, or it may block the last call).

**Camera**

- Whole body in frame, standing. Back up until your feet and head both fit with margin.
- Phone or laptop propped at roughly hip height. It uses the **front/selfie camera** only.
- Even lighting. Avoid a bright window behind you — auto-correction handles a lot, but backlight is its worst case.
- Same camera position for all 5 sets. Moving it between sets confounds every comparison.

**Per-set flow**

Stand still in the target orientation → the lock bar fills (1.2 s) → 3-2-1 countdown →
do your reps → **End set** → **Next set →** (this fires the debrief; read it) →
**Start set N →**.

**Set 5 is different: End set → End workout.** Set 5 gets no post-set debrief. That
is by design, not a bug — the last set goes straight to the session summary.

**Orientation is forced and alternates: S1 side, S2 front, S3 side, S4 front, S5 side.**
The app will not let you start a set in the wrong orientation.

---

## SET 1 — SIDE · lean and both descent sub-signals · **7 reps**

True profile to the camera. Reps 1–2 set this set's baseline — **they must be genuinely good**, or the rest of the set can't be judged against anything.

| Rep | Script label | What to do |
|---|---|---|
| 1 | baseline deep+slow | ~3 s descent. Hip crease clearly **to or just below** knee. Controlled, upright. |
| 2 | baseline deep+slow | Identical to rep 1. Consistency matters more than depth here. |
| 3 | normal | Your natural clean squat, ~2 s down. **Negative control — nothing should fire.** |
| 4 | FAST DROP (T2 spike) | Same depth, but **drop** — under 1 second, near free-fall, then stand up normally at a normal tempo. |
| 5 | moderate lean THROUGHOUT (T1) | Tip your chest forward ~10–15° past your normal position **from the first inch of the descent, and hold it all the way back up.** Not a dip at the bottom. |
| 6 | MAX lean THROUGHOUT (T1) | Same, but much further — near a good-morning the whole rep. **Clearly worse than rep 5.** |
| 7 | BOUNCE out of the bottom (T2 bounce) | **Reach full depth**, then reverse instantly — no pause at all, rebound straight back up. Depth matters: the bounce signal is now gated on the rep reaching depth, so a shallow bob won't test it. |

**Testing:** T1 fires twice at different severities (rep 6 must overwrite rep 5's archived
frame), the T2 **descent spike** fires on rep 4, the T2 **bounce** fires on rep 7, rep 3
stays clean. Rep 7 is the one number in the app with no true positive behind it — if it
still doesn't fire, note your reversal time from the log and we move the threshold again.

---

## SET 2 — FRONT · knee valgus ⚠️ **key acceptance test**

Square to the camera. **Keep your stance width identical on all 6 reps** — stance is the main confounder for valgus.

| Rep | Script label | What to do |
|---|---|---|
| 1 | baseline clean knees-out | Good depth, knees tracking out over your toes. |
| 2 | baseline clean knees-out | Identical. |
| 3 | normal | Clean rep. **Negative control.** |
| 4 | moderate cave THROUGHOUT | Let both knees drift inward — noticeably inside your ankles — **from partway down, through the bottom, and all the way up.** |
| 5 | normal | **Clean again.** Tests that the fault doesn't stick from rep 4. |
| 6 | MAX cave THROUGHOUT | Knees well inside the ankles, close to touching, **held through the ascent.** Clearly worse than rep 4. |

**Testing:** T7 fires on 4 and 6 only, rep 5 recovers cleanly, rep 6 becomes the archived peak.

**This set produced ZERO valgus fires last run** — including on two deliberate max caves —
because the depth gate discarded the ascent, which is exactly where your cave was worst.
The gate moved 0.30 → 0.15. **T7 firing here is the single most important result in the
run.** Keep the cave going while you stand up, not just at the bottom.

---

## SET 3 — SIDE · baseline-starvation control ⚠️

**This is the most interesting set, and its expected result is counterintuitive.**

Reps 1–2 stop **visibly above parallel** — hip crease a good couple of centimetres *higher*
than the knee. That is deep enough to *count*, but deliberately too shallow to *calibrate*
the baseline (the hygiene gate needs the bottom gap ~0.03 past target).

**Last run this was too deep by thousandths and the control never ran. Err high — an
obviously shallow rep 1–2 is the point of the set.**

| Rep | Script label | What to do |
|---|---|---|
| 1 | baseline ABOVE parallel (hip visibly high) | Stop well short of parallel. If it feels like a cheat rep, that's right. |
| 2 | baseline ABOVE parallel (hip visibly high) | Same. |
| 3 | normal | Clean rep, normal depth. |
| 4 | normal | Clean rep. |
| 5 | hard lean (EXPECT MISSED) | **Lean as hard as rep 1:6 did**, throughout the rep. A genuine, obvious fault. |
| 6 | normal | Clean rep. |

**Expected result: rep 5's lean does NOT fire.** With no valid baseline, the lean trigger
is correctly disarmed rather than guessing. **A silent rep 5 is a PASS.** Check the log:
reps 1–2 must show as rejected from the baseline. If they fed it again, your "above
parallel" was still too deep and the control is still untested.

---

## SET 4 — FRONT · hip shift and the depth gate

| Rep | Script label | What to do |
|---|---|---|
| 1 | baseline clean | Good depth, hips centred. |
| 2 | baseline clean | Identical. |
| 3 | normal | Clean. **Negative control.** |
| 4 | hip shift THROUGHOUT | Push your hips sideways over one foot and **keep them there for the whole rep, including the way up.** Pick a side and keep it for rep 5 too. |
| 5 | BIGGER hip shift THROUGHOUT | Same side, further, again held all the way up. |
| 6 | deliberately shallow | **Quarter squat** — about a third of normal depth, then stand. |

**Testing:** T11 fires on 4 and 5 (baseline-relative). Hip shift is now aggregated across
the rep with its own depth gate (≥ 0.3), so a shift performed on the ascent should be
visible for the first time — last run rep 4 read *below* baseline and was missed.

Rep 6 tests the **front depth gate (0.60)**. It should register as an attempt but **not
count**, and should appear in `uncounted_reps` with `basis: "depth_ratio"`.

---

## SET 5 — SIDE · clean control

All 6 reps: **your best, most honest squat.** Normal tempo, good depth, chest up, no
deliberate faults.

| Rep | Script label | What to do |
|---|---|---|
| 1–6 | normal | Clean reps throughout. |

**Testing:** the false-positive rate. **Nothing should fire on any of these 6 reps.**
This is the set that tells us whether the app nags a good lifter — and it is now the
control for four widened/raised thresholds, so it matters more than it did last run.

**End with: End set → End workout.**

---

## After the workout — important

1. **Stay on the report screen for ~30 seconds.** The session summary takes ~15 s, and the
   eval log auto-exports only *after* it lands. Closing early loses all the Gemini data.
2. The JSON + MD should download automatically. If not: **⬇ Download eval log** on the
   report, or `window.__neurofitEval.download()`.
3. **Settings → Export usage JSON** — second artifact, tests the usage ledger.
4. While it's fresh, jot down: **anywhere the app disagreed with what you felt you did.**
   Your subjective read is the only ground truth for whether a trigger was *right*, as
   opposed to merely consistent.

**Send me:** the eval log `.json`, the eval log `.md`, and the usage `.json`.

---

## What I'll check against

Predictions worth stating up front so the result is falsifiable.

**Acceptance tests for the fixes** (these are the ones that decide whether the last change worked):

| Expectation | Fix it verifies |
|---|---|
| **The eval-log trigger table and the payload's `triggers_fired` agree rep-for-rep** | `triggers_fired` now reads gated trigger flags, not the ungated metric warn. Last run they contradicted each other on S2 r6. |
| **`velocity_collapse_ratio` is NON-NULL on side sets 1, 3, 5** | `landmarkImplausible` is front-only now. Last run 18/18 side reps were flagged unreliable, deleting all fatigue evidence from half the sets. |
| **T7 valgus fires on S2 reps 4 and 6** | Valgus depth gate 0.30 → 0.15. Zero fires in 30 reps last time. |
| **T2 bounce fires on S1 rep 7** | `bounceMaxMs` 150 → 300 with a depth gate. Has never fired. |
| **S3 reps 3, 4, 6 stay silent on T2 descent** | `descentSpikeMult` 1.5 → 2.0. Two of these false-fired last run. |
| **`uncounted_reps` carries `measured` / `target` / `basis`** — `hip_knee_gap` on side sets, `depth_ratio` on front | Side sets were sending the agnostic hip ratio, which read *higher* on a rep that failed the gate. |

**Unchanged expectations** (regression checks):

| Expectation | Why it matters |
|---|---|
| S1 reps 5, 6 → T1 lean; rep 6 archived over rep 5 | Core trigger function + peak-severity frame selection |
| S2 rep 5 clean between two caves | Fault doesn't stick across reps |
| **S3 rep 5 → nothing, and reps 1–2 rejected from baseline** | The baseline hygiene gate — still untested |
| S4 reps 4, 5 → T11 shift | Now aggregated across the rep, gated ≥ 0.3 depth |
| **S4 rep 6 → uncounted** | The front depth gate (0.60) |
| **S5 → completely clean** | False-positive rate, against four loosened thresholds |
| **No T10 / levelness anywhere** | Both are demoted; firing = regression |
| T6 velocity collapse: context only | Must never appear as a cue |
| 4 post-set + 1 post-workout = 5 calls | Analysis fires only on explicit click |
| Usage: 1 workout, completed, 5 sets, ~29/31 counted | Ledger end-to-end |

I'll also read the Gemini debriefs for the failure modes the prompts are supposed to
prevent: claiming fatigue without velocity evidence **or pinning it on a rep whose own
ratio is above 1.0** (now checkable — per-rep ratios are in the payload), asserting that
one fault *caused* another (the post-workout prompt finally has that ban), commenting on
a plane the camera couldn't see, inferring frequency from photo count, and markdown
asterisks leaking through as literal characters.
