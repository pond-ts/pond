// Local wall-clock time of a timestamp, for the time axis (in the render
// worker) and the tooltip (on the page), so the two always agree.
const two = (n: number) => String(n).padStart(2, '0');

/** `hh:mm:ss`, or `hh:mm:ss.mmm` with `ms`, in the browser's time zone. */
export function clock(t: number, ms = false): string {
  const d = new Date(t);
  const hms = `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
  return ms ? `${hms}.${String(d.getMilliseconds()).padStart(3, '0')}` : hms;
}
