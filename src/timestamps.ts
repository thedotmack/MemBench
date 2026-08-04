export function requireUtcRfc3339Millis(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a UTC RFC 3339 timestamp at millisecond precision`);
  }
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/u);
  if (!match) {
    throw new TypeError(`${label} must be a UTC RFC 3339 timestamp at millisecond precision`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  if (
    day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59 ||
    Number.isNaN(Date.parse(value))
  ) throw new TypeError(`${label} must be a UTC RFC 3339 timestamp at millisecond precision`);
  return value;
}
