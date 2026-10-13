/**
 * A ResizeObserver that also reports once, as soon as it starts observing.
 *
 * R3F sizes its canvas through react-use-measure, which reads the container's
 * rect only when its ResizeObserver calls back. Where that callback never comes
 * — the embedded browser pane this repo is previewed in (see the header of
 * scripts/check_rig.ts) — the canvas stays 0×0 and nothing renders. One eager
 * report fixes that, and is harmless everywhere else: react-use-measure
 * re-reads the rect on every callback, so an extra one changes nothing.
 *
 * A timer, not an animation frame: a page in a hidden window gets no animation
 * frames at all, and the canvas would stay 0×0 there too.
 */
export class EagerResizeObserver implements ResizeObserver {
  private readonly inner: ResizeObserver | null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly callback: ResizeObserverCallback) {
    this.inner = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(callback);
  }

  observe(target: Element, options?: ResizeObserverOptions): void {
    this.inner?.observe(target, options);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.callback([], this), 0);
  }

  unobserve(target: Element): void {
    this.inner?.unobserve(target);
  }

  disconnect(): void {
    clearTimeout(this.timer);
    this.inner?.disconnect();
  }
}
