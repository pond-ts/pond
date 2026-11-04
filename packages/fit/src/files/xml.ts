/** An element's text as written: a CDATA section's contents, or plain text
 *  with the five XML entities and numeric character references decoded. */
export function xmlText(raw: string | undefined): string | undefined {
  if (raw == null) return undefined;
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(raw);
  if (cdata) return cdata[1]!.trim();
  return raw
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) =>
      String.fromCodePoint(parseInt(h, 16)),
    )
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

const CHILD = new Map<string, RegExp>();

/** Text of the first `<tag>` (any namespace prefix) in `xml`, CDATA included;
 *  `undefined` when absent or empty. */
export function childText(xml: string, tag: string): string | undefined {
  let re = CHILD.get(tag);
  if (!re) {
    re = new RegExp(
      `<(?:[\\w-]+:)?${tag}\\b[^>]*>((?:<!\\[CDATA\\[[\\s\\S]*?\\]\\]>|[^<])*)</(?:[\\w-]+:)?${tag}>`,
    );
    CHILD.set(tag, re);
  }
  const text = xmlText(re.exec(xml)?.[1]);
  return text ? text : undefined;
}

/** An attribute's value (single or double quotes), decoded. */
export function attr(attrs: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`);
  const m = re.exec(attrs);
  return m ? xmlText(m[1] ?? m[2]) : undefined;
}

/**
 * Seconds from the first timed sample, with a sample that has no time given
 * the time before it (or, before the first timed sample, the first time), so
 * the stream never runs backwards. `undefined` when no sample has a time.
 */
export function offsetSeconds(
  epochMs: readonly number[],
): number[] | undefined {
  const first = epochMs.find((t) => !Number.isNaN(t));
  if (first === undefined) return undefined;
  let last = first;
  return epochMs.map((t) => {
    if (!Number.isNaN(t)) last = t;
    return (last - first) / 1000;
  });
}
