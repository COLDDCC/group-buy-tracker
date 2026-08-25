// Shared helpers used by both popup.js and background.js (loaded via <script> in the
// popup and via importScripts() in the service worker).

// Parses a comma-separated "YYYY-MM-DD,YYYY-MM-DD" list from the options page into a
// Set of date strings, so isWeekendOrHoliday() can treat manually-listed public
// holidays the same as Sat/Sun.
function parseHolidayList(raw) {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

function toDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Weekend/holiday pricing at 骏河屋 is inferred from *when* the item was scraped, not
// read directly off the page (the page only ever shows one "current" price). Sat/Sun
// count automatically; extra public holidays can be added in the options page.
function isWeekendOrHoliday(date, holidaySet) {
  const day = date.getDay(); // 0 = Sunday, 6 = Saturday
  if (day === 0 || day === 6) return true;
  return holidaySet.has(toDateKey(date));
}

// Extracts a plain number from strings like "¥199.00" / "券后价 99" / "99.9元".
function extractPriceNumber(text) {
  if (text == null) return null;
  const match = String(text).match(/(\d+(?:\.\d{1,2})?)/);
  if (!match) return null;
  const n = parseFloat(match[1]);
  return Number.isFinite(n) ? n : null;
}

// Feishu 电子表格 links come in two shapes:
//   - embedded in a Wiki (知识库): https://xxx.feishu.cn/wiki/<node_token>?sheet=<sheetId>
//     the node_token is NOT the spreadsheetToken — it has to be resolved via the wiki API.
//   - a standalone spreadsheet: https://xxx.feishu.cn/sheets/<spreadsheetToken>?sheet=<sheetId>
//     the token in the path IS already the spreadsheetToken.
function parseSheetUrl(urlStr) {
  let u;
  try {
    u = new URL(urlStr);
  } catch (e) {
    return null;
  }
  const sheetId = u.searchParams.get("sheet") || "";
  const wikiMatch = u.pathname.match(/\/wiki\/([^/?]+)/);
  const sheetsMatch = u.pathname.match(/\/sheets\/([^/?]+)/);
  if (wikiMatch) return { type: "wiki", token: wikiMatch[1], sheetId };
  if (sheetsMatch) return { type: "sheets", token: sheetsMatch[1], sheetId };
  return null;
}

// Many product-page URLs carry per-visit tracking params (utm_*, spm, _t, share ids...)
// that change every time you open the same link. Left alone, that breaks the "same
// product link -> same row" matching in background.js: re-scraping an item you already
// recorded would silently create a duplicate row instead of updating it. Strip the
// common tracking keys (but leave everything else, since some sites put the real item
// id in the query string) so the same product normalizes to the same link.
const TRACKING_PARAM_NAMES = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "spm",
  "scm",
  "_t",
  "timestamp",
  "share_id",
  "shareId",
  "share_from",
  "request_id",
  "requestId",
  "trace_id",
  "traceId",
  "from",
];

function normalizeLink(urlStr) {
  if (!urlStr) return urlStr;
  let u;
  try {
    u = new URL(urlStr);
  } catch (e) {
    return urlStr;
  }
  for (const key of TRACKING_PARAM_NAMES) u.searchParams.delete(key);
  return u.toString();
}

if (typeof module !== "undefined") {
  module.exports = {
    parseHolidayList,
    toDateKey,
    isWeekendOrHoliday,
    extractPriceNumber,
    parseSheetUrl,
    normalizeLink,
  };
}
