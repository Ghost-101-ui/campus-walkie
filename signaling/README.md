# campus-walkie signalling relay

A blind WebSocket switchboard. WebRTC cannot introduce two peers without one; this
is the smallest thing that does the job and nothing else.

It runs on the Cloudflare Workers **free** tier: 100 000 requests/day, and Durable
Objects on the free plan cover a group of friends comfortably. Cost: $0.

## Deploy in 4 commands

```sh
npm i -g wrangler
wrangler login
npm install          # inside signaling/
wrangler deploy
```

`wrangler deploy` prints your URL, e.g.
`https://campus-walkie-relay.<your-subdomain>.workers.dev`.

Put it in the app's `.env` (note the `wss://` scheme):

```
VITE_RELAY_URL=wss://campus-walkie-relay.<your-subdomain>.workers.dev
```

You do not have to rebuild the app to use a different relay: the join screen has a
**custom relay** field, and whatever you type there is remembered locally.

Check it is alive:

```sh
curl https://campus-walkie-relay.<your-subdomain>.workers.dev/health   # -> ok
```

## Protocol

```
GET /room/:channelId    Upgrade: websocket
GET /health             -> "ok"
```

`:channelId` is 16-64 base64url characters. The app sends the 22-char
`base64url(HMAC-SHA-256(idKey, "campus-walkie:v1:channel-id"))`.

Server to client, plaintext JSON, and these are the only plaintext frames:

```json
{"t":"welcome","you":"<connId>","peers":["<connId>", ...]}
{"t":"join","id":"<connId>"}
{"t":"leave","id":"<connId>"}
{"t":"ping"}
{"t":"full"}
```

Client to server:

```json
{"t":"sig","to":"<connId>|null","d":"<base64url sealed envelope>"}
{"t":"pong"}
```

`to: null` broadcasts to everyone else in the room. Delivered as
`{"t":"sig","from":"<connId>","d":"..."}` with `d` untouched.

`connId` is a random 16-character id the **server** assigns. It is not the
cryptographic `peerId`, which lives inside the sealed envelope and which the relay
never sees.

## Limits

| Rule | Value | On breach |
| --- | --- | --- |
| Peers per room | 12 | `{"t":"full"}` then close 1013 |
| Frame size | 64 KB | close 1009 |
| Message rate | 60 /s per connection | close 1008 |
| Byte rate | 256 KB/s per connection | close 1008 |
| Liveness | ping every 30 s | close 1001 after 90 s silent |

## What it stores

Nothing. `Room` never touches `state.storage`; it holds a `Map` of live sockets in
memory and the runtime evicts it once the last socket closes. `d` is never logged,
and `[observability] enabled = false` in `wrangler.toml` keeps request logs off
too. Trusting that claim is not required: the payload is AES-GCM ciphertext under a
key derived from a passphrase that never leaves the browsers.

## Origin allowlist

`ALLOWED_ORIGINS` in `wrangler.toml` defaults to `*` so forks work with no config.
Set it to your Pages origin to stop strangers using your bandwidth:

```toml
[vars]
ALLOWED_ORIGINS = "https://you.github.io"
```

Requests with no `Origin` header (curl, tests) are always allowed - this is a
bandwidth control, not a security boundary.

## Self-hosting somewhere else

The relay is ~230 lines with one Cloudflare-specific dependency: `WebSocketPair`
plus Durable Objects for "all sockets for one channel land in the same process".
Any WebSocket server that can do room fan-out works. Keep the protocol identical
and the app will not notice.
