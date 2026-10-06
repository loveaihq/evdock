/** Server-supplied text made safe for one log or terminal line: control characters replaced, length capped. */
export function printable(value: unknown, max = 200): string {
  return String(value)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '?')
    .slice(0, max);
}
