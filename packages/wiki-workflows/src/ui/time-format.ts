const LOCAL_DATE_TIME = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "medium",
});

const LOCAL_TIME = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

export function formatLocalDateTime(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? LOCAL_DATE_TIME.format(timestamp) : value;
}

export function formatLocalTime(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? LOCAL_TIME.format(timestamp) : value;
}
