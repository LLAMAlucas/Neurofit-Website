/**
 * Reading Gemini's Analyze answers. PURE module.
 * ----------------------------------------------------------------------------
 * The model is asked for JSON (FORM_RESULT_FIELDS in ai/prompts.ts), but its text is still
 * untrusted input: it may wrap the JSON in a code fence, miss a field, invent a severity, or
 * point an issue at image 14 of 12. This keeps what holds together, fixes what can be fixed
 * safely, and drops the rest — it never throws. An answer with no summary and no issues is not
 * an answer (null), so the UI shows an error instead of an empty card.
 */

export type Severity = "high" | "medium" | "low";

export interface FormIssue {
  title: string;
  severity: Severity;
  /** 1-based image number the model pointed at, or null if it pointed at nothing valid. */
  frame: number | null;
  reps: number[];
  whatWeSee: string;
  howToFix: string;
  cue: string;
  drill: string;
}

export interface FormResult {
  exercise: string;
  exerciseConfidence: "sure" | "likely" | "unsure";
  summary: string;
  issues: FormIssue[];
  looksGood: string[];
  cannotJudge: string[];
  refilmTip: string;
}

const SEVERITIES: readonly Severity[] = ["high", "medium", "low"];
const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

/** Strip markdown the prompt forbids but a model may still produce: the app shows plain text. */
export function plain(s: unknown, max = 600): string {
  if (typeof s !== "string") return "";
  return s
    .replace(/\*\*|__|`/g, "")
    .replace(/^\s*#+\s*/gm, "")
    .replace(/^\s*[-*•]\s+/gm, "")
    .trim()
    .slice(0, max);
}

function strList(v: unknown, maxItems: number): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => plain(x, 300)).filter(Boolean).slice(0, maxItems);
}

/** Pull the JSON object out of the model's text (bare, or inside a ```json fence). */
export function extractJson(text: string): unknown {
  const t = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  const body = fenced ? fenced[1] : t;
  const a = body.indexOf("{");
  const b = body.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(body.slice(a, b + 1));
  } catch {
    return null;
  }
}

/**
 * @param imageCount how many images went with the call — an issue's `frame` outside 1..imageCount
 *                   becomes null rather than pointing the "jump to" button at the wrong moment.
 * @param maxIssues  the prompt's cap; extra issues (lowest severity first) are dropped.
 */
export function parseFormResult(text: string | null, imageCount: number, maxIssues: number): FormResult | null {
  if (!text) return null;
  const raw = extractJson(text);
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  const issues: FormIssue[] = [];
  if (Array.isArray(o.issues)) {
    for (const it of o.issues) {
      if (!it || typeof it !== "object") continue;
      const i = it as Record<string, unknown>;
      const title = plain(i.title, 120);
      const whatWeSee = plain(i.what_we_see);
      const howToFix = plain(i.how_to_fix);
      if (!title || (!whatWeSee && !howToFix)) continue;
      const sev = typeof i.severity === "string" ? i.severity.toLowerCase() : "";
      const frame = typeof i.frame === "number" && Number.isInteger(i.frame) && i.frame >= 1 && i.frame <= imageCount ? i.frame : null;
      const reps = Array.isArray(i.reps) ? i.reps.filter((r): r is number => typeof r === "number" && Number.isInteger(r) && r > 0) : [];
      issues.push({
        title,
        severity: (SEVERITIES as readonly string[]).includes(sev) ? (sev as Severity) : "medium",
        frame,
        reps: [...new Set(reps)].sort((a, b) => a - b),
        whatWeSee,
        howToFix,
        cue: plain(i.cue, 120),
        drill: plain(i.drill, 300),
      });
    }
  }
  // Stable sort by severity keeps the model's own order within a severity.
  const kept = issues
    .map((x, k) => ({ x, k }))
    .sort((a, b) => SEVERITY_RANK[a.x.severity] - SEVERITY_RANK[b.x.severity] || a.k - b.k)
    .slice(0, maxIssues)
    .map((e) => e.x);

  const summary = plain(o.summary, 800);
  if (!summary && kept.length === 0) return null;
  const conf = typeof o.exercise_confidence === "string" ? o.exercise_confidence.toLowerCase() : "";
  return {
    exercise: plain(o.exercise, 80),
    exerciseConfidence: conf === "sure" || conf === "likely" ? conf : "unsure",
    summary,
    issues: kept,
    looksGood: strList(o.looks_good, 6),
    cannotJudge: strList(o.cannot_judge, 6),
    refilmTip: plain(o.refilm_tip, 400),
  };
}

/** A stored result read back from localStorage — same tolerance, already in app shape. */
export function validFormResult(v: unknown): FormResult | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.summary !== "string" || !Array.isArray(o.issues)) return null;
  const issues: FormIssue[] = [];
  for (const it of o.issues) {
    if (!it || typeof it !== "object") continue;
    const i = it as Record<string, unknown>;
    if (typeof i.title !== "string") continue;
    issues.push({
      title: i.title,
      severity: (SEVERITIES as readonly unknown[]).includes(i.severity) ? (i.severity as Severity) : "medium",
      frame: typeof i.frame === "number" ? i.frame : null,
      reps: Array.isArray(i.reps) ? i.reps.filter((r): r is number => typeof r === "number") : [],
      whatWeSee: typeof i.whatWeSee === "string" ? i.whatWeSee : "",
      howToFix: typeof i.howToFix === "string" ? i.howToFix : "",
      cue: typeof i.cue === "string" ? i.cue : "",
      drill: typeof i.drill === "string" ? i.drill : "",
    });
  }
  const strs = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : []);
  return {
    exercise: typeof o.exercise === "string" ? o.exercise : "",
    exerciseConfidence: o.exerciseConfidence === "sure" || o.exerciseConfidence === "likely" ? o.exerciseConfidence : "unsure",
    summary: o.summary,
    issues,
    looksGood: strs(o.looksGood),
    cannotJudge: strs(o.cannotJudge),
    refilmTip: typeof o.refilmTip === "string" ? o.refilmTip : "",
  };
}
