const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

const fullDay = (d: Date, now: Date) =>
  d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(d.getFullYear() !== now.getFullYear() && { year: "numeric" }),
  });

/** A day heading: a relative name where one exists ("Today"), plus the calendar date. */
export function dayLabel(ts: number, now = new Date()): { name: string; date: string | null } {
  const d = new Date(ts);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const date = fullDay(d, now);
  if (sameDay(d, now)) return { name: "Today", date };
  if (sameDay(d, yesterday)) return { name: "Yesterday", date };
  return { name: date, date: null };
}

export const timeLabel = (ts: number) =>
  new Date(ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

export const fullTimestamp = (ts: number) =>
  new Date(ts).toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" });
