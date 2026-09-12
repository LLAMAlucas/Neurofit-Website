export function Masthead() {
  return (
    <header className="masthead" id="masthead">
      <div className="shell masthead__in">
        <a className="wordmark" href="#top">
          <span className="wordmark__mark" aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            >
              <circle cx="12" cy="4.4" r="2.2" fill="currentColor" stroke="none" />
              <path d="M12 7v6.2M12 13.2 8.2 18.8M12 13.2l3.8 5.6M7.6 9.6h8.8" />
            </svg>
          </span>
          Neuro-Fit
        </a>

        {/* Deliberately NOT .masthead__nav — that is hidden below 720px, and this
            is the one control on the page a phone visitor actually needs. The
            tracker is a separate origin (its own Vercel project off the same
            repo) so the camera permission it asks for is scoped to it alone and
            never to the marketing page. */}
        <a className="try-cta" href="https://try.neurofit-training.com">
          Try it out
        </a>
      </div>
    </header>
  );
}
