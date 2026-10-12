/**
 * The questions. Every answer is what the app does today — nothing promised that isn't built.
 * Opened from the menu's FAQ button and the footer's "Questions" (as a sheet, components/Hud).
 */
export const FAQ: { q: string; a: string }[] = [
  {
    q: "What do I need?",
    a: "A phone or laptop with a camera and an up-to-date browser, something to prop it against, and room to move. Nothing to install, and no account.",
  },
  {
    q: "Does my video get uploaded?",
    a: "No. The camera is read on your device, frame by frame. When you ask for a read after a set, a handful of still frames from that set go to Google’s Gemini under your own key; the end-of-workout summary sends text only.",
  },
  {
    q: "Do I need a Gemini key?",
    a: "Only for the written reads. Counting reps and watching your form work without one. Paste a key into Settings and it stays in your browser.",
  },
  {
    q: "What does it cost?",
    a: "Neuro-Fit is free. The written reads run on your own Gemini key, so any charge for those is between you and Google.",
  },
  {
    q: "Which exercises?",
    a: "Squats, push-ups and pull-ups — pick one at the top of the app. You choose how deep a squat or a push-up has to go, and how high a pull-up has to reach, to count. Squatting with a barbell? It tracks the bar too: its path and its speed, rep by rep.",
  },
  {
    q: "Where do I put the phone?",
    a: "Far enough back that all of you fits on screen — and the bar, for pull-ups. Side-on and head-on each show different things, and it only judges what its view can see. Doorway bar? Pull-ups have a head-on-only setting.",
  },
];
