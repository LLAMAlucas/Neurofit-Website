# Neuro-Fit — pull-up evaluation protocol (run 1)

**23 attempts · 4 sets · overhand grip · ~20 minutes with full rests**

This executes `PULLUP_SCRIPT_PROTOCOL_V1`, baked into `debug/evalLog.ts` as the ground truth
for every attempt. **Change the two together** — the exported log labels each attempt from that
script, so a deviation silently mislabels the whole dataset. Do not change the attempt order.

Every pull-up threshold is **UNVALIDATED (n=0)** — they were seeded from test standards (USMC,
CrossFit, China's student fitness test), published biomechanics and geometry, not footage. This run
is the first real data. Every trigger gets a deliberate true positive, a clean negative control
next to it, and one baseline-starvation control.

> **Safety.** Kipping and dropping into a dead hang load the shoulders and elbows hard. Keep the
> faulted reps *moderate* — enough to be obvious on camera, never violent. If you can't do 6 strict
> pull-ups per set, rest longer or split a set; a missing rep is fine, an injury ends the test.
> Don't use a band — it changes what the legs do.

---

## Setup

1. `npm run dev` — dev mode enables the eval logger. Console prints `[eval] DEV evaluation logging ON`.
2. **Header → Pull-ups.**
3. **Settings → Pull-up grip: OVERHAND.**
4. **Settings → Pull-up top target: CHIN OVER BAR.**
5. **Settings → Camera views: ALTERNATE VIEWS.** (Head-on only is for doorway bars — this run needs side sets.)
6. **Settings → API calls: ON**, usage limit OFF.

**Camera**

- Phone at roughly **chest height**, landscape or portrait, about **3 m** away.
- **Everything in frame, the whole time:** the bar, your hands on it, your face at the top of the
  rep, and your feet in the hang. The chin-over-bar check reads your face against your knuckles —
  if the bar or your hands leave the frame, the top falls back to a cruder shoulder-height estimate.
- **Head-on sets:** the camera faces you (your face, not your back — from behind there's no chin to read).
- **Side sets:** square side-on, same distance.
- Keep the same spots for all head-on sets and all side sets. Even lighting; no window behind you.

**Per-set flow**

Stand **under the bar** in the target view → the lock bar fills (1.2 s) → 3-2-1 → **jump up and
hang** (a second of dead hang before rep 1) → do the attempts → drop down → **End set** →
**Next set →** (fires the debrief; read it) → **Start set N →**. Set 4 ends with
**End set → End workout** (no post-set debrief by design).

**Why you lock standing:** hanging through a 1.2 s lock and a 3 s countdown would burn your grip
before rep 1. The Phase readout shows **—** until you're on the bar, then **HANG** / **PULL**.

**Views alternate:** S1 head-on, S2 side, S3 head-on, S4 side. Pull-ups start head-on — it is the
view that sees the chin against the bar.

**Between every rep, lower to a genuine dead hang (straight arms)** unless the script says
otherwise. The full-hang gate is judged at the START of each rep.

---

## SET 1 — HEAD-ON · top gate + uneven pull + lowering control · **6 attempts**

Reps 1–2 set this set's baseline — **they must be genuinely good**, or nothing after them can be judged.

| # | Script label | What to do |
|---|---|---|
| 1 | baseline clean (dead hang → chin over) | From straight arms, pull until the chin clearly clears the bar; lower over ~2 s to straight arms. |
| 2 | baseline clean (dead hang → chin over) | Identical to rep 1. |
| 3 | normal | Your natural clean rep. **Negative control — nothing fires.** |
| 4 | STOP SHORT — chin clearly below the bar (top_miss) | Pull until your chin is a few centimetres **under** the bar, then lower. |
| 5 | ONE ARM LEADS — lopsided pull THROUGHOUT (U4) | Let one shoulder rise clearly higher than the other for the whole pull. |
| 6 | FAST DROP into the hang (U2) | Full rep, then **drop** to straight arms in well under a second (control the very bottom). |

**Testing:** rep 4 is uncounted with a `top_miss` in `chin_clearance` basis; U4 fires on rep 5
only; U2 fires on rep 6; rep 3 is clean. The debrief must not mention swing, kipping or leg drive
(head-on can't see them).

---

## SET 2 — SIDE · body swing + leg drive · **6 attempts**

| # | Script label | What to do |
|---|---|---|
| 1 | baseline strict (legs still) | Strict rep, body still, legs quiet. |
| 2 | baseline strict (legs still) | Identical. |
| 3 | normal | Clean strict rep. **Negative control.** |
| 4 | KIP — swing the hips back then drive through (U1) | In the hang, swing the hips back, then swing forward and use it to help the pull. |
| 5 | KNEE DRIVE — tuck the knees up hard on the pull (U3) | Body otherwise still; drive both knees up toward the chest as you pull. |
| 6 | normal | Clean strict rep again — **the faults must not stick.** |

**Testing:** U1 fires on rep 4 (almost certainly `basis: absolute` — a kip passes 20°); U3 fires
on rep 5; reps 3 and 6 clean. The debrief must not mention left/right evenness or grip width
(side-on can't see them).

---

## SET 3 — HEAD-ON · baseline-starvation control · **5 attempts**

| # | Script label | What to do |
|---|---|---|
| 1 | baseline from a BENT-ARM hang (never straighten — fails hygiene) | Jump up and hold the bar with elbows bent ~90°; pull from there and lower **only back to bent arms**. |
| 2 | baseline from a BENT-ARM hang (never straighten) | Same — do not straighten your arms at any point. |
| 3 | full dead hang first, then normal | Lower all the way to straight arms, pause, then a clean rep. |
| 4 | one arm leads (EXPECT evenness silent — disarmed) | A lopsided pull like S1 rep 5. |
| 5 | normal | Clean rep. |

**Testing:** reps 1–2 are uncounted (`extension_miss` in `elbow_angle_deg` basis) and fail the
hygiene gate, so the lowering and evenness baselines never resolve. Expect `baseline.valid: false`
and `checks_disarmed` naming **lowering control** and **left/right evenness**. Rep 4 must **not**
fire U4. The debrief must say those checks weren't evaluated — never that the set was even.

---

## SET 4 — SIDE · the full-hang gate + clean control · **6 attempts**

| # | Script label | What to do |
|---|---|---|
| 1 | baseline clean | Strict, from straight arms. |
| 2 | baseline clean | Same. |
| 3 | normal | Clean. |
| 4 | normal pull, but lower only HALFWAY | A normal rep, but stop the lowering with the elbows about 90°. |
| 5 | pull again from the half hang (EXPECT extension_miss) | From that half hang, pull straight back up to chin over bar. |
| 6 | full dead hang first, then normal | Straight arms, pause, clean rep. |

**Testing:** rep 4 **counts** (it started from a full hang) and closes as `endedBy: partial`;
rep 5 is uncounted with an `extension_miss` — the miss belongs to the rep that started bent; rep 6
counts. Nothing else fires. The counter flashes "Start from straight arms — no count" on rep 5.
**End with: drop down → End set → End workout.**

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
| Attempt counts match the script (no phantom rep when dropping off / lowering the arms) | Dismount + off-bar gating in the rep counter |
| S1 r4 `top_miss`; every clean rep's `top_gate` in `chin_clearance` basis | Chin estimate (mouth + 1.6 × nose→mouth) and the knuckle bar line; the −0.05 chin target |
| S1 r5 uneven pull only | U4 baseline delta 8° past the 0.3 pull-ratio gate |
| S1 r6 lowering spike, no U2 elsewhere in S1/S4 | U2 at 2.0× (slow warm-up lesson) |
| S2 r4 swing, r5 leg drive; r3/r6 clean | U1 20° absolute / +10° relative; U3 30° range; the 1 s pre-arm window |
| S3 `checks_disarmed` + r4 silent | Baseline window + hygiene gate |
| S4 r5 `extension_miss`, r4 counted as `partial` | Start-of-rep extension (elbow 150°) + partial-hang segmentation |
| Head-on payloads null every sagittal field; side payloads null every frontal field | Payload honesty |
| Facing readout stable from the hang to the top in both views | The squat's facing-score anchors hold for a hanging body |
| 3 post-set + 1 post-workout calls | Explicit-click analysis only |

In the debriefs I'll look for: fatigue claimed without velocity evidence, one fault said to cause
another, swing or leg commentary on head-on frames (or evenness/grip width on side frames),
quoting chin-clearance / pull-ratio numbers or elbow angles, and markdown leaking through.

**Numbers to record per rep from the log** (these calibrate the UNVALIDATED values): peak chin
clearance on clean vs short reps (the −0.05 target and the 1.6 chin factor), peak pull ratio vs
chin clearance (the 0.976 + clearance fallback model), start elbow angle vs start ratio on
full-hang vs half-hang starts (150° / 0.12 / 0.25), swing range on strict vs kipped reps (10° /
20°), hip/knee ranges on still vs driven reps (30°), and tilt peaks (8° delta).
