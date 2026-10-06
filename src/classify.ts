// Splits a verified delivery body into an event or a control envelope
// (docs/spec/design-sketch-2026-10-06.md, "EventOccurrence schema" and "Non-event webhook bodies").
// Only the fields the inbox indexes are extracted; the raw body is stored as received.

export type Message =
  | { kind: 'event'; eventId: string; name: string; timestamp: string; cursor: string | null }
  | { kind: 'gap'; cursor: string | null }
  | { kind: 'terminated'; code: number; message: string }
  | { kind: 'verification'; challenge: string }
  | { kind: 'unknown_control'; type: string };

export class MalformedBody extends Error {}

const utf8 = new TextDecoder('utf-8', { fatal: true });

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// An absent cursor is the same as null.
function readCursor(body: Record<string, unknown>): string | null {
  const cursor = body.cursor;
  if (cursor === undefined || cursor === null) return null;
  if (typeof cursor !== 'string') throw new MalformedBody('cursor must be a string or null');
  return cursor;
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string') throw new MalformedBody(`${field} must be a string`);
  return value;
}

export function classify(raw: Buffer): Message {
  let body: unknown;
  try {
    body = JSON.parse(utf8.decode(raw));
  } catch {
    throw new MalformedBody('body is not UTF-8 JSON');
  }
  if (!isObject(body)) throw new MalformedBody('body must be a JSON object');

  if (!('type' in body)) {
    const eventId = requireString(body, 'eventId');
    if (eventId === '') throw new MalformedBody('eventId must not be empty');
    const name = requireString(body, 'name');
    const timestamp = requireString(body, 'timestamp');
    if (!isObject(body.data)) throw new MalformedBody('data must be an object');
    return { kind: 'event', eventId, name, timestamp, cursor: readCursor(body) };
  }

  const type = body.type;
  if (typeof type !== 'string') throw new MalformedBody('type must be a string');
  switch (type) {
    case 'gap':
      return { kind: 'gap', cursor: readCursor(body) };
    case 'terminated': {
      const error = body.error;
      if (!isObject(error) || !Number.isInteger(error.code) || typeof error.message !== 'string') {
        throw new MalformedBody('terminated needs error.code (integer) and error.message (string)');
      }
      return { kind: 'terminated', code: error.code as number, message: error.message };
    }
    case 'verification':
      return { kind: 'verification', challenge: requireString(body, 'challenge') };
    default:
      return { kind: 'unknown_control', type };
  }
}
