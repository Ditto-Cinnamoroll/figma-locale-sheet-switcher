# Locale Sheet Switcher GitHub

Figma plugin for locale-driven mockup swaps using a companion OAuth bridge server.

## Recommended Flow

1. Deploy `locale-sheet-auth-bridge/` to Vercel.
2. Add your Google OAuth credentials and session-store environment variables in Vercel.
3. Add the deployed callback URL to Google Cloud.
4. Import this Figma plugin from `manifest.json`.
5. Enter the deployed Vercel URL in `Auth Server URL`.
6. Sign in with your own Google account.
7. Paste the spreadsheet URL, load the sheet, and apply a language or the longest translation.

## Why The Bridge Exists

The plugin does not talk to Google Sheets directly.

Instead:

1. The plugin opens the bridge URL.
2. Each designer signs in with their own Google account.
3. The bridge exchanges the OAuth code and stores a short-lived session.
4. The plugin loads locale JSON from the bridge.
5. The plugin replaces text based on text layer `msg-id` names.

## Bridge Server

Bridge folder:

- `locale-sheet-auth-bridge/`

For local development:

```bash
cd locale-sheet-auth-bridge
GOOGLE_CLIENT_ID=your_google_web_client_id \
GOOGLE_CLIENT_SECRET=your_google_web_client_secret \
BASE_URL=http://localhost:4180 \
ALLOWED_EMAIL_DOMAIN=d8aspring.com \
npm start
```

For Vercel deployment, configure:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `ALLOWED_EMAIL_DOMAIN`
- `SESSION_TTL_SECONDS`
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

`KV_REST_API_URL` and `KV_REST_API_TOKEN` are also supported if your storage provider exposes Vercel-compatible variable names.

## Required Google OAuth Setup

Create a Google OAuth client for a web application and add the deployed callback URL:

- `https://YOUR_VERCEL_DOMAIN/oauth/google/callback`

Also make sure `Google Sheets API` is enabled in the same Google Cloud project.

## Plugin Usage

1. Import the Figma plugin from `manifest.json`.
2. Enter the deployed HTTPS bridge URL.
3. Click `Sign In with Google`.
4. Complete browser login with your own Google account.
5. Paste the spreadsheet URL and enter the sheet name.
6. Click `Load Sheet`.
7. Choose either a specific language or `Apply Longest Translation`.
8. Click `Apply to Selection`.

## Bridge Response Shape

The bridge normalizes the sheet into:

```json
{
  "languages": ["en", "de", "fr", "ko", "ja"],
  "records": {
    "agreement_required": {
      "locales": {
        "en": "I agree to the <a href=\"/terms-of-use\">Terms of Use</a>.",
        "ko": "이용약관에 동의합니다."
      }
    }
  }
}
```

The plugin strips raw HTML tags from visible text and converts anchor tags into Figma hyperlinks.
