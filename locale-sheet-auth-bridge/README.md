# Locale Sheet Auth Bridge

OAuth bridge for `Locale Sheet Switcher`.

This server lets each designer:

1. Sign in with their own Google account
2. Read a private Google Sheet they already have access to
3. Return locale data to the Figma plugin over HTTPS

## Local Development

```bash
cd /Users/hwajinoh/Downloads/Codex/locale-sheet-auth-bridge
GOOGLE_CLIENT_ID=your_google_web_client_id \
GOOGLE_CLIENT_SECRET=your_google_web_client_secret \
BASE_URL=http://localhost:4180 \
ALLOWED_EMAIL_DOMAIN=d8aspring.com \
npm start
```

## Vercel Deployment

This bridge is Vercel-ready.

Deploy the folder itself and set these environment variables:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `ALLOWED_EMAIL_DOMAIN`
- `SESSION_TTL_SECONDS`

For shared production use, add a Redis-backed session store:

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

The server also accepts:

- `KV_REST_API_URL`
- `KV_REST_API_TOKEN`

if your Redis provider exposes Vercel-compatible names.

## Google OAuth Setup

Create a Google OAuth client with:

- Application type: `Web application`
- Authorized redirect URI:
  - `https://YOUR_VERCEL_DOMAIN/oauth/google/callback`

Also enable:

- `Google Sheets API`

The bridge requests:

- `https://www.googleapis.com/auth/spreadsheets.readonly`
- `https://www.googleapis.com/auth/userinfo.email`

## Endpoints

- `POST /api/auth/start`
- `GET /api/auth/session/:sessionId`
- `GET /oauth/google/callback`
- `GET /api/locale?sessionId=...&spreadsheetId=...&sheetName=...`
