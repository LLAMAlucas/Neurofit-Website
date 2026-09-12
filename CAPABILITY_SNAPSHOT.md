# Neuro-Fit — Technical Capability Snapshot

**Purpose:** factual briefing for marketing strategy work (website, video). Written from the
code as it stands, not from intent or roadmap. Where the codebase and the existing marketing
site disagree, the code wins and the discrepancy is flagged.

**Date of snapshot:** 2026-07-30 · Version `0.1.0` · Not a git repo (no commit history to cite)

**One-line honest summary:** a working browser-based squat form analyser that films you,
counts reps against a depth target you choose, and writes you a coach-style debrief after
each set and after the workout. It is a functional single-exercise prototype whose accuracy
thresholds have been calibrated against **one body**. There is no account system, no data
persistence, no deployment, and no way for an end user to supply an API key.

---

## 1. Feature list — what actually works, what is off, what is planned

### 1a. Works end-to-end, verified in code

| Feature | Status | Notes |
|---|---|---|
| **Squat** | Working | The only exercise. No second exercise exists, not even stubbed. |
| Live pose tracking + skeleton overlay | Working | MediaPipe Tasks pose landmarker, `lite` model, GPU delegate with CPU fallback. WASM + model vendored locally, so tracking runs offline. |
| Camera orientation detection (side vs front) | Working | Classifies the view, requires a 1.2 s hold while standing, then locks. Sets alternate side → front → side. |
| Rep counting | Working, both views | Keyed off **vertical hip displacement**, not knee angle — this is why it works head-on as well as side-on. |
| Depth-gated counting | Working, both views | Side: bottom hip-vs-knee gap must reach the preset target. Front: `depthRatio` must reach a per-preset floor. Deeper always counts. |
| Depth **grading** (a graded verdict, not just a count) | Working, **side sets only** | Front sets deliberately have no depth grade. |
| Auto exposure correction | Working | Detects dark / backlit / overexposed ~5×/sec and applies brightness+contrast to the frame the detector reads. Has a user on/off toggle. Unit-tested. |
| Live form-check panel (11 metrics) | Working | Shows every metric with distinct states: pass / flagged / unknown / not-checked-in-this-view / unavailable. |
| Live valgus indicator (knees turn red) | Working, **front sets only** | Driven by the absolute knee-width/ankle-width ratio threshold. |
| Post-set AI debrief | Working | Gemini `gemini-3.6-flash`. Fires **only** when the user clicks "Next set". |
| Post-workout AI summary | Working | Fires **only** on "End workout" / "Finish workout". Text-only — no images sent. |
| Deterministic post-workout report | Working, no API needed | Per-set tallies, per-metric verdicts, explicit "not assessed" rows. Works fully offline with no key. |
| Settings: depth preset | Working | Full depth / Parallel / Above parallel. Persisted to localStorage. |
| Settings: training mode | Working | Bodyweight / Loaded. Changes how signals are interpreted in the prompt, not new geometry. |
| Settings: API kill-switch | Working | Lets you run the whole app with zero API calls. |
| Usage metering + quota | Working, **on-device only** | Added 2026-07-31. Counts every API call (type, tokens, images, latency, outcome) and every workout (sets, reps, completed or abandoned) into localStorage, with an exportable JSON and an optional rolling-window cap. Verified: at the cap, calls are refused before any request leaves the browser. **Not enforcement** — see §4 item 7. |

### 1b. Built then deliberately REMOVED — do not market

**Real-time mid-set coaching cues.** This was built and then taken out. The config comment
states the reason plainly: *"latency 12-34s on ~40s sets made them useless."*

- `requestCoaching()` still exists in `ai/gemini.ts` but has **zero callers** — dead code.
- The trigger machinery (forward lean, eccentric control, valgus) still runs live, but firing a
  trigger now only **archives a video frame** for the later post-set debrief. No text is
  produced or shown mid-set.
- The post-workout report still renders a **"Mid-set cues"** section. The map that feeds it is
  never written to, so it always reads *"No mid-set cues this set."* This is dead UI that will
  confuse anyone doing a demo.

The existing site handles this well already (the "One thing it doesn't do" callout is accurate
and is arguably the most trustworthy passage on the page). Keep that framing.

### 1c. Computed but demoted — visible in the panel, never allowed to accuse

These still calculate and still appear in the live panel, but are barred from asserting a fault
anywhere in the report or the AI payload:

- **Knee symmetry (T10)** — demoted because on a 2-person test it was *anti-correlated* with
  knee cave: it read *lower* (better) on genuine collapses. Structurally broken, not
  miscalibrated. **Knee valgus is the real cave detector.**
- **Shoulder/hip levelness** — demoted as aspect-ratio-distorted jitter.

Both are excluded from the report cards and headline, and were removed from the AI payload
entirely. Marketing must not list either as a detected fault.

### 1d. Stubs, hardcodes and never-fires

| Item | Reality |
|---|---|
| **Bar path / COM drift** | Permanent stub. Always reports "Not available — requires equipment detection (planned)." Never computed. |
| **Butt wink** | No landmarks exist for it. Bodyweight: a context note only. Loaded: *inferred* from an early lean onset. Never directly measured. |
| **Chest / upper-back rounding** | No measurement at all. When forward lean fires, the prompt asks Gemini to eyeball it from the photo. |
| **Stance width** | Computed and sent as context. **Never checked, never warned.** The site lists it as a front-view check — that is an overclaim. |
| **"Mobility boundary" preset reason** | Hardcoded `false` / `"preference"`. The prompt logic that would suppress "go deeper" advice for a mobility-limited user **can never activate**. |
| **T2 bounce sub-signal** | **Confirmed never fires.** Measured reversal across 30 real reps was 268.7–1301.5 ms against a 150 ms window. Raised to 300 ms (2026-07-31) but **still has zero true positives** — do not describe bounce detection as a working feature until a run fires it. The descent-spike half of the same trigger does work. |
| ~~**"AI DEEP ANALYSIS → Generate" button**~~ | **Removed 2026-07-31.** It called a legacy prompt that overwrote the good auto-generated summary with a worse one. The post-workout summary is now render-only. |
| **Dev calibration overlays** | `gap +0.02` / `valgus 0.85` numeric tags are drawn on the live video and are **not** dev-gated — end users see raw debug numbers on screen. |

### 1e. Genuinely planned / not started

- Second exercise (gated behind multi-body calibration).
- Equipment/load detection (would unlock bar path).
- Pose-landmarks-only privacy mode (currently real JPEG frames are sent).
- A key-holding proxy so users don't need their own API key.

---

## 2. What the user actually sees, stage by stage

All text below is verbatim from the code unless marked otherwise.

### Pre-set (positioning)

Header shows `NEURO·FIT`, live `REPS` / `DEPTH` / `PHASE` counters and a Reset button. Tagline:
*"AI squat coach — orientation-aware, works in any room"*.

The set bar shows `SET 1`, `SIDE view`, and a live facing readout (e.g. `4° · 0.12`). Prompts:

- `Turn side-on to the camera, whole body in profile.` / `Face the camera square-on, whole body in frame.`
- On alignment: `Hold it…` with a filling lock bar (1.2 s)
- Then: `Locked · starting in 3…` and a large countdown overlay
- Camera states: `Requesting camera…` → `Loading pose model…`, or errors like
  `Camera permission denied. Allow camera access and reload.`

### Mid-set

**No AI text at any point.** What the user gets:

- Skeleton tracing over the mirrored video feed; green joints, white bones
- Knees turn **red** the moment valgus crosses threshold (front sets only)
- Live `REPS`, `DEPTH %` (0–100), `PHASE` (`DOWN`/`UP`)
- A `GPU · 30 fps` performance badge
- Flash on a failed rep: **`Depth not met — no count`**
- If you drift off-axis: **`Return to side-on view`** plus
  `Off side-on — checks paused. Return to SIDE view.`
- The `FORM CHECKS` rail, updating live, e.g.:
  - `Good depth` / `Go deeper — hips above target`
  - `Chest up — good posture` / `Too much forward lean — chest up`
  - `Knees tracking well` / `Knees caving in — push them out`
  - `Controlled descent` / `Descending too fast — control the way down` /
    `Bouncing out of the bottom — pause and drive up` /
    `Dropping fast and bouncing out of the bottom`
  - `Tempo steady` / `Rep speed down 24% — fatigue`
  - `Can't see both knees + ankles` (unknown, not a pass)
  - `Not available — requires equipment detection (planned)` (bar path)

### Post-set

Two-stage overlay on top of the still-running camera:

**Stage 1 — choice.** `SET 1 COMPLETE · SIDE VIEW`, `8/10 reps counted`,
*"Review this set, or wrap up the workout?"* with `Next set →` and `End workout`, plus the hint:
*"'Next set' pulls up this set's AI debrief first. 'End workout' goes straight to your session summary."*

**Stage 2 — debrief** (only if they clicked Next set). `Coach debrief`, then
`Analyzing the set…` → the model's text, or `No analysis for this set.` on failure.

The AI is sent: rep tallies, which triggers fired on which rep numbers, peak severity, depth
ratios, uncounted reps, plus **a curated frame archive** — one bottom frame from each of reps
1–2 as a baseline, plus one single worst-case frame per fault type.

**Important for video/marketing:** there is **no example debrief output anywhere in the repo**.
No saved eval logs, no fixtures, no transcripts. Every debrief the app has ever produced exists
only in a browser console that has since closed. Any copy quoting model output would be
invented. The site's decision to leave the Proof slot empty is the correct call, and the single
highest-value marketing asset would be capturing one real, unedited set + its verbatim debrief.

### Post-workout

`Workout report`, then a deterministic headline built from real data, e.g.:

- `Clean session across side-facing sets 1, 3 + front-facing set 2 — no faults flagged.`
- `2 metrics flagged across side-facing sets 1, 3 + front-facing set 2: forward lean, knee valgus.`

Then `3 sets · 24 reps · orientations: side, front`, expandable per-set rows:

- `Set 1 · side — 8/10 reps hit depth — missed: rep 4, 7-8`
- `Set 2 · front — 9 reps`
- `Set 3 · side — No reps recorded — check camera position and try again`

Per-set advisory notes where applicable, e.g.
`Missed depth on 4 reps — check the preset fits your mobility, or drill the position.` and
`Lateral hip shift across 3 reps — worth addressing (one hip working harder).`

Then a per-metric grid (`✓` / `!` / `–` / `∅`) with lines like
`Depth: flagged on set 1 reps 4, 7-8.` and
`Knee valgus not assessed this session — no front-facing sets completed.`

Finally the AI session summary, rendered read-only. (The vestigial `AI DEEP ANALYSIS /
Generate` button that used to sit here was removed on 2026-07-31.)

---

## 3. What makes the feedback loop technically different

This is the genuinely defensible part, and it is more interesting than "AI counts your reps."
Six things a simpler app doesn't do:

**1. The local layer is forbidden from diagnosing.** Design rule: *MediaPipe triggers and
narrates; Gemini judges.* No local threshold produces a fault verdict — it only decides "this
movement is worth examining." A generic app hardcodes "knee angle < X = bad rep" and is
therefore wrong for anyone whose proportions differ from the developer's.

**2. Thresholds are relative to your own warm-up, not a population norm.** Reps 1–2 of every
set establish a per-set baseline; forward lean and hip shift fire on a *delta from your own
baseline*, re-established every set. A naturally forward-leaning lifter isn't nagged for
existing. There is even a hygiene gate that refuses to let a half-hearted settling rep poison
that baseline.

**3. "Can't see it" is a distinct state from "it was fine."** Every check returns one of five
states, and occlusion or a bad camera angle yields `unknown` — never a pass. Most consumer
apps silently report success when tracking degrades.

**4. Camera-plane honesty is enforced on both sides of the API call.** Faults only visible from
the side (depth, lean) and faults only visible head-on (knee cave, hip shift) are checked from
the view that can actually see them. Critically, the *payload itself* nulls out the fields the
camera couldn't see — using `null` rather than `0`/`false`, because `false` would read to the
model as "checked, absent." The system prompt then forbids the model from asserting anything
about the invisible plane. The model cannot praise your depth off a front-view set, because it
was never given depth.

**5. The model's causal claims are evidence-bound.** This is unusually disciplined. An earlier
version asserted "fatigue" in nearly every set, including sets where no fatigue signal existed.
The prompt now permits a fatigue claim *only* when a specific numeric field is present and
below 1.0, and explicitly states that a fault occurring on a later rep is **not** evidence of
fatigue. Cross-fault causation ("your fast descent caused your lean") is banned outright.
Truncated responses are surfaced as errors rather than shown as complete answers.

**6. Frame selection is curated, and the model is told what it is not seeing.** Rather than
dumping video, the app archives two baseline frames plus the single most severe frame per fault
type — with direction-awareness, so for knee cave it keeps the *lowest* ratio rather than
naively the highest number. The prompt then explicitly warns the model that one photo does not
mean one occurrence, and that frequency must be judged only from the rep-number list. This
closes the most common failure mode of image-fed LLM coaching: confabulating a pattern from a
photo count.

**A human without expertise would miss:** eccentric descent-speed spikes relative to the
person's own controlled reps; lateral hip shift measured against their own neutral stance;
tempo decay across a set; and reps that visually "looked deep" but missed the chosen target.
A phone-mirror user sees none of this; a friend filming sees it but can't quantify it.

---

## 4. Known limitations a user would notice — and what is NOT ready to market

### Blocking honesty issue: calibration is n=1

Every threshold in the config is marked UNVALIDATED. They were tuned against **one body — the
developer, a self-described long-femur outlier** — with a few numbers spot-checked against a
second person. The per-check tolerance validation log has a "real footage" column in which
**every single box is unchecked.** Multi-body calibration is documented as the blocking
dependency for everything downstream, including the second exercise.

Consequence: false positives and false negatives both happen. The site's Limits section already
says this well and should not be softened.

### Camera and space requirements the user will hit

- Must hold within **±15°** of true side-on or true front-on. Outside that, the set won't start,
  and drifting mid-set pauses checks with a reposition prompt.
- Depth has a tighter **±10°** tolerance than other checks (vertical measurements foreshorten
  fastest off-axis), so depth can drop to `unknown` while other checks continue.
- **Whole body must be in frame** — requires backing well away from the camera.
- **You only get half the checks per set.** Sets alternate, so a side set cannot report knee
  cave and a front set cannot report depth or lean. A user doing a single set gets one plane
  only. This is a deliberate design honesty choice, but it will read as a limitation.
- Front-view depth counting floors (0.40 above-parallel / 0.60 parallel) are explicitly
  uncalibrated and have already been adjusted twice on subjective feedback. **Front-view rep
  counting is the least trustworthy number in the app.**
- `full` depth preset has no front-view estimate at all — it silently falls back to the
  parallel target.

### Latency

- **Mid-set: nothing, by design** (the 12–34 s latency that killed it is the reason).
- Post-set debrief: blocking wait on a thinking-enabled multimodal call. Users see
  `Analyzing the set…`. No measured figure is recorded; the mid-set measurement (12–34 s) is the
  only latency data that exists, and post-set sends more data.
- Post-workout summary: **~15 s** (documented, measured).

### Failure modes

| Failure | What the user sees |
|---|---|
| No API key | `AI coaching off — add VITE_GEMINI_API_KEY to .env.local…` — leaks a developer instruction into user-facing UI |
| API error / empty response | `No analysis for this set.` — graceful, terminal, never spins forever |
| Response truncated | Treated as an error, not shown as a real debrief (correct behaviour) |
| Camera denied / in use | Clear, specific error text |
| Pose model fails to load | `Pose model failed to load — Check your connection and reload.` |
| Tracking degrades mid-rep | Rep flagged unreliable; its context numbers are withheld so a tracking failure can't become a form finding. Rep still counts. |

### NOT ready to market — flag explicitly

1. **Any claim of real-time / in-rep coaching.** Removed. Cannot be demoed.
2. **Knee symmetry or shoulder/hip levelness as detected faults.** Demoted; one was actively backwards.
3. **Stance width as a check.** Computed only, never evaluated. Currently claimed on the site.
4. **Bar path / anything load-aware.** Stub.
5. **Front-view accuracy claims.** Uncalibrated targets, and no depth grade at all.
6. **Bring-your-own-key.** The site's pricing section describes this; **no implementation
   exists.** The key is read from a build-time env file. There is no settings field to enter one.
   Shipping that pricing model requires real work first.
7. **Paid tier.** There is now a **usage ledger and a rolling-window quota** (added 2026-07-31,
   verified end-to-end: at the cap, calls are refused and zero requests reach Google). But it
   lives in localStorage and the API key is inlined into the bundle, so it is a **spend guard
   for honest users, not enforcement** — clearing site data resets it. No payment code exists.
   Safe to say "usage is metered"; not safe to say "limits are enforced".
8. **Any quoted example of coach output.** None has ever been saved.
9. **Cosmetics before filming:** the debug `gap`/`valgus` overlays and the dead
   "Mid-set cues" section still make the app read as a dev tool on camera. (The "AI DEEP
   ANALYSIS" button is gone as of 2026-07-31.)

---

## 5. Platform and setup requirements

| Requirement | Detail |
|---|---|
| Runtime | Modern browser. React 18 + Vite. **No deployment** — runs from the dev server or the local `dist/` build. There is no hosted URL. |
| Security context | `getUserMedia` requires **HTTPS or localhost**. Handled with an explicit error message. |
| Camera | **Front/user-facing camera only** (`facingMode: "user"`), requested at 1280×720 ideal. **No camera-switcher UI** — on a phone you'd be limited to the selfie camera. |
| GPU | Tries GPU delegate, falls back to CPU automatically. FPS badge warns below 25/15 fps. |
| Network | Pose tracking, rep counting, depth and the full deterministic report work **fully offline** (WASM + model vendored). Only the AI debriefs need network. |
| AI key | `GEMINI_API_KEY` in a gitignored `.env.local`, read at build time, sent **browser-direct** to Google. Currently a developer-only setup. |
| Mobile layout | Breakpoints exist (single column below 920 px, plus 720 px rules) so it should function on a phone, but the design is desktop-first (video stage + 340 px side rail) and there is no evidence of real device testing. |
| Space | Enough room to fit your **whole body** in frame from both side-on and front-on, plus room to squat. |
| Account / login | **None.** No signup, no backend, no user records. Only depth preset, training mode and the API toggle persist (localStorage). |
| Data | Nothing is saved between sessions — no history, no progress tracking, no streaks. Close the tab and the workout is gone. |
| Privacy | Video is never uploaded. A handful of downscaled 640×480 JPEG stills are sent per post-set call. The post-workout call sends **no images at all**. The site's privacy paragraph is accurate. |

---

## 6. Usage data available

> **Updated 2026-07-31.** The original text below said there was effectively none. That is no
> longer true: a usage ledger was added, and one full scripted evaluation session was run and
> retained. It is still **one body, one session** — nowhere near an accuracy claim.

- **Local usage ledger, no telemetry.** `usage/` now records per-call type, tokens, images,
  latency and outcome, plus per-workout sets/reps/completion, in localStorage and exportable as
  JSON. It is **on-device only** — nothing is transmitted, so there is still no aggregate,
  cross-user, or retention data of any kind.
- **One retained eval dataset.** The 2026-07-31 run: 5 sets, 30 reps, 5 Gemini calls, with a
  per-rep trigger table (including near-misses and did-not-fire rows) and verbatim model
  responses. That run is what produced the fixes recorded in `EVAL_REVIEW_2026-07-31.md`.

The quantifiable facts available:

| Quantity | Value | Source quality |
|---|---|---|
| Test suite | **190 assertions, all passing** | Mostly synthetic — validates logic and gating. **20 of them now replay real measured values** from the 2026-07-31 run, which is the only non-synthetic coverage that exists |
| Sessions recorded | **3 started, 1 completed** (33%) | Real, but that is the developer testing — not a usable completion rate |
| Reps counted vs attempted | **28 / 30** in the one full session | Real; the 2 misses were deliberate fault reps |
| Gemini calls in one full workout | **5** (4 post-set + 1 post-workout), 12 images, 29,323 tokens | Measured — the basis for any cost-per-workout estimate |
| Post-set latency | **p50 14.3 s · p95 26.4 s** | Measured. Frames dominate: a 4-frame call ~26 s vs a 2-frame call ~12 s, so the set with faults — the one the user most wants feedback on — is the slowest |
| Bodies tested | **1** primary (developer), a few checks at **n=2** | Documented |
| Real-footage validation | **0 of 7** tolerance rows verified | Every checkbox unchecked |
| Typical set length | **~40 s** | Incidental, from the mid-set latency post-mortem |
| Removed mid-set latency | **12–34 s** | Measured |
| Post-workout latency | **~15 s** | Measured |
| Post-set token usage | 1,859 thinking + 246 output of 8,192 | Measured on `gemini-3.6-flash` |
| Post-workout token usage | 489 thinking + 343 output of 4,096 | Measured |
| Image buffer window | ~7.5 s ring (30 frames @ 250 ms) | By design |
| Faults observed in own testing | Baseline corruption from settling reps; ring buffer evicting baseline frames 5–12 s early; `triggers_fired` disagreeing with the trigger layer; every side rep flagged unreliable; T7 firing 0/30; T2 bounce unreachable (all since fixed) | Code comments + the 2026-07-31 eval run |
| Real-footage threshold validation | **Still 0 of 7 tolerance rows verified** | The eval run tuned trigger gates against real measurements, but the per-check *orientation tolerances* remain synthetic-only |

**Marketing-relevant caveat about the one dataset:** it was a *scripted fault protocol* — reps
deliberately performed badly to make triggers fire. It demonstrates the machinery responds to
real movement. It says nothing about accuracy on an unscripted lifter, and the fixes it
produced have **not yet been re-verified on camera**.

**Recommendation:** run the revised protocol (`TEST_PROTOCOL.md`) a few times, on more than one
body, and keep the exports. One session was enough to find nine defects; it is not enough to
support any accuracy claim, and multi-body calibration is still the blocking dependency.

---

## Appendix — documentation drift found while writing this

Anyone reading the repo docs for marketing input should know these are stale.

**Fixed 2026-07-31** — `CLAUDE.md` (mid-set cues described as live; `test:midset` described as
covering the live request shape) and `TOLERANCE_VALIDATION.md` (`valgusRatioWarn` 0.8, front
parallel target 0.66, a reference to the deleted `SPIKE_EXCLUDED`) have all been corrected.

**Still stale:**

- `scripts/test_midset.ts` itself still exists and is still wired to `npm run test:midset`,
  testing a call type the app no longer makes. The doc now warns about it; the script is unchanged.
- `App.tsx` footer still tells users *"the AI coach is consulted only when rep speed drops
  (fatigue), not on a timer."* Both halves are wrong: velocity collapse is deliberately
  context-only and never fires anything, and analysis fires **only on an explicit user click**.
- `.claude/launch.json` still names the app config `stakefit` (the deleted predecessor project).
