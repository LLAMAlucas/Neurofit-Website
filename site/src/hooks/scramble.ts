/**
 * A HUD label that decodes out of scrambled glyphs whenever its text changes —
 * igloo's readout language. Driven from the page's ticker: call `set()` every
 * frame with what the label should say.
 *
 * For LABELS only: short machine readouts. Sentences a person reads are never
 * scrambled (they rack focus instead), and nothing is scrambled for a screen
 * reader — the element's final text is what gets announced.
 */
// ASCII only: the block glyphs igloo uses aren't in DM Mono, and fell back to
// empty boxes mid-decode.
const GLYPHS = "/\\_-=+<>:#*01";
const SCRAMBLE_MS = 420;

export class Scrambler {
  private target = "";
  private shown = "";
  private since = 0;

  constructor(private readonly el: HTMLElement) {}

  set(text: string, now: number): void {
    if (text !== this.target) {
      this.target = text;
      this.since = now;
      this.el.setAttribute("aria-label", text);
    }
    const t = now - this.since;
    let out = "";
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      out += ch === " " || t > 60 + (i / text.length) * SCRAMBLE_MS ? ch : GLYPHS[(Math.random() * GLYPHS.length) | 0];
    }
    if (out !== this.shown) this.el.textContent = this.shown = out;
  }
}
