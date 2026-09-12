# Evaluation review — 2026-07-31 run

> **STATUS: all nine findings below were fixed on 2026-07-31.** This document is kept as the
> evidence record for *why* the thresholds moved, not as an open worklist. Two of its
> conclusions were **wrong and were corrected during implementation** — see
> [Corrections](#corrections-after-implementation) at the end before citing anything here.
> Verification of the fixes is unit-level + replay only; the camera re-run (`TEST_PROTOCOL.md`)
> has not happened yet.

30 reps · 5 sets · 5 Gemini calls · 0 validation issues · all calls `finishReason: STOP`

**Verdict:** the plumbing is sound and the false-positive result is genuinely good. But
the run surfaced **three P1 defects**, two of which mean the data Gemini receives does not
match what the trigger layer actually decided. One prediction was confirmed dead, and one
designed control failed to execute.

---

## What passed

| Test | Result |
|---|---|
| **S5 clean control** | **0 triggers across 6 honest reps.** Lean 25.9–29.2° vs a 36.1° threshold; descent 0.39–0.49 vs 0.62. Comfortable margins, no nagging. This is the best result in the run. |
| **Front depth gate (S4 r6)** | Quarter squat measured 0.27 vs the 0.60 target → correctly **uncounted**, and correctly surfaced in `uncounted_reps`. The least-validated number in the app behaved exactly right. |
| **Peak-severity frame archive** | S1 sent 4 frames (2 baseline + lean peak + eccentric peak) with `peak_severity_ratio: 75.01` — rep 6's value, not rep 5's 45.1. The worse frame correctly overwrote the milder one. |
| **T1 forward lean** | Fired on exactly the intended reps (S1 5+6, S3 5). Never fired on a clean rep anywhere. |
| **Demoted metrics** | T10 knee symmetry and levelness never appear as eligible in any of 30 reps. No regression. |
| **T6 velocity collapse** | Evaluated on every eligible rep, fired on none, never surfaced as a cue. Context-only holding. |
| **Call structure** | 4 post-set + 1 post-workout. Set 5 correctly produced no post-set. No truncation; token headroom comfortable (post-set peak 5962+1840+194 of 8192). |
| **Markdown discipline** | Zero asterisks or headers leaked through in any of the 5 outputs. Rule 8 holding. |
| **Baseline-first (rule 1)** | All four debriefs opened with a baseline assessment. Full compliance. |

**Incidental confirmation of the T10 anti-correlation:** on the max-cave rep, knee symmetry
read **0.044** — its *most symmetric* value of the set — because both knees caved equally.
Third body, same inverted behaviour. Keeping it demoted is correct.

---

## P1 — Gemini is told a trigger fired that the trigger layer rejected

**S2 rep 6.** The eval log says:

```
T7_knee_valgus: 0.97 vs 0.72 [below] → no
```

The payload sent to Gemini says:

```json
{"type": "knee_valgus", "rep_numbers": [6], "peak_severity_ratio": 0.523}
```

Both are "correct" and they contradict each other. `firePostSet` builds `triggers_fired`
from `r.metrics[id].status === "warn"` — the **worst-of-all-frames** value with no
persistence gate and no depth gate. The live trigger uses `valgusTriggerActive`: per-frame,
`depthRatio ≥ 0.3`, held 150 ms. A single frame at 0.523 warns the metric; the trigger layer
correctly ignored it as unsustained.

So the model's claim — *"On rep 6, both knee valgus (knee cave) and a lateral shift were
triggered"* — **is not a hallucination.** It faithfully reported the payload. The bug is
upstream, and it is the more serious kind: the eval log and the AI payload disagree about
what happened, so the log cannot be used to audit the model.

It compounds: because `fireCoaching` was never called for valgus, **no valgus frame was
archived**. S2 shipped only 2 frames (both baselines). The payload asserts a fault with a
severity number and zero visual evidence.

**Fix:** `triggers_fired` should read the same per-rep trigger flags the trigger layer sets
(as `hipShift` already does via `shiftTriggered`), not the raw metric warn.

## P1 — 100% of side reps are flagged `landmarkUnreliable`

18/18 side reps flagged. 12/12 front reps clean. Visibility was **excellent** on all of them
(0.80–0.92) and `degraded: false` throughout — so this is not occlusion.

> ⚠️ **The mechanism named below is WRONG — see [Correction 2](#correction-2--the-culprit-arm-was-hipshift-not-levelness).**
> The finding and the fix (orientation-gate the function) both stand; the culprit arm does not.

`landmarkImplausible()` is **not orientation-gated**. It evaluates frontal-plane geometry on
side-view frames. Its levelness arm is the only one without a width guard:

```ts
if (frame.leftShoulder && frame.rightShoulder && frame.leftHip && frame.rightHip) {
  const diff = |shoulderTilt − hipTilt|;
  if (diff > 60) return true;
}
```

Edge-on, the shoulders are stacked — measured x-separation **0.0002 to 0.014**. The tilt of
two near-coincident points is numerically unstable and wraps sign. Measured differentials on
side reps: **204°, 219°, 278°, 287°**. On front reps, where separation is 0.084–0.099: **0.5°
to 4.6°**.

**Consequence, confirmed in the payloads:** `reliableReps` is empty on every side set, so

```
S1 context: {"velocity_collapse_ratio": null}
S3 context: {"velocity_collapse_ratio": null}
S2 context: {"velocity_collapse_ratio": 0.887}
S4 context: {"velocity_collapse_ratio": 0.729}
```

**Side sets can never carry fatigue evidence.** Per rule 3a the model then may not claim
fatigue there — and it correctly didn't, on either side set. The right outcome for the wrong
reason: the evidence wasn't weighed and found absent, it was silently deleted.

**Fix:** gate the frontal-plane arms of `landmarkImplausible` to front-view frames, or guard
the levelness arm on a minimum shoulder/hip x-separation.

## P1 — T7 valgus never fired, including on two deliberate max caves

> ⚠️ **This section's diagnosis is SUPERSEDED — see [Correction 1](#correction-1--t7s-threshold-is-not-unreachable).**
> The threshold is fine; the *depth gate* was the bug. The recommendation below (make it
> baseline-relative) was **not** implemented and should not be.

**0 fires in 30 reps.** Bottom-frame valgus ratio by rep:

| | baseline | normal | moderate cave | normal | MAX cave |
|---|---|---|---|---|---|
| **S2** | 1.37, 1.35 | 1.40 | **1.21** | 1.33 | **0.97** |

Threshold is 0.72. A max cave — knees close to touching — bottomed out at **0.97**. The
threshold is not marginally strict, it is unreachable.

The metric *does* track the movement (1.36 → 0.97 is a real 29% excursion). The absolute
threshold is what's wrong.

**Recommendation — make it baseline-relative, like T1 and T11.** But the n=1 data shows the
separation is thinner than expected, so this needs its own calibration pass rather than a
guessed constant:

| Set | baseline | normal reps (Δ) | intended cave (Δ) |
|---|---|---|---|
| S2 | 1.36 | +0.04, −0.03 | −0.15, **−0.39** |
| S4 | 1.34 | −0.06 | −0.16, −0.11, −0.21 *(these were shift/shallow reps, not caves)* |

A −0.15 delta catches both S2 caves but also fires on three S4 reps that weren't caves at
all. **Knee cave and hip shift are geometrically entangled in this metric** — worth knowing
before picking a number.

---

## P2 — T2 bounce sub-signal is confirmed dead

My prediction, now decisively confirmed. `bottom_bounce` vs the 150 ms threshold, all 30 reps:

- **Range: 268.7 ms – 1301.5 ms. Minimum 268.7 ms** — and that was the deliberate quarter squat.
- Typical real rep: **600–1300 ms**. Nothing came within 100 ms of the threshold.

`bounceMaxMs = 150` cannot fire on bodyweight squatting. A realistic value is **~300–400 ms**,
though at 300 ms the quarter squat would have tripped it — so it needs pairing with a depth
gate.

The descent-spike half works: it fired correctly on S1 r4 (0.59 vs 0.23).

## P2 — T2 descent fires false positives when warm-up reps are slower

Two "normal" reps fired T2:

- **S3 r4:** 0.39 vs 0.34 → FIRED (intended: normal)
- **S3 r6:** 0.35 vs 0.34 → FIRED (intended: normal)
- S3 r3: 0.34 vs 0.34 → near-miss by 0.001
- S1 r3: 0.22 vs 0.23 → near-miss

The mechanism is clean and generalises badly:

| Set | baseline reps | baseline descent | threshold (1.5×) | normal working reps | outcome |
|---|---|---|---|---|---|
| S1 | deep+slow | 0.156 | 0.23 | 0.22 | near-miss |
| S3 | exactly-parallel (slower) | 0.228 | 0.34 | 0.34–0.39 | **2 false positives** |
| S5 | normal speed | 0.415 | 0.62 | 0.39–0.49 | clean |

**When the warm-up is slower than the working reps, the descent baseline is depressed and
normal reps trip the trigger.** S5 — where baseline and working tempo matched — was flawless.

This is not a protocol artefact. Real users naturally warm up slower, so **T2 will over-fire
in the wild.** Either raise the multiplier above 1.5× or require a minimum absolute descent
speed alongside the ratio.

## P2 — T11 lateral shift is noisy

S4 (baseline 0.051, threshold 0.09):

| Rep | Intended | Measured | Fired | Verdict |
|---|---|---|---|---|
| 3 | normal | 0.11 | **FIRED** | false positive |
| 4 | hip shift | 0.04 | no | **miss** — read *below* baseline |
| 5 | BIGGER shift | 0.16 | FIRED | correct |
| 6 | shallow | 0.20 | FIRED | spurious (quarter squat) |

One correct fire out of four. Rep 4 is the concerning one: a deliberate shift measured
*lower* than a normal rep. There is directional signal (r5 > r4), but not enough separation
to be trustworthy.

---

## P3 — `uncounted_reps.depth_ratio` sends the wrong number for side sets

S3 rep 5 was uncounted because its **gap** was −0.022 (below the 0.0 parallel target). The
payload reports:

```json
{"rep_number": 5, "reason": "depth_miss", "depth_ratio": 0.688}
```

That's the orientation-agnostic hip-displacement ratio — **not** the gap that decided
counting. And 0.688 is *higher* than rep 1's 0.658, which counted. The model is being handed
data implying the depth gate is inconsistent.

It then reasoned: *"This shift in posture reduced your range of motion, causing rep 5 to miss
the parallel target depth."* Nothing in its payload supports "reduced range of motion" — the
number it was given says the opposite. It guessed, and happened to be right.

**Fix:** on side sets, send the gap (and the target), not the agnostic ratio.

## P3 — the post-workout prompt has no cross-fault causation ban

`POSTSET_SYSTEM` rule 3a explicitly bans claiming one fault caused another.
`POSTWORKOUT_SYSTEM` rule 5 covers fatigue only — **the causation ban was never carried
over.** It leaked exactly there:

> "loss of eccentric control ... coupled with forward torso lean, **which directly caused** a
> missed depth target on set 3 rep 5"

Same sentence contains a **factual error**: on S3 rep 5, T2 eccentric control did **not**
fire (0.28 vs 0.34 → no). Only T1 and the depth gate fired. The per-set debrief had it right;
the post-workout synthesis merged two separate reps into a false composite.

**Fix:** port rule 3a's causation clause into `POSTWORKOUT_SYSTEM`.

## P3 — fatigue claims are permitted but unattributable

Both front-set debriefs claimed fatigue, and both were *technically* within rule 3a
(`velocity_collapse_ratio` present and < 1.0). But both localised it wrongly:

- **S2:** *"your movement speed slowed slightly on that final rep"* — rep 6's ratio was **1.18**, i.e. faster.
- **S4:** *"The decrease in speed across the set"* — actual sequence 0.84, 0.73, 0.90, 0.95 — *increasing* after rep 4.

The payload sends a single session-minimum with no rep attribution, so **any rep-specific
fatigue claim is necessarily a guess.** Either send per-rep ratios or forbid attributing
fatigue to a specific rep.

---

## Your two observations

**S3 rep 5 — you were right.** Gap −0.022 against a 0.0 target; correctly uncounted. Trunk
angle 84.3°, so the lean was extreme enough that depth genuinely went.

But it means **the Set 3 control did not execute.** It needed reps 1–2 *below* the 0.03
hygiene threshold. They measured **0.032 and 0.036** — over the line by two to six
thousandths. So the baseline *was* established (lean 25.9°), and T1 firing on rep 5 is
**correct behaviour, not a gate failure.**

The baseline-starvation gate remains **untested**. To retest, reps 1–2 need to stop
*slightly above* parallel — hip crease visibly a centimetre or two high, not level.

**S4 rep 6 — good news, you were wrong.** It registered fine:

```
depth_ratio 0.267 · front_depth_gate FIRED · counted NO
uncounted_reps: [{"rep_number": 6, "depth_ratio": 0.2675}]
```

The debrief even cited it: *"cut short well above your parallel depth target with a depth
ratio of 0.27."* That is a clean pass of the exact test it was designed for.

---

## Latency (relevant to the product, not just the code)

| Call | Frames | Latency |
|---|---|---|
| S1 post-set | 4 | **26.4 s** |
| S3 post-set | 4 | **26.3 s** |
| S2 post-set | 2 | 14.3 s |
| S4 post-set | 2 | 11.8 s |
| Post-workout | 0 | 13.3 s |

**Frames dominate.** Two extra images roughly doubles the wait. A set with faults — i.e. the
set the user most wants feedback on — is the slowest, at ~26 s standing between sets.

---

## Recommended order of work

> *Historical — all seven were done. Item 7's advice ("do not guess a new constant") was
> followed in the sense that no constant was guessed: the threshold turned out to be correct
> and only its depth gate moved. See Correction 1.*

1. **`triggers_fired` from trigger flags, not metric warn** — the log can't audit the model until this agrees.
2. **Orientation-gate `landmarkImplausible`** — restores fatigue context to half of all sets.
3. **Port rule 3a's causation ban into `POSTWORKOUT_SYSTEM`** — one paragraph, removes a demonstrated false claim.
4. **Side-set `uncounted_reps.depth_ratio` → send the gap.**
5. **`bounceMaxMs` 150 → ~350 ms with a depth gate** — currently dead code that never fires.
6. **T2 descent: raise the multiplier or add an absolute floor** — will over-fire on real users.
7. **T7 valgus: dedicated calibration pass** — do not guess a new constant; the cave/shift entanglement needs its own session.

Nothing here is a reason to stop. The core loop works, the clean set was clean, and the
frame archive did its job. Items 1 and 2 are the ones that matter most, because until they're
fixed **the eval log and the AI payload are telling different stories** — which undermines
every future calibration run.

---

**Usage JSON — received and reconciled.** 5 calls matching this log exactly, 12 images,
29,323 tokens, latency p50 14.3 s / p95 26.4 s, **28/30 reps counted** as predicted, and
3 workouts / 1 completed = **33% completion rate** — which is the result that justifies
upsert-by-`sessionId`: recording only on finish would have reported a meaningless 100%.
The quota gate was separately proven in-browser: at 4/4 with a live key, `callPostSet`
returned null, recorded `skipped_quota`, and **zero requests reached the API**.

---

## Corrections after implementation

### Correction 1 — T7's threshold is not "unreachable"

The P1 section above concluded the 0.72 valgus threshold was unreachable because a max cave
"bottomed out at 0.97", and recommended a baseline-relative rewrite. **That analysis used
bottom-frame values only.** Reconstructing the full rep from the landmark buffer:

| depth | phase | ratio | < 0.72 | past the old 0.30 gate |
|---|---|---|---|---|
| 0.77 | bottom | 0.92 | — | yes |
| 0.43 | ascent | 0.82 | — | yes |
| **0.37 → 0.30** | ascent | **0.63 → 0.59** | **YES** | yes — but only **77 ms** |
| **0.28 → 0.11** | ascent | **0.57 → 0.52** | **YES** | **no — discarded** |

The cave was **worst during the ascent**, and the depth gate discarded exactly that part of
the rep. T7 missed the 150 ms `PersistenceGate` by ~73 ms. The threshold never needed
changing — the gate did (0.30 → **0.15**, giving 6 qualifying frames ≈ 275 ms on that rep).

Separation is clean at 0.15: minimum ratio was **0.996** (normal), **0.867** (big hip shift)
and **1.078** (quarter squat) — zero sub-threshold frames on any non-cave rep.

**This also invalidated a decision already made on the wrong framing** (a "conservative
baseline-relative rewrite" had been chosen from the bad diagnosis). No rewrite was done.

### Correction 2 — the culprit arm was hipShift, not levelness

The P1 section blames the levelness arm and its 204–287° tilt differentials. Those figures came
from a probe using raw `atan2`; the real `lineTiltDeg` **normalizes to ±90°**, so that arm
cannot produce them. Recomputed with the actual code semantics, the **hipShift arm** trips on
~100% of side frames (28–50 per rep): edge-on, `hipWidth` collapses to ~**0.007** and becomes
a tiny denominator (0.0235 offset / 0.007 = 3.36 against a 1.5 bound).

The fix is unchanged — orientation-gate the whole function — but the distinction matters:
**widening the bounds would not have worked.** Those quantities are *undefined* edge-on, not
merely extreme.

---

## Resolution

| # | Finding | Outcome |
|---|---|---|
| P1 | `triggers_fired` from metric warns | Fixed — `RepRecord.triggeredMetrics` snapshots the gated flags; per-fault sourcing in `firePostSet` |
| P1 | 100% of side reps `landmarkUnreliable` | Fixed — `landmarkImplausible` is front-only (see Correction 2) |
| P1 | T7 never fires | Fixed — depth gate 0.30 → 0.15 (see Correction 1); threshold untouched |
| P2 | T2 bounce dead | Fixed — `bounceMaxMs` 150 → 300 **+ `reachedDepth` gate**; ⚠️ still no true positive |
| P2 | T2 descent false positives | Fixed — `descentSpikeMult` 1.5 → 2.0 |
| P2 | T11 noisy | **Partly** — now aggregated across the rep (gate ≥ 0.3), which addresses the r4 miss. Still needs its own calibration session |
| P3 | `uncounted_reps` sends the wrong number | Fixed — `{measured, target, basis}` |
| P3 | No causation ban in `POSTWORKOUT_SYSTEM` | Fixed — rules 5a/5b |
| P3 | Fatigue unattributable | Fixed — `velocity_ratios_by_rep` + rule 3a extension |

Also fixed from the "throughout the rep, not at the bottom" principle the lifter raised after
the run: lean depth gate 0.5 → 0.3, and `hipShift` added to `AGGREGATED_METRICS`.

**Verified:** 190 `check:squat` assertions (up from 170, including a replay of this run's real
measurements), clean `tsc -b` and `vite build`. **Not verified:** anything requiring a camera —
`onRepComplete` has never executed with the new fields. `TEST_PROTOCOL.md` run 2 is the real test.
