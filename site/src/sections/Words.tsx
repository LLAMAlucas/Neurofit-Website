/**
 * A paragraph's text as word spans, for the scroll reveal (hooks/lineReveal): dim, then each line
 * brightening left to right as the reader scrolls into the stop — after dragonfly.xyz. The spaces
 * stay plain text, so the paragraph wraps exactly as it would unsplit, and a screen reader reads
 * it as one sentence.
 */
export function Words({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\s+)/).map((part, i) =>
        part.trim() ? (
          <span key={i} className="w">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}
