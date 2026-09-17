// Shared helpers used by both popup.js and background.js (loaded via <script> in the
// popup and via importScripts() in the service worker).

// Extracts a plain number from strings like "¥199.00" / "券后价 99" / "99.9元".
function extractPriceNumber(text) {
  if (text == null) return null;
  const match = String(text).match(/(\d+(?:\.\d{1,2})?)/);
  if (!match) return null;
  const n = parseFloat(match[1]);
  return Number.isFinite(n) ? n : null;
}

// Feishu links come in four shapes, for two different products (电子表格 Sheets vs.
// 多维表格 Bitable) that each also come in a "standalone" and a "embedded in a Wiki"
// flavor:
//   - sheets, standalone:      https://xxx.feishu.cn/sheets/<spreadsheetToken>?sheet=<sheetId>
//   - sheets, embedded in wiki: https://xxx.feishu.cn/wiki/<node_token>?sheet=<sheetId>
//   - bitable, standalone:     https://xxx.feishu.cn/base/<appToken>?table=<tableId>&view=...
//   - bitable, embedded in wiki: https://xxx.feishu.cn/wiki/<node_token>?table=<tableId>&view=...
// A wiki node_token is NOT the underlying spreadsheetToken/appToken — it has to be
// resolved via the wiki API (see resolveObjToken in background.js). The product for a
// wiki link is told apart by which query param is present (?sheet= vs ?table=), since
// the /wiki/ path alone doesn't say which product is behind it.
function parseSheetUrl(urlStr) {
  let u;
  try {
    u = new URL(urlStr);
  } catch (e) {
    return null;
  }
  const sheetId = u.searchParams.get("sheet") || "";
  const tableId = u.searchParams.get("table") || "";
  const wikiMatch = u.pathname.match(/\/wiki\/([^/?]+)/);
  const sheetsMatch = u.pathname.match(/\/sheets\/([^/?]+)/);
  const baseMatch = u.pathname.match(/\/base\/([^/?]+)/);

  if (baseMatch) return { product: "bitable", isWiki: false, token: baseMatch[1], tableId };
  if (wikiMatch) {
    return tableId
      ? { product: "bitable", isWiki: true, token: wikiMatch[1], tableId }
      : { product: "sheets", isWiki: true, token: wikiMatch[1], sheetId };
  }
  if (sheetsMatch) return { product: "sheets", isWiki: false, token: sheetsMatch[1], sheetId };
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
    extractPriceNumber,
    parseSheetUrl,
    normalizeLink,
  };
}
