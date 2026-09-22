# Per-check orientation tolerance — validation log

The orientation gate classifies a set as **front** (`facingAngleDeg = 90° ± 15°`)
or **side** (`0°/180° ± 15°`); outside both → **ambiguous** (hard stop, reposition
prompt). But ±15° is not equally safe for every check, so tolerance is **per
check** (`SQUAT.checkToleranceDeg` in `squat/config.ts`). A rep whose facing
angle is outside a check's tolerance returns `unknown` for that check (kept
distinct from a clean `ok`).

> ## ⚠ These are SYNTHETIC results, not real footage
> The rows below were validated **geometrically** — hand-built landmark frames at
> known angles, run through `npm run check:squat`. They prove the *gating and the
> math* behave at the tolerance edges. They do **not** substitute for real-footage
> testing, which only you can do (no camera/footage in the build environment).
> Treat the "real footage" column as a checklist to fill in. See spec §3 and the
> Phase-1 caveat: MediaPipe `z` is relative, every threshold is a starting point.

## Convention note (spec inconsistency)

Spec §1 defines **front = 90°**, **side = 0°/180°**. Spec §3 describes the
side-facing edges as **75°/105°**, which implies side = 90° — the opposite. We
follow **§1** (the dedicated definition) and document it in `config.ORIENTATION`.
Both the convention and the per-check tolerances are plain constants, so flipping
to the §3 reading is a one-line change. The edge tests below therefore probe the
**§1** zone edges.

## Current per-check tolerances + synthetic edge result

| Check | Plane / view | Tolerance | Synthetic edge test (in `check_squat.ts`) | Result | Real footage |
|-------|--------------|-----------|--------------------------------------------|--------|--------------|
| Depth | side | **±10°** (narrowed) | depth at 12° off side → `unknown`; at 8° → checked | ✅ gates as intended | ☐ to verify |
| Forward lean | side | ±15° | lean still checked at 12° while depth drops out | ✅ per-check independent | ☐ to verify |
| Velocity / tempo | **agnostic** | n/a (no angle gate) | checked in BOTH front + side; front samples flagged `noisy` | ✅ tracked both views | ☐ to verify |
| Knee valgus | front | ±15° | front check runs at 90°, not-checked side | ✅ orientation gate | ☐ to verify |
| Shoulder/hip levelness | front | ±15° | roll-invariant (differential cancels camera roll) | ✅ roll test passes | ☐ to verify |
| Rep counting | agnostic | n/a | counts front & side (hip-displacement) | ✅ | ☐ to verify |
| Bar path | — | n/a | always `unavailable` (stub; needs equipment detection) | ✅ stub only | n/a |

> **Severity zones:** every gradeable check above also reports a `Severity`
> (`good`/`warning`/`critical`) from the `SEVERITY` bands in `config.ts`. Those
> critical cutoffs are biomechanical guesses and need the **same real-footage
> validation** as the tolerances — a wrong critical cutoff means the AI coach
> fires too eagerly or never.

**Depth is preset-driven (Settings tab):** the depth target is whichever
`DEPTH_PRESETS` entry the user picks (full / parallel / above), not a fixed margin.
The check stores the SHORTFALL vs that target, so `DEPTH_CRITICAL_TOLERANCE` (0.10)
is one tolerance that applies to every preset. The preset targets (full +0.05,
parallel 0.0, above −0.10 normalized hip-vs-knee gap) are starting points — the
prime candidates for real-footage tuning, since "parallel" depends on your camera
height. Depth is also **excluded from the trigger layer** (still graded and reported): the rep
counter is the realtime depth feedback, so counting never calls `requestTrigger`.

**Why depth is narrowed to ±10°:** it reads a *vertical* relationship (hip-vs-knee
height). Off true side-on, vertical displacement foreshortens fastest, so it loses
reliability first — a conservative starting point until real footage says otherwise.

**Depth now gates rep counting in BOTH views (calibration knobs):** in side sets the
live counter only ticks when the bottom hip-vs-knee gap reaches the active preset's
`targetGap` (`repCounts()` in `checks.ts`); an occluded bottom counts (no penalty).
Front sets gate on the distance-invariant `bottomDepthRatio` against a per-preset
`frontRatioTarget` (`above ~0.40`, `parallel ~0.60`; `full` reuses the `parallel`
target — both UNVALIDATED, see the `front_depth_gate` row in the eval log). This is
COUNTING only — front still has no depth GRADE. Deeper always counts; a null/missing
bottom ratio never counts. Both are tuned via the on-overlay live readouts: `gap ±0.00`
near the hips (side) and `valgus 0.00` near the knees (front), plus the header `DEPTH %`.
The report tallies "counted/attempts hit depth" per side set with the missed rep
numbers; zero-attempt active sets are excluded from totals and shown as an advisory.

**Forward lean threshold lowered:** `forwardLeanWarnDeg` 45° → **35°** (critical
60° → **50°**). At 45° the check effectively never fired — a deep squat naturally
leans ~30° from vertical — so excessive forward lean went unflagged. Still the same
geometry (shoulder-mid→hip-mid angle from image vertical, side-only); watch for
false positives on naturally lower-bar/leaning lifters and raise back toward 40° if
it nags. (Those are normalized-space degrees on the 16:9 camera. Since the 2026-09-18
aspect fix the same thresholds are **51°** warn / **65°** critical in real degrees, and
"raise back toward 40°" means toward ~56° real.)

**Front-detection threshold (orientation lock):** the facing-score anchors live in
`ORIENTATION.SCORE` (config). They are tuned for **full-body squat framing**
(subject far, shoulders narrow in-frame): front locks from a low *standing* score
(≈ 0.3 edge) because the score is posture-coupled. Raise/lower these if front locks
too easily / not at all.

**Knee valgus sensitivity:** `valgusRatioWarn` went 0.6 → 0.8 (at 0.6 the knees had to cave
nearly to touching before warning), then **0.8 → 0.72** because 0.8 warned on straight legs —
near lockout the knee/ankle ratio degenerates. Critical cutoff is **0.6**. Valgus is
aggregated **worst-of throughout the rep**, not just at the bottom, and since 2026-07-31 its
trigger window reaches down to depth_ratio **0.15** so the ascent is included. Do not widen
that gate further without re-checking the straight-leg case — that is the same failure mode
that pushed the threshold off 0.8.

**Why valgus keeps ±15° tolerance:** the facing angle is a rough estimate, and once
a set is locked "front" we want its checks to actually run rather than drop to
`unknown` at the edge of the zone.

**Why levelness keeps the full ±15°:** it's a *differential* (shoulder-line tilt
minus hip-line tilt), so camera roll cancels and it's the most angle-robust of
the frontal checks (verified by the roll-invariance test).

## v2 trigger thresholds — ALL uncalibrated (n=1), highest priority

Every value in `TRIGGERS` (`config.ts`) is an n=1 starting guess (the developer, a
long-femur outlier). Multi-body calibration is the gating dependency before any of
these can be trusted — ideally not on the developer. Prime candidates:

| Trigger | Threshold | Notes |
|---|---|---|
| T1 forward lean | baseline + **12°** (real degrees) past depth_ratio **0.3**, 150ms | baseline-relative, per set. Gate widened from 0.5 (2026-07-31): normal reps peak at 32.8–37.7° real (19.9–23.5° normalized) in the shallow phase vs a ~51° threshold, so the shallow half is safe to judge. Was +10° normalized until the 2026-09-18 aspect fix; +12° reproduces every recorded decision |
| T2 eccentric | descent **2.0×** baseline · bounce **≤300ms** reversal **and rep reached depth** | 1.5× fired on normal reps whenever the warm-up was slower than the working set. 150 ms was provably unreachable (measured range 268.7–1301.5 ms); the depth gate stops the raise from converting a dead signal into a quarter-squat false positive. **Bounce still has zero true positives** |
| T6 velocity collapse | **<60%** of rolling baseline | context only, never a cue |
| T7 valgus | below `valgusRatioWarn` past depth_ratio **0.15**, 150ms | stance-confounded. Gate widened from 0.30 (2026-07-31) after T7 fired 0 times in 30 reps incl. two deliberate max caves — the cave was worst during the ASCENT, below the old gate |
| T11 lateral shift | warn **0.08**, severe **2×** over **3** reps · fires baseline-relative (+**0.04**) past depth_ratio **0.3** | least trustworthy trigger (1 correct fire in 4, n=1). Aggregated across the rep since 2026-07-31, but gated: its shallow readings hit 1.44 hip-widths against a 1.5 "falling over" bound |
| Butt wink | bodyweight peak-lean-depth **0.7** (context) · loaded early-onset depth **<0.5** | |
| Excessive depth (loaded) | bottom depth_ratio **>0.95** | loaded only |

All are milliseconds/ratios (adaptive frame rate). Every ANGLE — `torsoLean`,
`shinAngleDeg`/`footAngleDeg`, knee angle, levelness, the facing score, camera roll — is
computed in **aspect space** `[x·W/H, y]` since 2026-09-18, so it is the real image angle on
any camera. Before that they were raw normalized space, where the same squat read ~19° of lean
on the 16:9 calibration camera and ~48° on a portrait phone. Degrees quoted from runs before
that date are normalized-space numbers: convert with `atan(tan θ · 16/9)` (every recorded
session was 1280×720). Ratios and y-only quantities (valgus, stance, shift, symmetry, depth)
were aspect-invariant all along and are unchanged.

## To validate against real footage (manual)

For each orientation, film a few reps at the **zone edge** (front: ~75°/105°;
side: ~15°/165°) and confirm:
1. The orientation still classifies correctly (not flipping to ambiguous early/late).
2. Each check at that angle either holds its verdict vs a square-on reference, or
   correctly reports `unknown` rather than a wrong `ok`/`warn`.
3. If a check gives wrong verdicts at its current edge, **narrow only that check's
   `checkToleranceDeg` value** — don't move the global zone.

Record observations by replacing the ☐ cells above.
