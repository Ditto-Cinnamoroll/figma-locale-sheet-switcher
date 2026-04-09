import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT || 4180);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `${BASE_URL}/oauth/google/callback`;
const ALLOWED_EMAIL_DOMAIN = process.env.ALLOWED_EMAIL_DOMAIN || "";

const sessions = new Map();

function json(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  });
  res.end(JSON.stringify(payload));
}

function html(res, status, content) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(content);
}

function parseUrl(req) {
  return new URL(req.url || "/", BASE_URL);
}

function ensureConfig() {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required");
  }
}

function createSession() {
  const sessionId = randomUUID();
  const state = randomUUID();
  const session = {
    sessionId,
    state,
    status: "pending",
    createdAt: Date.now(),
    accessToken: "",
    refreshToken: "",
    expiresAt: 0,
    email: "",
    error: ""
  };
  sessions.set(sessionId, session);
  return session;
}

function getSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) {
    const error = new Error("Session not found");
    error.statusCode = 404;
    throw error;
  }
  return session;
}

function authUrlForSession(session) {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
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

async function exchangeCodeForToken(code) {
  const body = new URLSearchParams({
    code,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    redirect_uri: GOOGLE_REDIRECT_URI,
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
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const text = await response.text();
  const data = safeJsonParse(text);

  if (!response.ok) {
    throw new Error(`Sheets API failed (${response.status}): ${text}`);
  }

  return Array.isArray(data.values) ? data.values : [];
}

function normalizeCell(value) {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
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

function findMsgIdColumnIndex(headerRow, rows) {
  const directIndex = headerRow.findIndex((cell) => normalizeCell(cell).toLowerCase() === "msg-id");
  if (directIndex >= 0) return directIndex;
  const firstDataRow = rows[1] || [];
  return firstDataRow.findIndex((cell) => normalizeCell(cell).toLowerCase() === "msg-id");
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch (_error) {
    return null;
  }
}

createServer(async (req, res) => {
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
      json(res, 200, { ok: true });
      return;
    }

    if (url.pathname === "/api/auth/start" && req.method === "POST") {
      ensureConfig();
      const session = createSession();
      json(res, 200, {
        sessionId: session.sessionId,
        authUrl: authUrlForSession(session)
      });
      return;
    }

    if (url.pathname.startsWith("/api/auth/session/") && req.method === "GET") {
      const sessionId = decodeURIComponent(url.pathname.split("/").pop() || "");
      const session = getSession(sessionId);
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
      const error = url.searchParams.get("error") || "";

      const parts = state.split(":");
      if (parts.length !== 2) {
        throw new Error("Invalid OAuth state");
      }

      const session = getSession(parts[0]);
      if (session.state !== parts[1]) {
        throw new Error("OAuth state mismatch");
      }

      if (error) {
        session.status = "error";
        session.error = error;
        html(res, 400, "<h1>Google login failed</h1><p>You can return to Figma.</p>");
        return;
      }

      const tokenData = await exchangeCodeForToken(code);
      const email = await fetchUserEmail(tokenData.access_token);
      assertAllowedEmail(email);

      session.status = "authorized";
      session.accessToken = tokenData.access_token;
      session.refreshToken = tokenData.refresh_token || session.refreshToken || "";
      session.expiresAt = Date.now() + Number(tokenData.expires_in || 3600) * 1000;
      session.email = email;
      session.error = "";

      html(
        res,
        200,
        "<h1>Google login complete</h1><p>You can return to Figma and continue.</p>"
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

      const session = getSession(sessionId);
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
}).listen(PORT, () => {
  console.log(`Locale auth bridge running at ${BASE_URL}`);
});
