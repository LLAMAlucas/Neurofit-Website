/**
 * The comparison the "how it compares" stop draws: Neuro-Fit beside other
 * camera form-check apps, in their own words.
 *
 * PURE — no React, no DOM, so `check_site` can hold it to its rules.
 *
 * ── what this data is allowed to say ────────────────────────────────────────
 *
 * These are public claims about other companies' products, on a page selling a
 * product whose whole pitch is that it doesn't overclaim. So:
 *
 * 1. Every fact about another product comes from that product's OWN page or
 *    store listing (`sources`), as it read on `CHECKED`. Not from reviews or
 *    comparison blogs — those disagreed with each other on Zing's price by 40%.
 * 2. Anything their pages don't say is `null`, and the page prints "Not stated
 *    on their site" — never a guess, and never a "no". A gap in the timeline
 *    means the same: not stated, not "can't".
 * 3. Prices change and differ by country. They're quoted as the US listing
 *    showed them, and the page says so and when.
 *
 * Re-check every entry before a release that changes this file, and bump
 * `CHECKED`. `check_site` fails if an entry has no source.
 */

/** When every entry below was last read against its sources. */
export const CHECKED = "25 September 2026";

/** The three moments a lifter can hear about a set. */
export type Moment = "during" | "afterSet" | "afterWorkout";
export const MOMENTS: readonly { id: Moment; label: string }[] = [
  { id: "during", label: "During the set" },
  { id: "afterSet", label: "After the set" },
  { id: "afterWorkout", label: "After the workout" },
];

export type FactId = "runs" | "price" | "video" | "covers";
export const FACTS: readonly { id: FactId; label: string }[] = [
  { id: "runs", label: "Where it runs" },
  { id: "price", label: "Price" },
  { id: "video", label: "Your video" },
  { id: "covers", label: "What it covers" },
];

export type Product = {
  id: string;
  name: string;
  /** What it gives the lifter at each moment, in a few words; absent = not
   *  stated on its own pages. */
  when: Partial<Record<Moment, string>>;
  /** null = not stated on its own pages. */
  facts: Record<FactId, string | null>;
  /** Where each fact came from: the product's own pages. Empty for us. */
  sources: readonly { label: string; url: string }[];
};

export const US: Product = {
  id: "neurofit",
  name: "Neuro-Fit",
  when: {
    during: "Reps counted live",
    afterSet: "A written read, when you ask",
    afterWorkout: "One read across every set",
  },
  facts: {
    runs: "In the browser — nothing to install",
    price: "Free. The written reads use your own Gemini key",
    video: "Stays on your device; asking for a read sends a few still frames",
    covers: "Squats, push-ups and pull-ups",
  },
  sources: [],
};

export const COMPETITORS: readonly Product[] = [
  {
    id: "zing",
    name: "Zing AI",
    when: { during: "Live form tracking" },
    facts: {
      runs: "iPhone and Android app",
      price: "Free download; Premium in-app purchases from $18.99 (US)",
      video: null,
      covers: "Workout plans from 500+ exercises",
    },
    sources: [
      { label: "App Store", url: "https://apps.apple.com/us/app/zing-ai-home-gym-workouts/id1552207792" },
      { label: "Google Play", url: "https://play.google.com/store/apps/details?id=coach.zing.fitness" },
    ],
  },
  {
    id: "forma",
    name: "FORMA",
    when: { during: "Rep-by-rep feedback, live" },
    facts: {
      runs: "In the browser, or its own app",
      price: "Free",
      video: "Stays on your device",
      covers: "47 movements",
    },
    sources: [{ label: "formabuild.net", url: "https://formabuild.net/form-check" }],
  },
  {
    id: "gymscore",
    name: "Gymscore",
    when: { afterSet: "Analysis of a recorded or uploaded video" },
    facts: {
      runs: "iPhone and Android app",
      price: "Free to start; paid plans not listed",
      video: null,
      covers: "2,500+ exercises",
    },
    sources: [{ label: "gymscore.ai", url: "https://www.gymscore.ai/" }],
  },
  {
    id: "cueform",
    name: "CueForm",
    when: { afterSet: "A report on an uploaded video" },
    facts: {
      runs: null,
      price: "First check free; $15 a report, or $49 for four",
      video: "Uploaded for analysis",
      covers: "Squat, bench press and deadlift",
    },
    sources: [
      { label: "cueform.ai", url: "https://cueform.ai/" },
      { label: "Pricing", url: "https://cueform.ai/pricing" },
    ],
  },
];

export const NOT_STATED = "Not stated on their site";
