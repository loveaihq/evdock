/** Deliveries more than this far from the receive time are rejected, in either direction. */
export const TOLERANCE_SECONDS = 5 * 60;

/** Parses `webhook-timestamp` (integer Unix seconds). Returns null if malformed. */
export function parseTimestamp(header: string): number | null {
  if (!/^[0-9]{1,15}$/.test(header)) return null;
  return Number(header);
}

/**
 * True if `timestampSeconds` is within tolerance of `receivedAtMs`.
 * The receive time is passed in rather than read from the clock so a relay can
 * supply the moment it accepted the request (M3).
 */
export function isFresh(timestampSeconds: number, receivedAtMs: number): boolean {
  const receivedAtSeconds = Math.floor(receivedAtMs / 1000);
  return Math.abs(receivedAtSeconds - timestampSeconds) <= TOLERANCE_SECONDS;
}
