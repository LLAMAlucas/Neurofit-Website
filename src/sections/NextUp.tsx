import { useRef, useState, type FormEvent } from "react";

const DEFAULT_NOTE =
  "No launch date promised. One message when it’s open to try — that’s the entire use of your address.";

export function NextUp() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState(DEFAULT_NOTE);
  const [done, setDone] = useState(false);

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const input = inputRef.current;
    if (!input) return;

    if (!input.value || !input.checkValidity()) {
      input.focus();
      setNote("That address doesn't look right — mind checking it?");
      setDone(false);
      return;
    }

    setNote("Noted. One message when it's open to try, and nothing else.");
    setDone(true);
    input.value = "";
    input.blur();
  };

  return (
    <section className="sec sec--next">
      <div className="shell shell--narrow">
        <div className="next reveal">
          <span className="eyebrow">What’s next</span>
          <p className="next__p">
            A second exercise arrives once it’s been checked against more than one body — the same
            problem still open for squats. Adding six half-working ones would be quick, and would
            make this worse.
          </p>
        </div>

        <div className="signup reveal" data-d="1">
          <form className="signup__form" id="notify" noValidate onSubmit={onSubmit}>
            <label className="signup__label" htmlFor="email">
              Email
            </label>
            <div className="signup__row">
              <input
                ref={inputRef}
                className="signup__input"
                id="email"
                name="email"
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder="you@example.com"
                aria-describedby="note"
                required
              />
              <button className="btn btn--primary" type="submit">
                Notify me
              </button>
            </div>
            <p className={`signup__note${done ? " is-done" : ""}`} id="note">
              {note}
            </p>
          </form>
        </div>
      </div>
    </section>
  );
}
