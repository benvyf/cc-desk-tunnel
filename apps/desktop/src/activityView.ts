import type { Session } from '@cc-desk-tunnel/protocol';

// The activity view (查看活动): every session, of every project and computer, as one list by when it last
// changed, under what needs the user first.

export type DayGroup = { key: string; label: string; sessions: Session[] };

const weekday = new Intl.DateTimeFormat('zh-CN', { weekday: 'long' });
const startOfDay = (time: number) => {
  const day = new Date(time);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
};
// The start of the next day after `now`, local time: when the day headings change.
export const nextDay = (now: number) => {
  const day = new Date(startOfDay(now));
  day.setDate(day.getDate() + 1);
  return day.getTime();
};
// A day's heading: 今天, 昨天, the weekday within the week, the date before that, with the year when it is not
// this one.
export function dayLabel(time: number, now: number) {
  const today = startOfDay(now);
  const day = startOfDay(time);
  // Days, counted by the calendar: a change of clocks makes one 23 or 25 hours long.
  const back = Math.round((today - day) / 86_400_000);
  if (back <= 0) return '今天';
  if (back === 1) return '昨天';
  if (back < 7) return weekday.format(day);
  const date = new Date(day);
  const short = `${date.getMonth() + 1}月${date.getDate()}日`;
  return date.getFullYear() === new Date(now).getFullYear()
    ? short
    : `${date.getFullYear()}年${short}`;
}

// The sessions that need the user, most pressing first (`rank` gives none for the others), and the rest by day,
// newest first. A session is listed once: one that needs the user is not repeated under its day.
export function activityGroups(
  sessions: readonly Session[],
  rank: (session: Session) => number | undefined,
  now: number,
) {
  const priority: { session: Session; rank: number }[] = [];
  const rest: Session[] = [];
  for (const session of sessions) {
    const value = rank(session);
    if (value === undefined) rest.push(session);
    else priority.push({ session, rank: value });
  }
  priority.sort(
    (a, b) => b.rank - a.rank || b.session.updatedAt.localeCompare(a.session.updatedAt),
  );
  rest.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const days: DayGroup[] = [];
  for (const session of rest) {
    const time = Date.parse(session.updatedAt);
    const key = String(startOfDay(Number.isNaN(time) ? 0 : time));
    const last = days.at(-1);
    if (last?.key === key) last.sessions.push(session);
    else days.push({ key, label: dayLabel(time, now), sessions: [session] });
  }
  return { priority: priority.map((item) => item.session), days };
}
