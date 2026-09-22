/**
 * A liquid-glass switch: real buttons in a row (or a grid of cards), with one glass
 * droplet that slides to whichever is chosen. The motion lives in GlassSegment
 * (liquidGlass.ts); this only renders the markup and keeps it pointed at `value`.
 *
 * Every option stays an ordinary <button> with its own onClick, so keyboard and screen
 * readers work as before; dragging the droplet is extra, for single-row controls.
 */
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { GlassSegment } from "./liquidGlass";

export interface GlassOption<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
  title?: string;
  className?: string;
}

export function GlassSegmented<T extends string>({
  options,
  value,
  onChange,
  label,
  className = "",
  draggable = true,
  current = false,
}: {
  options: GlassOption<T>[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  className?: string;
  /** Drag to pick — for a single row only; a grid of cards wraps, so it can't be scrubbed. */
  draggable?: boolean;
  /** Navigation (the chosen one is the page you're on) rather than a pressed toggle. */
  current?: boolean;
}) {
  const track = useRef<HTMLDivElement>(null);
  const seg = useRef<GlassSegment | null>(null);
  const latest = useRef({ options, onChange });
  latest.current = { options, onChange };

  useLayoutEffect(() => {
    if (!track.current) return;
    const s = new GlassSegment(track.current, {
      draggable,
      onPick: (item) => {
        const { options: opts, onChange: change } = latest.current;
        const opt = opts.find((o) => o.value === item.dataset.value);
        if (opt && !opt.disabled) change(opt.value);
      },
    });
    seg.current = s;
    return () => {
      s.destroy();
      seg.current = null;
    };
  }, [draggable]);

  useLayoutEffect(() => {
    const el = track.current?.querySelector<HTMLElement>(`:scope > [data-value="${CSS.escape(value)}"]`);
    seg.current?.setActive(el ?? null);
  }, [value, options.length]);

  return (
    <div ref={track} className={"lg-seg " + className} role="group" aria-label={label}>
      <span className="lg-seg__thumb" aria-hidden="true" />
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            data-lg-item=""
            data-value={o.value}
            className={"lg-seg__item" + (o.className ? " " + o.className : "")}
            aria-pressed={current ? undefined : on}
            aria-current={current && on ? "page" : undefined}
            disabled={o.disabled}
            title={o.title}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        );
      })}
      <span className="lg-seg__lens" aria-hidden="true" />
    </div>
  );
}
