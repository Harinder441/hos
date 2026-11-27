const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const NUMBER = /^\d+$/;

const pad = (n: string) => n.padStart(2, '0');

function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${suffix}`;
}

function days(dow: string): string | null {
  if (dow === '*') return 'Daily';
  if (dow === '1-5') return 'Weekdays';
  const list = dow.split(',');
  if (!list.every((d) => NUMBER.test(d) && Number(d) <= 7)) return null;
  if (list.length === 1) return `Every ${DAYS[Number(list[0])]}`;
  return list.map((d) => DAYS[Number(d)]!.slice(0, 3)).join(', ');
}

export function cronText(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [minute, hour, dom, month, dow] = parts as [string, string, string, string, string];
  const every = /^\*\/(\d+)$/.exec(minute);
  if (hour === '*' && dom === '*' && month === '*' && dow === '*') {
    if (minute === '*') return 'Every minute';
    if (every) return `Every ${every[1]} minutes`;
    if (NUMBER.test(minute)) return minute === '0' ? 'Every hour' : `Every hour at :${pad(minute)}`;
    return cron;
  }
  const hours = hour.split(',');
  if (!NUMBER.test(minute) || !hours.every((h) => NUMBER.test(h)) || month !== '*') return cron;
  const at = `at ${hours.map((h) => `${pad(h)}:${pad(minute)}`).join(' and ')}`;
  if (dom !== '*') return NUMBER.test(dom) && dow === '*' ? `Monthly on the ${ordinal(Number(dom))} ${at}` : cron;
  const on = days(dow);
  return on ? `${on} ${at}` : cron;
}
