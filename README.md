# Locale Sheet Switcher GitHub

Figma plugin for locale-driven mockup swaps using a companion OAuth bridge server.

## How It Works

1. The plugin opens a company OAuth bridge server.
2. Each designer signs in with their own Google account in the browser.
3. The bridge server exchanges the OAuth code and stores a short-lived session.
4. The plugin asks the bridge for locale JSON from the private Google Sheet.
5. The plugin replaces text based on text layer `msg-id` names.

## Plugin Usage

1. Run the bridge server first.
2. Import the Figma plugin from `manifest.json`.
3. Enter the bridge URL, spreadsheet URL, and sheet name.
4. Click `Sign In with Google`.
5. Complete browser login with your own Google account.
6. Click `Load Sheet`.
7. Choose either a specific language or `Apply Longest Translation`.
8. Click `Apply to Selection`.

## Bridge Server

Server folder:

- `locale-sheet-auth-bridge/`

Start it with:

```bash
cd locale-sheet-auth-bridge
GOOGLE_CLIENT_ID=your_google_web_client_id \
GOOGLE_CLIENT_SECRET=your_google_web_client_secret \
BASE_URL=http://localhost:4180 \
ALLOWED_EMAIL_DOMAIN=d8aspring.com \
npm start
```

Optional env vars:

- `PORT`
- `BASE_URL`
- `GOOGLE_REDIRECT_URI`
- `ALLOWED_EMAIL_DOMAIN`

## Required Google OAuth Setup

Create a Google OAuth client for a web application and add the callback URL:

- `http://localhost:4180/oauth/google/callback`

Required Google scope:

- `https://www.googleapis.com/auth/spreadsheets.readonly`
- `https://www.googleapis.com/auth/userinfo.email`

Also make sure `Google Sheets API` is enabled in the same Google Cloud project.

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
