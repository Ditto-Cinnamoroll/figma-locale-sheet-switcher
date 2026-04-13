const SETTINGS_KEY = 'locale-sheet-switcher-settings-v3';
const DEFAULT_SPREADSHEET_URL = '';

const DEFAULT_SETTINGS = {
  bridgeUrl: '',
  spreadsheetUrl: DEFAULT_SPREADSHEET_URL,
  spreadsheetId: '',
  sheetName: '',
  authSessionId: '',
  authEmail: ''
};

figma.showUI(__html__, { width: 460, height: 760 });

safeStartup();

figma.on('selectionchange', () => {
  try {
    postSelectionSummary();
  } catch (error) {
    postResult(false, error && error.message ? error.message : 'Selection refresh failed.');
  }
});

figma.ui.onmessage = async (msg) => {
  try {
    if (msg.type === 'inspect-selection') {
      postSelectionSummary();
      return;
    }

    if (msg.type === 'start-sign-in') {
      const settings = await mergeUiSettings(msg.payload);
      const result = await startBridgeAuth(settings);
      figma.ui.postMessage({ type: 'auth-pending', payload: result });
      return;
    }

    if (msg.type === 'check-auth-status') {
      const settings = await mergeUiSettings(msg.payload);
      const result = await checkBridgeAuthStatus(settings, msg.payload && msg.payload.authSessionId);
      figma.ui.postMessage({ type: 'auth-status', payload: result });
      return;
    }

    if (msg.type === 'sign-out') {
      const settings = await loadSettings();
      settings.authSessionId = '';
      settings.authEmail = '';
      await saveSettings(settings);
      figma.ui.postMessage({
        type: 'auth-cleared',
        payload: buildUiSettings(settings)
      });
      return;
    }

    if (msg.type === 'load-locale-data') {
      const settings = await mergeUiSettings(msg.payload);
      const result = await fetchLocaleDataset(settings);
      figma.ui.postMessage({ type: 'locale-data', payload: result });
      return;
    }

    if (msg.type === 'apply-locale') {
      const result = await applyLocalePayload(msg.payload);
      figma.ui.postMessage({ type: 'result', payload: result });
      postSelectionSummary();
      return;
    }
  } catch (error) {
    postResult(false, error && error.message ? error.message : 'Unknown error');
  }
};

async function safeStartup() {
  try {
    const settings = await loadSettings();
    figma.ui.postMessage({
      type: 'init',
      payload: {
        settings: buildUiSettings(settings)
      }
    });
    postSelectionSummary();
  } catch (error) {
    postResult(false, error && error.message ? error.message : 'Plugin startup failed.');
  }
}

function buildUiSettings(settings) {
  return {
    bridgeUrl: settings.bridgeUrl || '',
    spreadsheetUrl: settings.spreadsheetUrl || DEFAULT_SPREADSHEET_URL,
    spreadsheetId: settings.spreadsheetId || '',
    sheetName: settings.sheetName || '',
    authSessionId: settings.authSessionId || '',
    authEmail: settings.authEmail || ''
  };
}

function postResult(ok, message) {
  figma.ui.postMessage({
    type: 'result',
    payload: { ok: ok, message: message }
  });
}

function postSelectionSummary() {
  const roots = getSelectedRoots(figma.currentPage.selection);
  const textNodes = collectTextNodes(roots).filter(isNodeActuallyVisible);
  const namedTextNodes = textNodes.filter((node) => normalizeMsgId(node.name));

  figma.ui.postMessage({
    type: 'selection-summary',
    payload: {
      selectedCount: roots.length,
      textCount: textNodes.length,
      namedTextCount: namedTextNodes.length
    }
  });
}

function getSelectedRoots(selection) {
  return selection.filter((node) => node.removed !== true);
}

function collectTextNodes(roots) {
  const results = [];
  const seen = {};

  for (let i = 0; i < roots.length; i += 1) {
    const root = roots[i];

    if (root.type === 'TEXT' && !seen[root.id]) {
      results.push(root);
      seen[root.id] = true;
    }

    if ('findAll' in root) {
      const descendants = root.findAll((node) => node.type === 'TEXT');
      for (let j = 0; j < descendants.length; j += 1) {
        const node = descendants[j];
        if (seen[node.id]) continue;
        results.push(node);
        seen[node.id] = true;
      }
    }
  }

  return results;
}

function isNodeActuallyVisible(node) {
  let current = node;
  while (current) {
    if ('visible' in current && current.visible === false) {
      return false;
    }
    current = current.parent;
  }
  return true;
}

function normalizeMsgId(value) {
  return typeof value === 'string' ? value.trim() : '';
}

async function loadSettings() {
  const saved = await figma.clientStorage.getAsync(SETTINGS_KEY);
  return deepMerge(DEFAULT_SETTINGS, saved || {});
}

async function saveSettings(settings) {
  await figma.clientStorage.setAsync(SETTINGS_KEY, settings);
}

async function mergeUiSettings(payload) {
  const current = await loadSettings();
  const next = deepMerge(current, sanitizeIncomingSettings(payload || {}));
  await saveSettings(next);
  return next;
}

function sanitizeIncomingSettings(payload) {
  const output = {};
  if (payload.bridgeUrl) output.bridgeUrl = String(payload.bridgeUrl).trim();
  if (payload.spreadsheetUrl) {
    output.spreadsheetUrl = String(payload.spreadsheetUrl).trim();
    output.spreadsheetId = extractSpreadsheetId(output.spreadsheetUrl);
  }
  if (payload.spreadsheetId) output.spreadsheetId = String(payload.spreadsheetId).trim();
  if (payload.sheetName) output.sheetName = String(payload.sheetName).trim();
  if (payload.authSessionId) output.authSessionId = String(payload.authSessionId).trim();
  if (payload.authEmail) output.authEmail = String(payload.authEmail).trim();
  return output;
}

function extractSpreadsheetId(value) {
  const text = String(value || '').trim();
  const match = text.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (match && match[1]) return match[1];
  return text;
}

function deepMerge(base, extra) {
  const output = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  const entries = Object.entries(extra || {});

  for (let i = 0; i < entries.length; i += 1) {
    const key = entries[i][0];
    const value = entries[i][1];
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      output[key] &&
      typeof output[key] === 'object' &&
      !Array.isArray(output[key])
    ) {
      output[key] = deepMerge(output[key], value);
    } else {
      output[key] = value;
    }
  }

  return output;
}

async function startBridgeAuth(settings) {
  if (!settings.bridgeUrl) {
    throw new Error('Enter the Auth Server URL first.');
  }

  const startUrl = `${stripTrailingSlash(settings.bridgeUrl)}/api/auth/start`;
  const response = await fetch(startUrl, { method: 'POST' });
  const text = await response.text();
  const data = safeJsonParse(text);
  if (!response.ok || !data || !data.sessionId || !data.authUrl) {
    throw new Error(`Auth bridge start failed (${response.status}): ${text}`);
  }

  figma.openExternal(data.authUrl);

  const next = await loadSettings();
  next.bridgeUrl = settings.bridgeUrl;
  next.authSessionId = data.sessionId;
  next.authEmail = '';
  await saveSettings(next);

  return {
    authUrl: data.authUrl,
    authSessionId: data.sessionId
  };
}

async function checkBridgeAuthStatus(settings, requestedSessionId) {
  const sessionId = requestedSessionId || settings.authSessionId;
  if (!settings.bridgeUrl || !sessionId) {
    throw new Error('Missing sign-in session information.');
  }

  const statusUrl =
    `${stripTrailingSlash(settings.bridgeUrl)}/api/auth/session/` +
    encodeURIComponent(sessionId);
  const response = await fetch(statusUrl);
  const text = await response.text();
  const data = safeJsonParse(text);

  if (!response.ok || !data || !data.status) {
    throw new Error(`Auth status check failed (${response.status}): ${text}`);
  }

  if (data.status === 'authorized') {
    const next = await loadSettings();
    next.bridgeUrl = settings.bridgeUrl;
    next.authSessionId = sessionId;
    next.authEmail = data.email || '';
    await saveSettings(next);
  }

  return {
    status: data.status,
    email: data.email || '',
    authSessionId: sessionId,
    error: data.error || ''
  };
}

async function fetchLocaleDataset(settings) {
  if (!settings.bridgeUrl) {
    throw new Error('Enter the Auth Server URL first.');
  }
  if (!settings.spreadsheetId || !settings.sheetName) {
    throw new Error('Enter the spreadsheet and sheet name first.');
  }
  if (!settings.authSessionId) {
    throw new Error('Sign in first.');
  }

  const url =
    `${stripTrailingSlash(settings.bridgeUrl)}/api/locale?sessionId=${encodeURIComponent(settings.authSessionId)}` +
    `&spreadsheetId=${encodeURIComponent(settings.spreadsheetId)}` +
    `&sheetName=${encodeURIComponent(settings.sheetName)}`;

  const response = await fetch(url);
  const text = await response.text();
  const data = safeJsonParse(text);
  if (!response.ok) {
    throw new Error(`Locale API error (${response.status}): ${text}`);
  }

  const dataset = normalizeLocaleDataset(data);
  return {
    ok: true,
    dataset: dataset,
    sourceLabel: `${settings.sheetName} / ${settings.spreadsheetId}`
  };
}

function stripTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function normalizeLocaleDataset(data) {
  if (!data || typeof data !== 'object') {
    throw new Error('Locale API response is empty or not valid JSON.');
  }

  if (Array.isArray(data.languages) && data.records && typeof data.records === 'object') {
    return normalizeDatasetShape(data);
  }

  if (data.data && Array.isArray(data.data.languages) && data.data.records) {
    return normalizeDatasetShape(data.data);
  }

  if (data.records && typeof data.records === 'object') {
    return inferLanguagesFromRecords(data.records);
  }

  throw new Error(
    'Locale API response shape is invalid. Expected { languages: [], records: {} }.'
  );
}

function normalizeDatasetShape(dataset) {
  const languages = [];
  for (let i = 0; i < dataset.languages.length; i += 1) {
    const value = String(dataset.languages[i] || '').trim();
    if (value) languages.push(value);
  }

  const records = normalizeRecords(dataset.records);
  return {
    languages: languages.length > 0 ? languages : inferLanguages(records),
    records: records
  };
}

function inferLanguagesFromRecords(recordsInput) {
  const records = normalizeRecords(recordsInput);
  return {
    languages: inferLanguages(records),
    records: records
  };
}

function inferLanguages(records) {
  const map = {};
  const entries = Object.entries(records || {});
  for (let i = 0; i < entries.length; i += 1) {
    const localeEntries = Object.keys(entries[i][1].locales || {});
    for (let j = 0; j < localeEntries.length; j += 1) {
      map[localeEntries[j]] = true;
    }
  }
  return Object.keys(map);
}

function normalizeRecords(recordsInput) {
  const records = {};
  const entries = Object.entries(recordsInput || {});

  for (let i = 0; i < entries.length; i += 1) {
    const msgId = String(entries[i][0] || '').trim();
    const record = entries[i][1];
    if (!msgId || !record || typeof record !== 'object') continue;

    const rawLocales =
      record.locales && typeof record.locales === 'object' ? record.locales : record;
    const locales = {};
    const localeEntries = Object.entries(rawLocales);

    for (let j = 0; j < localeEntries.length; j += 1) {
      const language = String(localeEntries[j][0] || '').trim();
      if (!language) continue;
      const normalized = normalizeLocaleEntryPayload(localeEntries[j][1]);
      if (normalized.text) locales[language] = normalized;
    }

    if (Object.keys(locales).length > 0) {
      records[msgId] = { locales: locales };
    }
  }

  return records;
}

function normalizeLocaleEntryPayload(value) {
  if (typeof value === 'string') {
    return parseLocalizedHtml(value);
  }
  if (!value || typeof value !== 'object') {
    return { text: '', links: [], visibleLength: 0 };
  }
  if (typeof value.html === 'string') {
    return parseLocalizedHtml(value.html);
  }
  if (typeof value.text === 'string') {
    return {
      text: value.text,
      links: Array.isArray(value.links) ? value.links : [],
      visibleLength:
        typeof value.visibleLength === 'number' ? value.visibleLength : value.text.length
    };
  }
  return { text: '', links: [], visibleLength: 0 };
}

function parseLocalizedHtml(html) {
  const links = [];
  let outputText = '';
  let cursor = 0;

  while (cursor < html.length) {
    const openMatch = html.slice(cursor).match(/<a\b([^>]*)>/i);
    if (!openMatch || openMatch.index == null) {
      outputText += decodeHtmlEntities(stripTags(html.slice(cursor)));
      break;
    }

    const openStart = cursor + openMatch.index;
    const openEnd = openStart + openMatch[0].length;
    outputText += decodeHtmlEntities(stripTags(html.slice(cursor, openStart)));

    const closeIndex = html.toLowerCase().indexOf('</a>', openEnd);
    if (closeIndex < 0) {
      outputText += decodeHtmlEntities(stripTags(html.slice(openStart)));
      break;
    }

    const hrefMatch =
      openMatch[1].match(/href\s*=\s*"([^"]+)"/i) ||
      openMatch[1].match(/href\s*=\s*'([^']+)'/i);
    const linkText = decodeHtmlEntities(stripTags(html.slice(openEnd, closeIndex)));
    const start = outputText.length;
    outputText += linkText;
    const end = outputText.length;

    if (hrefMatch && hrefMatch[1] && end > start) {
      links.push({ start: start, end: end, url: hrefMatch[1] });
    }

    cursor = closeIndex + 4;
  }

  const collapsed = collapseWhitespaceWithLinks(outputText, links);
  return {
    text: collapsed.text,
    links: collapsed.links,
    visibleLength: collapsed.text.length
  };
}

function stripTags(value) {
  return String(value).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
}

function decodeHtmlEntities(value) {
  return String(value)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&ldquo;/gi, '"')
    .replace(/&rdquo;/gi, '"')
    .replace(/&lsquo;/gi, "'")
    .replace(/&rsquo;/gi, "'")
    .replace(/&ndash;/gi, '-')
    .replace(/&mdash;/gi, '-')
    .replace(/&#(\d+);/g, function (_match, code) {
      try {
        return String.fromCharCode(Number(code));
      } catch (_error) {
        return '';
      }
    })
    .replace(/&#x([0-9a-f]+);/gi, function (_match, hex) {
      try {
        return String.fromCharCode(parseInt(hex, 16));
      } catch (_error) {
        return '';
      }
    });
}

function collapseWhitespaceWithLinks(text, links) {
  let result = '';
  const adjustedLinks = [];
  let sourceIndex = 0;
  let targetIndex = 0;
  let pendingSpace = false;

  while (sourceIndex < text.length) {
    const char = text[sourceIndex];
    const isWhitespace = /\s/.test(char);

    if (isWhitespace) {
      pendingSpace = result.length > 0;
      sourceIndex += 1;
      continue;
    }

    if (pendingSpace && result.length > 0) {
      result += ' ';
      targetIndex += 1;
      pendingSpace = false;
    }

    const mappedIndex = targetIndex;
    result += char;
    targetIndex += 1;

    for (let i = 0; i < links.length; i += 1) {
      const link = links[i];
      if (link.start === sourceIndex) link._mappedStart = mappedIndex;
      if (link.end === sourceIndex + 1) link._mappedEnd = targetIndex;
    }

    sourceIndex += 1;
  }

  for (let i = 0; i < links.length; i += 1) {
    const link = links[i];
    const start = typeof link._mappedStart === 'number' ? link._mappedStart : 0;
    const end =
      typeof link._mappedEnd === 'number'
        ? link._mappedEnd
        : Math.min(result.length, Math.max(start, result.length));
    if (end > start) adjustedLinks.push({ start: start, end: end, url: link.url });
  }

  const trimLeft = countTrimmedLeft(result);
  const trimmedText = result.trim();

  return {
    text: trimmedText,
    links: adjustedLinks
      .map(function (link) {
        return {
          start: Math.max(0, link.start - trimLeft),
          end: Math.max(0, link.end - trimLeft),
          url: link.url
        };
      })
      .filter(function (link) {
        return link.end > link.start;
      })
  };
}

function countTrimmedLeft(value) {
  const match = String(value).match(/^\s*/);
  return match ? match[0].length : 0;
}

async function applyLocalePayload(payload) {
  const roots = getSelectedRoots(figma.currentPage.selection);
  if (roots.length === 0) {
    return { ok: false, message: 'Select at least one frame, group, or text layer.' };
  }

  if (!payload || !payload.records || typeof payload.records !== 'object') {
    return { ok: false, message: 'Load locale data first.' };
  }

  const textNodes = collectTextNodes(roots).filter(isNodeActuallyVisible);
  if (textNodes.length === 0) {
    return { ok: false, message: 'No text layers were found in the current selection.' };
  }

  const mode = payload.mode === 'longest' ? 'longest' : 'language';
  const language = payload.language || '';
  const records = payload.records;
  let updated = 0;
  let missing = 0;
  let skipped = 0;
  const missingIds = [];

  for (let i = 0; i < textNodes.length; i += 1) {
    const node = textNodes[i];
    const msgId = normalizeMsgId(node.name);
    if (!msgId) {
      skipped += 1;
      continue;
    }

    const record = records[msgId];
    if (!record || !record.locales) {
      missing += 1;
      if (missingIds.length < 10) missingIds.push(msgId);
      continue;
    }

    const localePayload =
      mode === 'longest'
        ? getLongestLocaleEntry(record.locales)
        : getLanguageLocaleEntry(record.locales, language);

    if (!localePayload || !localePayload.text) {
      missing += 1;
      if (missingIds.length < 10) missingIds.push(msgId);
      continue;
    }

    await replaceTextNodeContent(node, localePayload);
    updated += 1;
  }

  const modeLabel = mode === 'longest' ? 'Longest translation' : language || 'Selected language';
  const missingMessage =
    missingIds.length > 0 ? ` Missing examples: ${missingIds.join(', ')}` : '';

  return {
    ok: updated > 0,
    message:
      `Updated ${updated} text layers using ${modeLabel}.` +
      (missing ? ` Could not find translations for ${missing}.${missingMessage}` : '') +
      (skipped ? ` Skipped ${skipped} layers with no msg-id layer name.` : '')
  };
}

function getLanguageLocaleEntry(locales, language) {
  if (!language || !locales[language]) return null;
  return locales[language];
}

function getLongestLocaleEntry(locales) {
  let best = null;
  const entries = Object.entries(locales || {});
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i][1];
    if (!entry || !entry.text) continue;
    if (!best || entry.visibleLength > best.visibleLength) best = entry;
  }
  return best;
}

async function replaceTextNodeContent(node, localePayload) {
  await loadFontsForNode(node);
  const baseStyle = captureBaseStyle(node);
  node.characters = localePayload.text;
  await applyBaseStyle(node, baseStyle);
  clearHyperlinks(node);
  applyHyperlinks(node, localePayload.links);
}

async function loadFontsForNode(node) {
  const fonts = {};
  const totalLength = node.characters.length;

  if (totalLength === 0) {
    const fontName = node.fontName === figma.mixed ? null : node.fontName;
    if (fontName && fontName !== figma.mixed) fonts[fontKey(fontName)] = fontName;
  } else {
    const segments = node.getStyledTextSegments(['fontName'], 0, totalLength);
    for (let i = 0; i < segments.length; i += 1) {
      const fontName = segments[i].fontName;
      if (fontName && fontName !== figma.mixed) fonts[fontKey(fontName)] = fontName;
    }
  }

  const keys = Object.keys(fonts);
  if (keys.length === 0) {
    const probe = figma.createText();
    const fallback = probe.fontName;
    probe.remove();
    if (fallback && fallback !== figma.mixed) fonts[fontKey(fallback)] = fallback;
  }

  const finalKeys = Object.keys(fonts);
  for (let i = 0; i < finalKeys.length; i += 1) {
    await figma.loadFontAsync(fonts[finalKeys[i]]);
  }
}

function fontKey(fontName) {
  return `${fontName.family}__${fontName.style}`;
}

function captureBaseStyle(node) {
  const length = node.characters.length;
  const segments =
    length > 0
      ? node.getStyledTextSegments(
          [
            'fontName',
            'fontSize',
            'fills',
            'textStyleId',
            'fillStyleId',
            'textCase',
            'textDecoration',
            'letterSpacing',
            'lineHeight'
          ],
          0,
          length
        )
      : [];
  const first = segments[0];

  return {
    fontName: first && first.fontName ? first.fontName : node.fontName,
    fontSize: first && first.fontSize !== undefined ? first.fontSize : node.fontSize,
    fills: clonePaintArray(first && first.fills ? first.fills : node.fills),
    textStyleId: first && first.textStyleId !== undefined ? first.textStyleId : node.textStyleId,
    fillStyleId: first && first.fillStyleId !== undefined ? first.fillStyleId : node.fillStyleId,
    textCase: first && first.textCase !== undefined ? first.textCase : node.textCase,
    textDecoration:
      first && first.textDecoration !== undefined ? first.textDecoration : node.textDecoration,
    letterSpacing:
      first && first.letterSpacing !== undefined
        ? cloneValue(first.letterSpacing)
        : cloneValue(node.letterSpacing),
    lineHeight:
      first && first.lineHeight !== undefined
        ? cloneValue(first.lineHeight)
        : cloneValue(node.lineHeight)
  };
}

async function applyBaseStyle(node, style) {
  const end = node.characters.length;
  if (end === 0) return;

  if (style.fontName && style.fontName !== figma.mixed) node.fontName = style.fontName;
  if (typeof style.fontSize === 'number') node.fontSize = style.fontSize;
  if (style.textCase && style.textCase !== figma.mixed) node.textCase = style.textCase;
  if (style.textDecoration && style.textDecoration !== figma.mixed) {
    node.textDecoration = style.textDecoration;
  }
  if (style.letterSpacing && style.letterSpacing !== figma.mixed) {
    node.letterSpacing = style.letterSpacing;
  }
  if (style.lineHeight && style.lineHeight !== figma.mixed) {
    node.lineHeight = style.lineHeight;
  }
  if (Array.isArray(style.fills)) node.fills = style.fills;
  if (style.fillStyleId && style.fillStyleId !== figma.mixed) node.fillStyleId = style.fillStyleId;
  if (style.textStyleId && style.textStyleId !== figma.mixed) {
    await node.setRangeTextStyleIdAsync(0, end, style.textStyleId);
  }
}

function clearHyperlinks(node) {
  if (node.characters.length === 0) return;
  node.setRangeHyperlink(0, node.characters.length, null);
}

function applyHyperlinks(node, links) {
  if (!Array.isArray(links)) return;
  for (let i = 0; i < links.length; i += 1) {
    const link = links[i];
    if (!link || typeof link.start !== 'number' || typeof link.end !== 'number') continue;
    if (!link.url || link.start >= link.end) continue;
    const safeStart = Math.max(0, Math.min(node.characters.length, link.start));
    const safeEnd = Math.max(0, Math.min(node.characters.length, link.end));
    if (safeStart >= safeEnd) continue;
    node.setRangeHyperlink(safeStart, safeEnd, { type: 'URL', value: link.url });
  }
}

function clonePaintArray(value) {
  if (!Array.isArray(value)) return value;
  const next = [];
  for (let i = 0; i < value.length; i += 1) next.push(cloneValue(value[i]));
  return next;
}

function cloneValue(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch (_error) {
    return null;
  }
}
