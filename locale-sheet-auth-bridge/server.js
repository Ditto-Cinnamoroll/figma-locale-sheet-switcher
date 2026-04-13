import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT || 4180);
const BASE_URL = process.env.BASE_URL || "";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const ALLOWED_EMAIL_DOMAIN = process.env.ALLOWED_EMAIL_DOMAIN || "";
const SESSION_TTL_SECONDS = Number(process.env.SESSION_TTL_SECONDS || 60 * 60 * 6);
const SESSION_PREFIX = "locale-sheet-session:";

const REDIS_REST_URL =
  process.env.UPSTASH_REDIS_REST_URL ||
  process.env.KV_REST_API_URL ||
  "";
const REDIS_REST_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  process.env.KV_REST_API_TOKEN ||
  "";

const memorySessions =
  globalThis.__localeSheetBridgeSessions ||
  (globalThis.__localeSheetBridgeSessions = new Map());

function json(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  });
  res.end(JSON.stringify(payload));
}

function html(res, status, content) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(content);
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch (_error) {
    return null;
  }
}

function normalizeCell(value) {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function stripTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function resolveBaseUrl(req) {
  if (BASE_URL) return stripTrailingSlash(BASE_URL);

  const forwardedProto = req.headers["x-forwarded-proto"];
  const protocol =
    typeof forwardedProto === "string" && forwardedProto ? forwardedProto.split(",")[0] : "http";
  const host = req.headers.host || `localhost:${PORT}`;
  return `${protocol}://${host}`;
}

function parseUrl(req) {
  return new URL(req.url || "/", resolveBaseUrl(req));
}

function getGoogleRedirectUri(req) {
  return process.env.GOOGLE_REDIRECT_URI || `${resolveBaseUrl(req)}/oauth/google/callback`;
}

function ensureConfig() {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required");
  }
}

function sessionKey(sessionId) {
  return `${SESSION_PREFIX}${sessionId}`;
}

function usesRedisStore() {
  return Boolean(REDIS_REST_URL && REDIS_REST_TOKEN);
}

async function redisCommand(command) {
  const response = await fetch(REDIS_REST_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REDIS_REST_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command)
  });

  const text = await response.text();
  const data = safeJsonParse(text);

  if (!response.ok) {
    throw new Error(`Redis command failed (${response.status}): ${text}`);
  }

  if (data && data.error) {
    throw new Error(`Redis error: ${data.error}`);
  }

  return data ? data.result : null;
}

async function persistSession(session) {
  const serialized = JSON.stringify(session);

  if (usesRedisStore()) {
    await redisCommand(["SET", sessionKey(session.sessionId), serialized, "EX", SESSION_TTL_SECONDS]);
    return;
  }

  memorySessions.set(session.sessionId, session);
}

async function loadSession(sessionId) {
  if (usesRedisStore()) {
    const raw = await redisCommand(["GET", sessionKey(sessionId)]);
    if (!raw) {
      const error = new Error("Session not found");
      error.statusCode = 404;
      throw error;
    }
    const session = typeof raw === "string" ? safeJsonParse(raw) : raw;
    if (!session) {
      const error = new Error("Stored session is invalid");
      error.statusCode = 500;
      throw error;
    }
    return session;
  }

  const session = memorySessions.get(sessionId);
  if (!session) {
    const error = new Error("Session not found");
    error.statusCode = 404;
    throw error;
  }
  return session;
}

async function updateSession(sessionId, updater) {
  const session = await loadSession(sessionId);
  const next = updater ? updater(session) || session : session;
  await persistSession(next);
  return next;
}

async function createSession() {
  const session = {
    sessionId: randomUUID(),
    state: randomUUID(),
    status: "pending",
    createdAt: Date.now(),
    accessToken: "",
    refreshToken: "",
    expiresAt: 0,
    email: "",
    error: ""
  };

  await persistSession(session);
  return session;
}

function authUrlForSession(session, req) {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: getGoogleRedirectUri(req),
    response_type: "code",
    scope: [
      "https://www.googleapis.com/auth/spreadsheets.readonly",
      "https://www.googleapis.com/auth/userinfo.email"
    ].join(" "),
    access_type: "offline",
    prompt: "consent",
    state: `${session.sessionId}:${session.state}`
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function exchangeCodeForToken(code, req) {
  const body = new URLSearchParams({
    code,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    redirect_uri: getGoogleRedirectUri(req),
    grant_type: "authorization_code"
  });

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  const text = await response.text();
  const data = safeJsonParse(text);

  if (!response.ok || !data || !data.access_token) {
    throw new Error(`Token exchange failed (${response.status}): ${text}`);
  }

  return data;
}

async function refreshAccessToken(session) {
  if (!session.refreshToken) {
    throw new Error("Refresh token is missing. Please sign in again.");
  }

  const body = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    refresh_token: session.refreshToken,
    grant_type: "refresh_token"
  });

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  const text = await response.text();
  const data = safeJsonParse(text);

  if (!response.ok || !data || !data.access_token) {
    throw new Error(`Token refresh failed (${response.status}): ${text}`);
  }

  session.accessToken = data.access_token;
  session.expiresAt = Date.now() + Number(data.expires_in || 3600) * 1000;
  await persistSession(session);
}

async function ensureAccessToken(session) {
  if (session.accessToken && session.expiresAt - Date.now() > 60 * 1000) {
    return session.accessToken;
  }

  await refreshAccessToken(session);
  return session.accessToken;
}

async function fetchUserEmail(accessToken) {
  const response = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const text = await response.text();
  const data = safeJsonParse(text);

  if (!response.ok || !data || !data.email) {
    throw new Error(`Failed to fetch user info (${response.status}): ${text}`);
  }

  return data.email;
}

function assertAllowedEmail(email) {
  if (!ALLOWED_EMAIL_DOMAIN) return;
  const domain = String(email || "").split("@").pop();
  if (domain !== ALLOWED_EMAIL_DOMAIN) {
    throw new Error(`Unauthorized account domain: ${email}`);
  }
}

async function fetchSheetValues(accessToken, spreadsheetId, sheetName) {
  const range = `${sheetName}!A:Y`;
  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?majorDimension=ROWS`,
    {
      headers: { Authorization: `Bearer ${accessToken}` }
    }
  );
  const text = await response.text();
  const data = safeJsonParse(text);

  if (!response.ok) {
    throw new Error(`Sheets API failed (${response.status}): ${text}`);
  }

  return Array.isArray(data.values) ? data.values : [];
}

function findMsgIdColumnIndex(headerRow, rows) {
  const directIndex = headerRow.findIndex((cell) => normalizeCell(cell).toLowerCase() === "msg-id");
  if (directIndex >= 0) return directIndex;
  const firstDataRow = rows[1] || [];
  return firstDataRow.findIndex((cell) => normalizeCell(cell).toLowerCase() === "msg-id");
}

function parseLocaleRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("Sheet is empty");
  }

  const headerRow = rows[0] || [];
  const msgIdColumnIndex = findMsgIdColumnIndex(headerRow, rows);
  if (msgIdColumnIndex < 0) {
    throw new Error("'msg-id' column not found");
  }

  const languages = [];
  for (let i = 12; i <= 24; i += 1) {
    const header = normalizeCell(headerRow[i]);
    if (header) {
      languages.push({ index: i, label: header });
    }
  }

  if (languages.length === 0) {
    throw new Error("Language headers M:Y were not found");
  }

  const records = {};
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] || [];
    const msgId = normalizeCell(row[msgIdColumnIndex]);
    if (!msgId) continue;

    const locales = {};
    for (let i = 0; i < languages.length; i += 1) {
      const language = languages[i];
      const rawValue = row[language.index];
      if (rawValue == null || String(rawValue).trim() === "") continue;
      locales[language.label] = String(rawValue);
    }

    if (Object.keys(locales).length > 0) {
      records[msgId] = { locales };
    }
  }

  return {
    languages: languages.map((item) => item.label),
    records
  };
}

function renderOauthDonePage(status, title, message) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      body {
        margin: 0;
        font-family: Inter, system-ui, sans-serif;
        background: #f3f6fb;
        color: #17324d;
      }
      main {
        max-width: 560px;
        margin: 56px auto;
        padding: 32px;
        border-radius: 24px;
        background: #ffffff;
        box-shadow: 0 18px 48px rgba(22, 46, 74, 0.12);
      }
      .badge {
        display: inline-block;
        padding: 6px 10px;
        border-radius: 999px;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.02em;
        text-transform: uppercase;
        background: ${status === "success" ? "#d9f6e6" : "#ffe0db"};
        color: ${status === "success" ? "#0f7a43" : "#b43c29"};
      }
      h1 {
        margin: 16px 0 12px;
        font-size: 28px;
        line-height: 1.15;
      }
      p {
        margin: 0;
        font-size: 15px;
        line-height: 1.6;
        color: #51657a;
      }
    </style>
  </head>
  <body>
    <main>
      <div class="badge">${status === "success" ? "Connected" : "Action needed"}</div>
      <h1>${title}</h1>
      <p>${message}</p>
    </main>
  </body>
</html>`;
}

export async function handleNodeRequest(req, res) {
  try {
    if (!req.url) {
      json(res, 400, { error: "Bad request" });
      return;
    }

    const url = parseUrl(req);

    if (req.method === "OPTIONS") {
      json(res, 200, { ok: true });
      return;
    }

    if (url.pathname === "/api/health") {
      json(res, 200, {
        ok: true,
        baseUrl: resolveBaseUrl(req),
        usesRedisStore: usesRedisStore()
      });
      return;
    }

    if (url.pathname === "/api/auth/start" && req.method === "POST") {
      ensureConfig();
      const session = await createSession();

      json(res, 200, {
        sessionId: session.sessionId,
        authUrl: authUrlForSession(session, req)
      });
      return;
    }

    if (url.pathname.startsWith("/api/auth/session/") && req.method === "GET") {
      const sessionId = decodeURIComponent(url.pathname.split("/").pop() || "");
      const session = await loadSession(sessionId);

      json(res, 200, {
        status: session.status,
        email: session.email,
        error: session.error
      });
      return;
    }

    if (url.pathname === "/oauth/google/callback" && req.method === "GET") {
      ensureConfig();
      const state = url.searchParams.get("state") || "";
      const code = url.searchParams.get("code") || "";
      const oauthError = url.searchParams.get("error") || "";
      const parts = state.split(":");

      if (parts.length !== 2) {
        throw new Error("Invalid OAuth state");
      }

      const session = await loadSession(parts[0]);
      if (session.state !== parts[1]) {
        throw new Error("OAuth state mismatch");
      }

      if (oauthError) {
        await updateSession(session.sessionId, (current) => {
          current.status = "error";
          current.error = oauthError;
          return current;
        });

        html(
          res,
          400,
          renderOauthDonePage("error", "Google sign-in failed", "You can return to Figma and try again.")
        );
        return;
      }

      const tokenData = await exchangeCodeForToken(code, req);
      const email = await fetchUserEmail(tokenData.access_token);
      assertAllowedEmail(email);

      await updateSession(session.sessionId, (current) => {
        current.status = "authorized";
        current.accessToken = tokenData.access_token;
        current.refreshToken = tokenData.refresh_token || current.refreshToken || "";
        current.expiresAt = Date.now() + Number(tokenData.expires_in || 3600) * 1000;
        current.email = email;
        current.error = "";
        return current;
      });

      html(
        res,
        200,
        renderOauthDonePage("success", "Google sign-in complete", "You can return to Figma and continue.")
      );
      return;
    }

    if (url.pathname === "/api/locale" && req.method === "GET") {
      const sessionId = url.searchParams.get("sessionId") || "";
      const spreadsheetId = url.searchParams.get("spreadsheetId") || "";
      const sheetName = url.searchParams.get("sheetName") || "";

      if (!sessionId || !spreadsheetId || !sheetName) {
        json(res, 400, { error: "sessionId, spreadsheetId, and sheetName are required" });
        return;
      }

      const session = await loadSession(sessionId);
      if (session.status !== "authorized") {
        json(res, 401, { error: "Session is not authorized" });
        return;
      }

      const accessToken = await ensureAccessToken(session);
      const rows = await fetchSheetValues(accessToken, spreadsheetId, sheetName);
      const dataset = parseLocaleRows(rows);
      json(res, 200, dataset);
      return;
    }

    json(res, 404, { error: "Not found" });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    json(res, statusCode, { error: error.message || "Server error" });
  }
}

const isDirectRun =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectRun) {
  createServer(handleNodeRequest).listen(PORT, () => {
    const baseUrl = BASE_URL || `http://localhost:${PORT}`;
    console.log(`Locale auth bridge running at ${baseUrl}`);
  });
}
