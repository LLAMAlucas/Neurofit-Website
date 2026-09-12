export function Cost() {
  return (
    <section id="cost" className="sec">
      <div className="shell">
        <header className="sec__head">
          <span className="eyebrow reveal">Cost</span>
          <h2 className="h2 reveal" data-d="1">
            What you pay, and when.
          </h2>
          <p className="sec__intro reveal" data-d="2">
            Up front rather than after you hit a wall, because discovering it later is the thing
            that makes people stop trusting a product.
          </p>
        </header>

        <div className="cards">
          <div className="card reveal">
            <span className="card__k">Always free</span>
            <h3 className="card__h">Everything the camera does.</h3>
            <p>
              Following your movement, counting reps, judging depth, drawing it on screen — all of
              that happens on your own device. It works with the network off and it costs nobody
              anything, so it stays free for good.
            </p>
          </div>
          <div className="card reveal" data-d="1">
            <span className="card__k">Free to try</span>
            <h3 className="card__h">
              Your first <span className="tbd">[N]</span> coached sessions.
            </h3>
            <p>
              The written coaching is the part that costs real money to produce. We cover a set
              number of sessions so you can find out whether the feedback is any good before paying
              anything for it.
            </p>
          </div>
          <div className="card reveal" data-d="2">
            <span className="card__k">After that</span>
            <h3 className="card__h">Your own key, or a small fee.</h3>
            <p>
              Bring your own Gemini API key — Google’s free tier covers light use, and you’d be
              paying Google rather than us. Or pay us a small flat amount and use ours. No
              subscription, no card to get started.
            </p>
          </div>
        </div>

        <aside className="callout callout--flat reveal">
          <span className="callout__k">Where your video goes</span>
          <p className="callout__p">
            The camera feed is handled on your device and the video itself is never uploaded. When
            you ask for feedback on a set, a handful of still frames from it are sent off to be
            written up. The end-of-workout summary sends no images at all.
          </p>
        </aside>
      </div>
    </section>
  );
}
