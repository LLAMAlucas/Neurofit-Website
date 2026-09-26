/**
 * How it compares: a chart of WHEN each product tells the lifter about a set —
 * during it, after it, after the workout — with Neuro-Fit on top and the
 * others below it. Pick one of the others and the facts under the chart put it
 * beside Neuro-Fit, row by row.
 *
 * The rows are real buttons in a liquid-glass track: the droplet slides to the
 * one that's picked. Everything said about another product is in its own
 * words, from its own pages (lib/competitors), and what they don't say is
 * printed as not stated rather than guessed.
 */
import { useEffect, useRef, useState } from "react";

import { CHECKED, COMPETITORS, FACTS, MOMENTS, NOT_STATED, US, type Product } from "@/lib/competitors";
import { GlassSegment } from "@/lib/liquidGlass";

function Timeline({ product }: { product: Product }) {
  return (
    <>
      <span className="chart__name">{product.name}</span>
      {MOMENTS.map((m) => {
        const what = product.when[m.id];
        return (
          <span key={m.id} className={`chart__cell${what ? " has" : ""}`}>
            <span className="chart__dot" aria-hidden="true" />
            <span className="chart__what">{what ?? <span className="sr-only">{NOT_STATED}</span>}</span>
          </span>
        );
      })}
    </>
  );
}

export function Compare() {
  const [them, setThem] = useState(COMPETITORS[0].id);
  const track = useRef<HTMLDivElement>(null);
  const glass = useRef<GlassSegment | null>(null);

  useEffect(() => {
    if (!track.current) return;
    const g = new GlassSegment(track.current, {
      draggable: false,
      onPick: (item) => item.dataset.value && setThem(item.dataset.value),
    });
    glass.current = g;
    return () => {
      g.destroy();
      glass.current = null;
    };
  }, []);

  useEffect(() => {
    const el = track.current?.querySelector<HTMLElement>(`[data-value="${them}"]`);
    glass.current?.setActive(el ?? null);
  }, [them]);

  const other = COMPETITORS.find((c) => c.id === them) ?? COMPETITORS[0];

  return (
    <div className="panel compare" data-focus-only="">
      <h2 className="h2" id="h-compare">
        How it compares.
      </h2>
      <p className="compare__intro">When each one tells you how a set went. Pick one to put it beside Neuro-Fit.</p>

      <div className="chart" role="group" aria-label="When each product gives feedback on a set">
        <div className="chart__row chart__row--head" aria-hidden="true">
          <span />
          {MOMENTS.map((m) => (
            <span key={m.id} className="chart__moment">
              {m.label}
            </span>
          ))}
        </div>
        <div className="chart__row chart__row--us">
          <Timeline product={US} />
        </div>
        {/* Phones only (site.css): there the others shrink to a row of pills,
            and the one picked gets its moments here. */}
        <div className="chart__row chart__row--them">
          <Timeline product={other} />
        </div>
        <div className="lg-seg lg-seg--cards chart__others" ref={track} role="group" aria-label="Compare with">
          <span className="lg-seg__thumb" aria-hidden="true" />
          {COMPETITORS.map((c) => (
            <button
              key={c.id}
              type="button"
              className="lg-seg__item chart__row"
              data-lg-item=""
              data-value={c.id}
              aria-pressed={c.id === them}
              onClick={() => setThem(c.id)}
            >
              <Timeline product={c} />
            </button>
          ))}
          <span className="lg-seg__lens" aria-hidden="true" />
        </div>
      </div>

      <table className="versus">
        <caption className="sr-only">Neuro-Fit beside {other.name}</caption>
        <thead>
          <tr>
            <td />
            <th scope="col">{US.name}</th>
            <th scope="col">{other.name}</th>
          </tr>
        </thead>
        <tbody>
          {FACTS.map((f) => {
            const theirs = other.facts[f.id];
            return (
              <tr key={f.id}>
                <th scope="row">{f.label}</th>
                <td>{US.facts[f.id]}</td>
                <td className={theirs ? undefined : "is-unstated"}>{theirs ?? NOT_STATED}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <p className="compare__src">
        Each product in its own words, from its own site or store listing, {CHECKED}. US prices; they change. A gap
        in the chart means their site doesn’t say, not that it can’t.{" "}
        {other.name}:{" "}
        {other.sources.map((s, i) => (
          <span key={s.url}>
            {i > 0 && " · "}
            <a href={s.url} target="_blank" rel="noopener noreferrer">
              {s.label}
            </a>
          </span>
        ))}
      </p>
    </div>
  );
}
