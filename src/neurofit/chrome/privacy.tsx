/**
 * The privacy note — facts only, each one true of the code today. If what the app sends or keeps
 * changes, this changes in the same commit.
 *
 * ⚠️ Mirrored byte-for-byte at src/neurofit/chrome/ and site/src/chrome/ (npm run check:mirror).
 */

export const PRIVACY_LEDE =
  "Neuro-Fit runs in your browser. There are no accounts and no Neuro-Fit backend: the app is served as static files, and your workouts are never sent to us.";

export const PRIVACY: { q: string; a: string }[] = [
  {
    q: "Your camera",
    a: "The live coach reads your camera on your own device to find your joints. The video is never recorded and never uploaded.",
  },
  {
    q: "Videos you analyze",
    a: "Analyze opens a clip you already filmed straight from your device. The file itself never leaves it.",
  },
  {
    q: "What goes to the AI",
    a: "Only when the AI is on and you have added your own Gemini key, a few still frames go from your browser to Google's Gemini under that key: after a set, that set's key frames; for a whole clip, at most 12; for one frame, 3. The end-of-workout summary sends text only. Google's terms apply to those requests.",
  },
  {
    q: "What stays in your browser",
    a: "Your API key, your settings, your usage counts and your notes on analyzed clips are kept in this browser's local storage, on this device only. Clearing the site's data removes them.",
  },
  {
    q: "Fonts",
    a: "The pages load their fonts from Google Fonts.",
  },
];

export function PrivacyNote() {
  return (
    <>
      <p>{PRIVACY_LEDE}</p>
      <dl>
        {PRIVACY.map((p) => (
          <div key={p.q}>
            <dt>{p.q}</dt>
            <dd>{p.a}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}
