/// <reference types="@cloudflare/workers-types" />
/**
 * campus-walkie signalling relay.
 *
 * A blind WebSocket switchboard: one Durable Object per channel id, holding
 * nothing but the set of live sockets. It cannot read anything a client sends in
 * `d` - that is AES-GCM ciphertext keyed by a passphrase the relay never sees.
 *
 *   GET /room/:channelId  (Upgrade: websocket)
 *   GET /health           -> "ok"
 *
 * Plaintext control frames, server -> client (no user data in any of them):
 *   {"t":"welcome","you":"<connId>","peers":["<connId>",...]}
 *   {"t":"join","id":"<connId>"}
 *   {"t":"leave","id":"<connId>"}
 *   {"t":"ping"}                     liveness probe every 30 s
 *   {"t":"full"}                     then close 1013
 *
 * Client -> server:
 *   {"t":"sig","to":"<connId>|null","d":"<sealed envelope>"}   relayed verbatim
 *   {"t":"pong"}                                               liveness reply
 *
 * Relayed to the recipient as {"t":"sig","from":"<connId>","d":"..."}.
 */

export interface Env {
  ROOMS: DurableObjectNamespace;
  /** Comma-separated origin allowlist. "*" (the default) allows every origin so forks work. */
  ALLOWED_ORIGINS?: string;
}

/** Hard cap on sockets per room. The 13th connection is rejected. */
const MAX_PEERS = 12;
/** Max incoming frame size. Chunked voice notes stay well under this. */
const MAX_FRAME_BYTES = 64 * 1024;
/** Rate limits, per connection, per rolling second. */
const MAX_MSGS_PER_SEC = 60;
const MAX_BYTES_PER_SEC = 256 * 1024;
/** Liveness. */
const PING_INTERVAL_MS = 30_000;
const IDLE_TIMEOUT_MS = 90_000;
/** channelId is 22 base64url chars; allow 16-64 so future versions still route. */
const CHANNEL_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

const CONN_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function randomConnId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let out = '';
  for (const b of bytes) out += CONN_ID_ALPHABET[b % CONN_ID_ALPHABET.length];
  return out;
}

function originAllowed(request: Request, env: Env): boolean {
  const allow = (env.ALLOWED_ORIGINS ?? '*').trim();
  if (allow === '*' || allow === '') return true;
  const origin = request.headers.get('Origin');
  if (!origin) return true; // non-browser clients (curl, tests) have no Origin
  return allow
    .split(',')
    .map((o) => o.trim())
    .includes(origin);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return new Response('ok', { headers: { 'content-type': 'text/plain' } });
    }

    const match = /^\/room\/([^/]+)$/.exec(url.pathname);
    if (!match) return new Response('not found', { status: 404 });

    const channelId = match[1] as string;
    if (!CHANNEL_ID_RE.test(channelId)) return new Response('bad channel id', { status: 400 });
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    if (!originAllowed(request, env)) return new Response('forbidden origin', { status: 403 });

    // One Durable Object per channel id. idFromName is deterministic, so every
    // peer with the same passphrase lands in the same room without a lookup table.
    const stub = env.ROOMS.get(env.ROOMS.idFromName(channelId));
    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;

interface Conn {
  id: string;
  ws: WebSocket;
  lastSeen: number;
  windowStart: number;
  msgs: number;
  bytes: number;
}

/**
 * One room. Lives only as long as it has sockets: no storage is ever written, so
 * when the last socket goes the object is evicted by the runtime with nothing left
 * behind.
 */
export class Room implements DurableObject {
  private conns = new Map<string, Conn>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(_state: DurableObjectState, _env: Env) {
    // Intentionally no state.storage use. Nothing is persisted, ever.
    void _state;
    void _env;
  }

  async fetch(_request: Request): Promise<Response> {
    void _request;
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    if (this.conns.size >= MAX_PEERS) {
      server.send(JSON.stringify({ t: 'full' }));
      server.close(1013, 'room full');
      return new Response(null, { status: 101, webSocket: client });
    }

    const now = Date.now();
    const conn: Conn = {
      id: randomConnId(),
      ws: server,
      lastSeen: now,
      windowStart: now,
      msgs: 0,
      bytes: 0,
    };
    this.conns.set(conn.id, conn);

    server.send(
      JSON.stringify({
        t: 'welcome',
        you: conn.id,
        peers: [...this.conns.keys()].filter((id) => id !== conn.id),
      }),
    );
    this.broadcast(JSON.stringify({ t: 'join', id: conn.id }), conn.id);

    server.addEventListener('message', (ev: MessageEvent) => this.onMessage(conn, ev));
    server.addEventListener('close', () => this.drop(conn.id));
    server.addEventListener('error', () => this.drop(conn.id));
    this.startTimer();

    return new Response(null, { status: 101, webSocket: client });
  }

  private onMessage(conn: Conn, ev: MessageEvent): void {
    const now = Date.now();
    conn.lastSeen = now;

    const data = ev.data;
    if (typeof data !== 'string') {
      conn.ws.close(1003, 'text frames only');
      return;
    }
    if (data.length > MAX_FRAME_BYTES) {
      conn.ws.close(1009, 'frame too large');
      return;
    }

    // Rolling one-second window. Cheap, allocation-free, good enough to stop a
    // client from turning the relay into an amplifier.
    if (now - conn.windowStart >= 1_000) {
      conn.windowStart = now;
      conn.msgs = 0;
      conn.bytes = 0;
    }
    conn.msgs++;
    conn.bytes += data.length;
    if (conn.msgs > MAX_MSGS_PER_SEC || conn.bytes > MAX_BYTES_PER_SEC) {
      conn.ws.close(1008, 'rate limit');
      this.drop(conn.id);
      return;
    }

    let msg: { t?: unknown; to?: unknown; d?: unknown };
    try {
      msg = JSON.parse(data) as typeof msg;
    } catch {
      return; // malformed frames are dropped in silence, never logged
    }
    if (msg.t === 'pong') return;
    if (msg.t !== 'sig' || typeof msg.d !== 'string') return;

    const out = JSON.stringify({ t: 'sig', from: conn.id, d: msg.d });
    if (msg.to === null || msg.to === undefined) {
      this.broadcast(out, conn.id);
    } else if (typeof msg.to === 'string') {
      const target = this.conns.get(msg.to);
      if (target) this.send(target, out);
    }
  }

  private send(conn: Conn, data: string): void {
    try {
      conn.ws.send(data);
    } catch {
      this.drop(conn.id);
    }
  }

  private broadcast(data: string, exceptId: string): void {
    for (const conn of this.conns.values()) {
      if (conn.id !== exceptId) this.send(conn, data);
    }
  }

  private drop(id: string): void {
    if (!this.conns.delete(id)) return;
    this.broadcast(JSON.stringify({ t: 'leave', id }), id);
    if (this.conns.size === 0) this.stopTimer();
  }

  private startTimer(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.tick(), PING_INTERVAL_MS);
  }

  private stopTimer(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    const now = Date.now();
    for (const conn of [...this.conns.values()]) {
      if (now - conn.lastSeen > IDLE_TIMEOUT_MS) {
        try {
          conn.ws.close(1001, 'idle');
        } catch {
          /* already gone */
        }
        this.drop(conn.id);
      } else {
        this.send(conn, JSON.stringify({ t: 'ping' }));
      }
    }
    if (this.conns.size === 0) this.stopTimer();
  }
}
