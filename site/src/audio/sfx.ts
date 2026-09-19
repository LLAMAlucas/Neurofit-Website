/**
 * The page's sound, made on the spot with WebAudio — no files. OFF until the
 * reader turns it on: the AudioContext is only created by that click, which is
 * also what browsers require before any sound may play.
 *
 *  - hum:   the fog — two detuned low tones through a slow-moving filter
 *  - tick:  a rep counted
 *  - fault: a fault lighting up in view
 *  - swish: particles thrown, louder the faster the swipe
 *
 * Everything is quiet on purpose; the page must read the same with it off.
 */
export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private lastSwish = 0;
  on = false;

  enable(): void {
    if (!this.ctx) this.build();
    const ctx = this.ctx!;
    void ctx.resume();
    this.master!.gain.cancelScheduledValues(ctx.currentTime);
    this.master!.gain.setTargetAtTime(0.8, ctx.currentTime, 0.4);
    this.on = true;
  }

  disable(): void {
    if (!this.ctx || !this.master) return;
    this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.15);
    this.on = false;
    const ctx = this.ctx;
    window.setTimeout(() => {
      if (!this.on) void ctx.suspend();
    }, 800);
  }

  tick(): void {
    const c = this.live();
    if (!c) return;
    const { ctx, out } = c;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "triangle";
    o.frequency.setValueAtTime(1760, t);
    o.frequency.exponentialRampToValueAtTime(880, t + 0.05);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.08, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + 0.1);
  }

  fault(): void {
    const c = this.live();
    if (!c) return;
    const { ctx, out } = c;
    const t = ctx.currentTime;
    for (const [f, delay] of [
      [523.25, 0],
      [392, 0.09],
    ] as const) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.setValueAtTime(f, t + delay);
      g.gain.setValueAtTime(0.0001, t + delay);
      g.gain.exponentialRampToValueAtTime(0.07, t + delay + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + delay + 0.7);
      o.connect(g).connect(out);
      o.start(t + delay);
      o.stop(t + delay + 0.75);
    }
  }

  /** `speed` in screen heights per second. */
  swish(speed: number): void {
    const c = this.live();
    if (!c || !this.noise || speed < 1.2) return;
    const { ctx, out } = c;
    const t = ctx.currentTime;
    if (t - this.lastSwish < 0.12) return;
    this.lastSwish = t;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 0.9;
    bp.frequency.setValueAtTime(600, t);
    bp.frequency.exponentialRampToValueAtTime(2400, t + 0.22);
    const g = ctx.createGain();
    const level = Math.min(0.12, 0.02 * speed);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(level, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    src.connect(bp).connect(g).connect(out);
    src.start(t);
    src.stop(t + 0.35);
  }

  private live() {
    return this.on && this.ctx && this.master ? { ctx: this.ctx, out: this.master } : null;
  }

  private build(): void {
    const ctx = new AudioContext();
    const master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);

    // The fog: two low tones a fraction apart (a slow beat between them),
    // through a lowpass whose cutoff drifts.
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 320;
    lp.Q.value = 0.4;
    const hum = ctx.createGain();
    hum.gain.value = 0.05;
    for (const f of [55, 55.35, 110.2]) {
      const o = ctx.createOscillator();
      o.type = f > 100 ? "sine" : "triangle";
      o.frequency.value = f;
      o.connect(lp);
      o.start();
    }
    const lfo = ctx.createOscillator();
    const depth = ctx.createGain();
    lfo.frequency.value = 0.07;
    depth.gain.value = 140;
    lfo.connect(depth).connect(lp.frequency);
    lfo.start();
    lp.connect(hum).connect(master);

    const len = Math.floor(ctx.sampleRate * 0.4);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    this.ctx = ctx;
    this.master = master;
    this.noise = buf;
  }
}
