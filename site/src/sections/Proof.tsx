const SPEC: Array<[string, string]> = [
  ["Shows", "An uncut set, filmed head-on, with a knee visibly falling in"],
  ["On screen", "The tracing marking that knee at the moment it happens"],
  ["Then", "The write-up it produced afterwards, word for word"],
  ["Rule", "One take — no retries, no picking the run that went well"],
];

export function Proof() {
  return (
    <section id="proof" className="sec sec--proof">
      <div className="shell">
        <header className="sec__head">
          <span className="eyebrow reveal">Proof</span>
          <h2 className="h2 reveal" data-d="1">
            Watch it catch one.
          </h2>
          <p className="sec__intro reveal" data-d="2">
            The only claim here that really matters is whether it spots a fault when a fault
            happens. That’s a video, not a paragraph — so this is the space for it, left empty until
            the footage is real.
          </p>
        </header>

        <figure className="slot reveal" data-d="1">
          <div className="slot__frame">
            <div className="lens__chrome" aria-hidden="true">
              <span className="brk brk--tl" />
              <span className="brk brk--tr" />
              <span className="brk brk--bl" />
              <span className="brk brk--br" />
            </div>
            <div className="slot__body">
              <span className="chip chip--warn">FOOTAGE NOT SHOT YET</span>
              <p className="slot__txt">
                A placeholder, left deliberately blank rather than filled with a stock clip or a
                staged mock-up.
              </p>
              <dl className="spec">
                {SPEC.map(([dt, dd]) => (
                  <div key={dt}>
                    <dt>{dt}</dt>
                    <dd>{dd}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
          <figcaption className="slot__cap">
            Until this is filled in, everything on this page is a claim rather than a demonstration.
            Judge it accordingly.
          </figcaption>
        </figure>
      </div>
    </section>
  );
}
