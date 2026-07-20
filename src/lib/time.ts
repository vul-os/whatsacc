// Gateway timestamps are Unix seconds (see api.ts's UnixSeconds type doc
// comment), not ISO-8601 strings. `new Date(unixSeconds)` treats the number
// as milliseconds and produces a bogus 1970-something date — this helper is
// the one place that conversion happens so call sites can't get it wrong.

/** Convert a gateway Unix-seconds timestamp to a Date, or null passthrough. */
export function fromUnix(sec: number | null | undefined): Date | null {
  if (sec === null || sec === undefined) return null;
  return new Date(sec * 1000);
}
