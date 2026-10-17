// Helpers for "which classes are today" in the institute's timezone.
const DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

export function localParts(config, date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: config.timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return {
    day: get('weekday').slice(0, 3).toUpperCase(),         // MON..SUN
    time: `${get('hour') === '24' ? '00' : get('hour')}:${get('minute')}`, // HH:MM
    date: `${get('year')}-${get('month')}-${get('day')}`,  // YYYY-MM-DD (local)
  };
}

export const isValidDays = (csv) => csv.split(',').every((d) => DAYS.includes(d.trim().toUpperCase()));

export function formatTime12(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
