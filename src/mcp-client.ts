// Minimal MCP client for protocol 2026-07-28 over Streamable HTTP: just enough to call
// server/discover and the events/* methods. Stateless per the base spec: no initialize,
// every POST carries the version and method headers and the _meta envelope
// (docs/spec/mcp-2026-07-28/streamable-http.mdx "Sending Messages", "Request Metadata";
// basic-index.mdx "Per-request protocol fields").

export const PROTOCOL_VERSION = '2026-07-28';
export const EVENTS_EXTENSION = 'io.modelcontextprotocol/events';
const CLIENT_INFO = { name: 'evdock', version: '0.0.0' };
const TIMEOUT_MS = 30_000;

/** A JSON-RPC error returned by the server. */
export class McpError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

/** The request never produced a JSON-RPC response (network, HTTP or framing problem). */
export class TransportError extends Error {
  constructor(
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
  }
}

export interface McpClientOptions {
  /** The MCP endpoint, e.g. https://example.com/mcp */
  url: string;
  /** Static bearer token. Never logged. */
  token: string;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Yields the data of each SSE event; comment lines and other fields are ignored.
async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let match: RegExpMatchArray | null;
    while ((match = buffer.match(/\r\n|\r|\n/)) !== null && match.index !== undefined) {
      // A lone \r at the end of the buffer may be the first half of \r\n.
      if (match[0] === '\r' && match.index === buffer.length - 1) break;
      const line = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      if (line === '') {
        if (data.length > 0) yield data.join('\n');
        data = [];
      } else if (line.startsWith('data:')) {
        data.push(line.slice(line.startsWith('data: ') ? 6 : 5));
      }
    }
  }
}

export class McpClient {
  private nextId = 1;

  constructor(private readonly options: McpClientOptions) {}

  /**
   * Sends one request and returns its result. A response stream that breaks before the
   * response arrives is re-issued once with a new id, as the base spec requires; the
   * events/* methods are idempotent, so that is safe.
   */
  async request(method: string, params: Json = {}): Promise<Json> {
    try {
      return await this.send(method, params);
    } catch (err) {
      if (err instanceof StreamEnded) return this.send(method, params);
      throw err;
    }
  }

  /** Calls server/discover and checks that the server speaks 2026-07-28. Returns its capabilities. */
  async discover(): Promise<Json> {
    const result = await this.request('server/discover');
    const versions = result.supportedVersions;
    if (!Array.isArray(versions) || !versions.includes(PROTOCOL_VERSION)) {
      throw new TransportError(`server does not support MCP ${PROTOCOL_VERSION} (supports: ${JSON.stringify(versions)})`);
    }
    return isObject(result.capabilities) ? result.capabilities : {};
  }

  private async send(method: string, params: Json): Promise<Json> {
    const id = this.nextId++;
    const body = {
      jsonrpc: '2.0',
      id,
      method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
          'io.modelcontextprotocol/clientCapabilities': { extensions: { [EVENTS_EXTENSION]: {} } },
          'io.modelcontextprotocol/clientInfo': CLIENT_INFO,
        },
      },
    };

    let res: Response;
    try {
      res = await fetch(this.options.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': PROTOCOL_VERSION,
          'mcp-method': method,
          authorization: `Bearer ${this.options.token}`,
        },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const cause = (err as { cause?: { code?: string } }).cause;
      throw new TransportError(`${method}: ${cause?.code ?? (err as Error).message}`);
    }

    const type = res.headers.get('content-type') ?? '';
    let message: unknown;
    if (type.startsWith('text/event-stream') && res.body) {
      message = await this.readStream(res.body, id);
    } else {
      const text = await res.text();
      try {
        message = JSON.parse(text);
      } catch {
        message = undefined;
      }
    }
    return this.unwrap(method, res.status, message);
  }

  private async readStream(body: ReadableStream<Uint8Array>, id: number): Promise<unknown> {
    for await (const data of sseData(body)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      // Notifications about this request may come first; only the response carries our id.
      if (isObject(parsed) && parsed.id === id && ('result' in parsed || 'error' in parsed)) return parsed;
    }
    throw new StreamEnded();
  }

  private unwrap(method: string, status: number, message: unknown): Json {
    if (isObject(message) && isObject(message.error)) {
      const { code, message: text, data } = message.error;
      if (typeof code === 'number') throw new McpError(code, typeof text === 'string' ? text : '', data);
    }
    if (status === 401 || status === 403) throw new TransportError(`${method}: HTTP ${status} (check the token)`, status);
    if (status < 200 || status >= 300) throw new TransportError(`${method}: HTTP ${status}`, status);
    if (!isObject(message) || !isObject(message.result)) throw new TransportError(`${method}: no JSON-RPC result`, status);

    const result = message.result;
    // Absent means "complete" (servers written to earlier drafts omit it); anything else is not supported here.
    if (result.resultType !== undefined && result.resultType !== 'complete') {
      throw new TransportError(`${method}: unsupported resultType ${JSON.stringify(result.resultType)}`);
    }
    return result;
  }
}

class StreamEnded extends TransportError {
  constructor() {
    super('response stream ended before the response');
  }
}

/** True if the server's capabilities advertise the Events extension, in either place it is found today. */
export function supportsEvents(capabilities: Json): boolean {
  const extensions = capabilities.extensions;
  // SEP-3415 puts it under extensions; the design sketch and OpenAI's guide use a top-level key.
  return (isObject(extensions) && isObject(extensions[EVENTS_EXTENSION])) || isObject(capabilities.events);
}
