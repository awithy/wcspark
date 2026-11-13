/**
 * Parses --since / --until / --on values into epoch milliseconds (local time zone).
 *
 * Accepted: `today`, `yesterday`, weekday names (`mon`, `tuesday`: the most recent one, today
 * included), `YYYY-MM-DD`, `YYYY-MM-DD HH:mm`, relative ages (`30m`, `12h`, `7d`, `2w`, optionally
 * with a leading `-` or a trailing ` ago`), and ISO timestamps with `Z` or an offset.
 */

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

export interface Day {
  start: number;
  /** Exclusive end: the start of the next day. */
  end: number;
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const dayOf = (d: Date): Day => ({ start: d.getTime(), end: addDays(d, 1).getTime() });

/** Resolves values that name a whole day; returns null for anything else. */
export function parseDay(input: string, now = new Date()): Day | null {
  const s = input.trim().toLowerCase();
  const today = startOfDay(now);
  if (s === "today") return dayOf(today);
  if (s === "yesterday") return dayOf(addDays(today, -1));
  const wd = WEEKDAYS.findIndex((w) => s === w || s === w.slice(0, 3));
  if (wd >= 0) return dayOf(addDays(today, -((today.getDay() - wd + 7) % 7)));
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (d.getMonth() !== Number(m[2]) - 1) throw new Error(`Invalid date: ${input}`);
    return dayOf(d);
  }
  return null;
}

/**
 * Parses a point in time. For values that name a whole day, `edge` picks its start (for --since)
 * or its exclusive end (for --until, so `--until 2026-11-10` includes the 10th).
 */
export function parseWhen(input: string, edge: "start" | "end", now = new Date()): number {
  const day = parseDay(input, now);
  if (day) return edge === "start" ? day.start : day.end;

  const s = input.trim().toLowerCase();
  const rel = /^-?(\d+)\s*(m|min|mins|h|hr|hrs|d|days?|w|wks?|weeks?)(\s+ago)?$/.exec(s);
  if (rel) return now.getTime() - Number(rel[1]) * UNIT_MS[rel[2]![0]!]!;

  const local = /^(\d{4})-(\d{2})-(\d{2})[ t](\d{1,2}):(\d{2})$/.exec(s);
  if (local) {
    const [, y, mo, d, h, mi] = local.map(Number) as [number, number, number, number, number, number];
    return new Date(y, mo - 1, d, h, mi).getTime();
  }
  if (/^\d{4}-\d{2}-\d{2}t.*(z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const t = Date.parse(input.trim());
    if (!Number.isNaN(t)) return t;
  }
  throw new Error(
    `Unrecognised time "${input}". Use today, yesterday, a weekday, YYYY-MM-DD, "YYYY-MM-DD HH:mm", 7d/12h/2w, or an ISO timestamp.`,
  );
}
