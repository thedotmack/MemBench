export const MAX_ID_LENGTH = 80 as const;

const safeIdentifierPattern = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;

export function isSafeIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_ID_LENGTH && safeIdentifierPattern.test(value);
}

export function requireSafeIdentifier(value: unknown, label: string): string {
  if (!isSafeIdentifier(value)) throw new TypeError(`${label} must be a safe identifier of at most 80 characters`);
  return value;
}
