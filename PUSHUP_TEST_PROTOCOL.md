# Neuro-Fit — push-up evaluation protocol (run 1)

**32 attempts · 5 sets · toes · ~20 minutes**

This executes `PUSHUP_SCRIPT_PROTOCOL_V1`, baked into `debug/evalLog.ts` as the ground truth
for every attempt. **Change the two together** — the exported log labels each attempt from that
script, so a deviation silently mislabels the whole dataset. Do not change the attempt order.

Every push-up threshold is **UNVALIDATED (n=0)** — they were seeded from research and geometry,
not footage. This run is the first real data. It is designed so that every trigger has a
deliberate true positive, a clean negative control next to it, and one baseline-starvation control.

> **Safety.** You're doing deliberately bad reps. Hip sag loads the lower back and flared elbows
> load the shoulder — go to the *edge* of the fault, not past it. If anything pinches, skip that
> rep and note it. A missing rep is fine; an injury ends the test.

---

## Setup

1. `npm run dev` — dev mode enables the eval logger. Console prints `[eval] DEV evaluation logging ON`.
2. **Header → Push-ups.**
3. **Settings → Push-up variant: TOES.**
4. **Settings → Push-up depth target: UPPER ARM PARALLEL.** Set 3's control depends on it.
5. **Settings → API calls: ON**, usage limit OFF.

**Camera**

- **Phone on the floor**, landscape, about **2 m** away. Lens roughly at shoulder height when you're in a plank.
- **Side sets:** whole body in profile, head to feet with margin.
- **Head-on sets:** camera in front of your head, far enough that both hands and elbows are in frame.
- Keep the same spots for all side sets and all head-on sets. Moving the camera confounds every comparison.
- Even lighting; avoid a window behind you.

**Getting detected.** MediaPipe finds people by their face. **Start kneeling, facing the camera,
until the skeleton appears**, then turn/lower into the plank for that set. If the skeleton drops
out, come back up to kneeling.

**Per-set flow**

Get into the **top of a push-up** in the target view → the lock bar fills (1.2 s) → 3-2-1 →
do the attempts → **End set** → **Next set →** (fires the debrief; read it) → **Start set N →**.
Set 5 ends with **End set → End workout** (no post-set debrief by design).

**The lock needs a plank.** Standing or kneeling upright never starts a set — that is the plank
gate working, not a bug.

**Views alternate and are forced:** S1 side, S2 head-on, S3 side, S4 head-on, S5 side.

---

## SET 1 — SIDE · body line (both directions) + descent control · **7 attempts**

Reps 1–2 set this set's baseline — **they must be genuinely good**, or nothing after them can be judged.

| # | Script label | What to do |
|---|---|---|
| 1 | baseline clean (full depth + lockout) | ~2 s down, upper arm clearly **at or below parallel**, press to **fully straight arms**. Rigid plank. |
| 2 | baseline clean (full depth + lockout) | Identical to rep 1. |
| 3 | normal | Your natural clean push-up. **Negative control — nothing fires.** |
| 4 | FAST DROP (P2 descent spike) | Same depth, but **drop** in well under a second, then press up normally. |
| 5 | moderate hip sag THROUGHOUT (P1) | Let the hips sag ~10–15 cm below the line **from the first inch down and all the way back up.** |
| 6 | MAX hip sag THROUGHOUT (P1 absolute) | Much further — a clear banana back the whole rep. **Clearly worse than rep 5.** |
| 7 | hips PIKED high THROUGHOUT (P1 pike) | Hips pushed up toward a shallow inverted V the whole rep. |

**Testing:** P2 fires on rep 4; P1 fires on reps 5, 6 (sag) and 7 (pike), with rep 6 replacing
rep 5's archived sag frame; rep 3 is clean.

---

## SET 2 — HEAD-ON · elbow flare + uneven press · **6 attempts**

Same hand width for every rep (hands ~just outside shoulders).

| # | Script label | What to do |
|---|---|---|
| 1 | baseline elbows ~45° (tucked) | Elbows travel back at ~45° to your sides. Full depth, full lockout. |
| 2 | baseline elbows ~45° (tucked) | Identical. |
| 3 | normal | Clean. **Negative control.** |
| 4 | elbows FLARED to a T THROUGHOUT (P7) | Elbows straight out to the sides (a "T") on the way down **and** up. |
| 5 | normal | Clean again — **the fault must not stick.** |
| 6 | one side dips — uneven press THROUGHOUT (P11) | Let one shoulder sit clearly lower than the other the whole rep. |

**Testing:** P7 fires on rep 4 only; P11 (post-set) fires on rep 6; the debrief must not
mention hip sag or depth angle (head-on can't see them).

---

## SET 3 — SIDE · baseline-starvation control · **6 attempts**

| # | Script label | What to do |
|---|---|---|
| 1 | baseline SHALLOW (stop at elbows ~120°) | Only go about a third of the way down, then lock out. |
| 2 | baseline SHALLOW (stop at elbows ~120°) | Same. |
| 3 | normal | Clean full rep. |
| 4 | normal | Clean full rep. |
| 5 | big hip sag (EXPECT relative silent; absolute only if ≥25°) | A big sag through the whole rep. |
| 6 | normal | Clean full rep. |

**Testing:** reps 1–2 fail the hygiene gate (too shallow), so the body-line baseline and descent
baseline never resolve. Expect `baseline.valid: false` and `checks_disarmed` naming the body line
vs warm-up **and** descent control. Rep 5 must **not** fire relatively; it fires only via the
absolute 25° backstop, so its `basis` must be `absolute` if it fires at all. The debrief must say
those checks weren't evaluated, never that the set was clean. Reps 1–2 also count as **uncounted**
(depth miss) — that's correct.

---

## SET 4 — HEAD-ON · counting gates · **7 attempts**

| # | Script label | What to do |
|---|---|---|
| 1 | baseline clean | Full depth, full lockout. |
| 2 | baseline clean | Same. |
| 3 | normal | Clean. |
| 4 | NO LOCKOUT — rise halfway, sink back down (lockout_miss attempt) | From the bottom, press **about halfway up**, then lower straight back to the bottom **without locking out**. |
| 5 | press-out after the pulse (normal) | From that bottom, press all the way to straight arms. |
| 6 | deliberately shallow (front depth gate) | Only about a third of the way down, then lock out. |
| 7 | normal | Clean. |

**Testing:** attempt 4 is recorded as its own uncounted attempt with a `lockout_miss`; attempt 5
counts; attempt 6 is uncounted with a `depth_miss` in `depth_ratio` basis. The on-screen counter
flashes "Lockout not reached" then "Depth not met".

---

## SET 5 — SIDE · false-positive control · **6 attempts**

All 6: **your best, most honest push-up.** Normal tempo, full depth, straight arms at the top,
rigid body.

**Testing:** nothing fires on any rep. This is the set that tells us whether the app nags a good
lifter. **End with: End set → End workout.**

---

## Appendix — knee push-ups (optional, separate short workout)

After the main run: **Reset**, **Settings → variant: KNEES**, then do **two sets of 5 clean knee
push-ups** (set 1 side, set 2 head-on — the views still alternate) and finish with
**End set → End workout**. Label the reps from the console before starting:

```js
window.__neurofitEval.setScript({"1:1":"knees baseline","1:2":"knees baseline","1:3":"knees normal","1:4":"knees normal","1:5":"knees normal","2:1":"knees baseline","2:2":"knees baseline","2:3":"knees normal","2:4":"knees normal","2:5":"knees normal"})
```

**Testing:** no P1 fires on straight knee push-ups (the body line uses the knee), set 1's payload
shows `context.variant_check.observed: "knees"`, and knee reps still count on both views.

---

## After the workout

1. **Stay on the report for ~30 s** — the eval log auto-exports only after the session summary lands.
2. JSON + MD download automatically (or **⬇ Download eval log**, or `window.__neurofitEval.download()`).
3. **Settings → Export usage JSON.**
4. Note anywhere the app disagreed with what you felt you did.

**Send:** eval log `.json` + `.md`, usage `.json`.

---

## What I'll check against

| Expectation | What it validates |
|---|---|
| Eval-log trigger table and payload `triggers_fired` agree attempt-for-attempt | Trigger layer is the single source of fault truth |
| S1 r5/r6 sag, r7 pike; r3 clean | P1 relative + absolute thresholds, sign convention, frame archive replacement |
| S1 r4 descent spike, no P2 elsewhere in S1/S5 | P2 at 2.0× (slow warm-up lesson) |
| S2 r4 flare only; S2 r6 uneven press | P7 ratio 1.0 + depth gate; P11 baseline delta 8° |
| S3 `checks_disarmed` + rep 5 not relative | Baseline window + hygiene gate; absolute backstop |
| S4 a4 lockout_miss as its own attempt, a6 front depth miss | Partial-lockout segmentation; front ratio target 0.50 |
| S5 completely clean | False-positive rate across every threshold |
| Side payloads null every frontal field; head-on payloads null every sagittal field | Payload honesty |
| Lock never engages while standing | Plank gate |
| Facing readout: side ≈ 0–0.3, head-on ≥ 0.75, stable top→bottom | `PUSHUP_ORIENTATION.SCORE` anchors |
| Reversal times logged on every rep | First data for a future bounce threshold |
| 4 post-set + 1 post-workout calls | Explicit-click analysis only |

In the debriefs I'll look for: fatigue claimed without velocity evidence, one fault said to cause
another, body-line or depth commentary on head-on frames (or flare/evenness on side frames),
quoting normalized numbers or body-line degrees, and markdown leaking through as literal characters.

**Numbers to record per rep from the log** (these calibrate the UNVALIDATED values): bottom
upper-arm angle vs depth ratio (checks the 0.56·(1+sin θ) model), top elbow angle vs top ratio
(the 0.07 lockout), body-line peak on clean vs faulted reps (the 15°/25°/35° limits), flare peak
on tucked vs T reps (the 1.0 ratio), and reversal ms (bounce).
