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

// Weekend/holiday pricing at 菌核屋 is inferred from *when* the item was scraped, not
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

// Turns a 0-based column index into a spreadsheet column letter (0 -> "A", 26 -> "AA").
function indexToColumnLetter(index) {
  let letters = "";
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

// Turns a spreadsheet column letter into a 0-based index ("A" -> 0, "AA" -> 26).
function columnLetterToIndex(letters) {
  let n = 0;
  for (const ch of String(letters).toUpperCase()) {
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n - 1;
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

if (typeof module !== "undefined") {
  module.exports = {
    parseHolidayList,
    toDateKey,
    isWeekendOrHoliday,
    extractPriceNumber,
    indexToColumnLetter,
    columnLetterToIndex,
    parseSheetUrl,
  };
}
