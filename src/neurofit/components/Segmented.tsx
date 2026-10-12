/**
 * A flat switch: real buttons in a row (or a grid of cards with `seg--cards`), the chosen one
 * filled with the accent. Replaced the liquid-glass switch (2026-10-12) — no droplet, no drag:
 * every option is an ordinary <button> with its own onClick, so keyboard and screen readers work
 * as they always did. Styles live in chrome/chrome.css (.seg, .seg__item, .seg--cards).
 */
import type { ReactNode } from "react";

export interface SegOption<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
  title?: string;
  className?: string;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  className = "",
  current = false,
}: {
  options: SegOption<T>[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  className?: string;
  /** Navigation (the chosen one is the page you're on) rather than a pressed toggle. */
  current?: boolean;
}) {
  return (
    <div className={"seg" + (className ? " " + className : "")} role="group" aria-label={label}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            data-value={o.value}
            className={"seg__item" + (o.className ? " " + o.className : "")}
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
    </div>
  );
}
