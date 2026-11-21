# Webhook Inspector

A self-hosted, [webhook.site](https://webhook.site)-style request inspector running as a single
Cloudflare Worker on the free tier. Point any webhook at your `workers.dev` URL — every
POST/PUT/PATCH/DELETE is logged to Workers KV and shown live in a built-in inspector UI.

## Features

- **Catch-all ingest** — any method on any path is logged (GET/HEAD are ignored to keep browser noise out)
- **Web UI at `/`** — live-updating request list, tabs for body / headers / query / overview / cURL,
  syntax-highlighted JSON, full-text filter, keyboard navigation (`j`/`k`/arrows, `Delete`),
  copy-as-cURL / copy-as-JSON
- **JSON API** for events (see below)
- **Self-cleaning** — events expire after 90 days (KV TTL); bodies capped at 256 KiB
- **Optional token auth** for the ingest endpoint
- No build step, no dependencies at runtime — one Worker file + KV

## Endpoints

| Method | Path              | Description                              |
|--------|-------------------|------------------------------------------|
| ANY    | `/<anything>`     | Log the request (POST/PUT/PATCH/DELETE)  |
| GET    | `/`               | Inspector web UI                         |
| GET    | `/api/events`     | List events, newest first (`?limit=`, `?q=`) |
| GET    | `/api/events/:id` | Fetch a single event                     |
| DELETE | `/api/events/:id` | Delete a single event                    |
| DELETE | `/api/events`     | Delete all events                        |

## Deploy

1. **Login to Cloudflare** (opens a browser, once):
   ```sh
   pnpm exec wrangler login
   ```
2. **Deploy**:
   ```sh
   pnpm install
   pnpm deploy
   ```
   Wrangler auto-provisions the KV namespace on first deploy (see the
   [Wrangler configuration docs](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning))
   and prints the live URL, e.g. `https://webhook-logger.<your-subdomain>.workers.dev`.

No browser access? `pnpm exec wrangler deploy --temporary` publishes to a
throwaway preview account (no login needed) and prints a claim URL that
upgrades it to a full account within an hour.

Deploy fails with `fetch failed` on a network with broken IPv6? Prefix the
command: `NODE_OPTIONS=--dns-result-order=ipv4first pnpm run deploy`.

Send a test request:
```sh
curl -X POST https://<your-worker>.workers.dev/orbit/webhook \
  -H 'content-type: application/json' \
  -d '{"hello": "world"}'
```
…then open the root URL in a browser to watch it appear.

## Local development

```sh
pnpm install
pnpm dev        # wrangler dev on http://localhost:8787, with local KV state in .wrangler/
```

## Optional: require a token on ingest

By default the endpoint is open (anyone who knows the URL can log requests). To require a
shared secret:

```sh
pnpm exec wrangler secret put WEBHOOK_TOKEN
```

Senders must then include it as `x-webhook-token: <secret>` header or `?token=<secret>`
query parameter. Unauthenticated requests get `401`. Redeploy is not needed after changing
secrets.

## Free-tier notes

- KV free tier allows **1,000 writes/day** — fine for typical webhook debugging.
  If a sender floods past that, move storage to D1 (100k writes/day free) and swap the
  `env.EVENTS` calls in `src/index.js`.
- Reads (UI polling every 4s) are well within the 100k reads/day free allowance.
