importScripts("utils.js");

const FEISHU_HOST = "https://open.feishu.cn";
const COLUMN_COUNT = 5; // 商品名称, 商品图片链接, 商品链接, 平时价, 周末价 (in that order)
const LINK_OFFSET = 2; // 商品链接 is the 3rd of the 5 columns

async function getSettings() {
  const stored = await chrome.storage.sync.get([
    "appId",
    "appSecret",
    "sheetUrl",
    "colStart",
    "headerRow",
  ]);
  return {
    colStart: "A",
    headerRow: 1,
    ...stored,
  };
}

// tenant_access_token is valid for ~2h; cache it in memory (service worker can be
// evicted between uses, that's fine — a cache miss just re-fetches).
let tokenCache = { token: null, expiresAt: 0 };

async function getTenantAccessToken(appId, appSecret) {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) return tokenCache.token;

  const resp = await fetch(`${FEISHU_HOST}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const data = await resp.json();
  if (data.code !== 0) {
    throw new Error(`获取飞书 token 失败：${data.msg || data.code}`);
  }
  tokenCache = { token: data.tenant_access_token, expiresAt: Date.now() + (data.expire - 60) * 1000 };
  return tokenCache.token;
}

// A Wiki node token isn't a spreadsheetToken — resolve it once via the wiki API and
// cache the mapping locally (it never changes for a given doc).
async function resolveSpreadsheetToken(token, parsed) {
  if (parsed.type === "sheets") return parsed.token;

  const cacheKey = `wikiToken:${parsed.token}`;
  const cached = await chrome.storage.local.get(cacheKey);
  if (cached[cacheKey]) return cached[cacheKey];

  const resp = await fetch(
    `${FEISHU_HOST}/open-apis/wiki/v2/spaces/get_node?token=${encodeURIComponent(parsed.token)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await resp.json();
  if (data.code !== 0) throw new Error(`解析知识库链接失败：${data.msg || data.code}`);
  const node = data.data && data.data.node;
  if (!node || !node.obj_token) throw new Error("知识库链接解析结果里没有找到表格");
  if (node.obj_type && node.obj_type !== "sheet") {
    throw new Error(`这个知识库节点不是电子表格（类型是 ${node.obj_type}），请确认链接是否正确`);
  }
  await chrome.storage.local.set({ [cacheKey]: node.obj_token });
  return node.obj_token;
}

function sheetsUrl(spreadsheetToken, suffix) {
  return `${FEISHU_HOST}/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}${suffix}`;
}

async function getSheetMeta(token, spreadsheetToken) {
  const resp = await fetch(sheetsUrl(spreadsheetToken, "/metainfo"), {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await resp.json();
  if (data.code !== 0) throw new Error(`读取表格信息失败：${data.msg || data.code}`);
  return (data.data && data.data.sheets) || [];
}

async function readRange(token, spreadsheetToken, range) {
  const resp = await fetch(sheetsUrl(spreadsheetToken, `/values/${encodeURIComponent(range)}`), {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await resp.json();
  if (data.code !== 0) throw new Error(`读取表格内容失败：${data.msg || data.code}`);
  return (data.data && data.data.valueRange && data.data.valueRange.values) || [];
}

async function appendRow(token, spreadsheetToken, range, row) {
  const resp = await fetch(sheetsUrl(spreadsheetToken, "/values_append?insertDataOption=INSERT_ROWS"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ valueRange: { range, values: [row] } }),
  });
  const data = await resp.json();
  if (data.code !== 0) throw new Error(`新增行失败：${data.msg || data.code}`);
}

async function writeRange(token, spreadsheetToken, range, row) {
  const resp = await fetch(sheetsUrl(spreadsheetToken, "/values"), {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ valueRange: { range, values: [row] } }),
  });
  const data = await resp.json();
  if (data.code !== 0) throw new Error(`更新行失败：${data.msg || data.code}`);
}

async function prepareSheetContext() {
  const settings = await getSettings();
  const { appId, appSecret, sheetUrl } = settings;
  if (!appId || !appSecret || !sheetUrl) {
    throw new Error("请先在插件设置里填好飞书 App ID / App Secret / 表格链接");
  }
  const parsed = parseSheetUrl(sheetUrl);
  if (!parsed) throw new Error("表格链接格式无法识别，请重新从浏览器地址栏复制完整链接");
  if (!parsed.sheetId) throw new Error("链接里没有 ?sheet=xxx 参数，请确认复制的是分表标签页的完整链接");

  const token = await getTenantAccessToken(appId, appSecret);
  const spreadsheetToken = await resolveSpreadsheetToken(token, parsed);
  const colStartIndex = columnLetterToIndex(settings.colStart || "A");
  const colEnd = indexToColumnLetter(colStartIndex + COLUMN_COUNT - 1);
  const headerRow = parseInt(settings.headerRow, 10) || 1;

  return { token, spreadsheetToken, sheetId: parsed.sheetId, colStart: settings.colStart || "A", colEnd, headerRow };
}

async function saveRecord(payload) {
  const ctx = await prepareSheetContext();
  const { token, spreadsheetToken, sheetId, colStart, colEnd, headerRow } = ctx;

  const dataStartRow = headerRow + 1;
  const dataEndRow = dataStartRow + 4999;
  const readRangeStr = `${sheetId}!${colStart}${dataStartRow}:${colEnd}${dataEndRow}`;
  const rows = await readRange(token, spreadsheetToken, readRangeStr);

  const existingIndex = rows.findIndex((r) => (r && r[LINK_OFFSET]) === payload.link);

  if (existingIndex !== -1) {
    const existing = rows[existingIndex] || [];
    const merged = [
      payload.name || existing[0] || "",
      payload.image || existing[1] || "",
      payload.link || existing[2] || "",
      payload.normalPrice != null ? payload.normalPrice : existing[3] ?? "",
      payload.weekendPrice != null ? payload.weekendPrice : existing[4] ?? "",
    ];
    const absoluteRow = dataStartRow + existingIndex;
    await writeRange(token, spreadsheetToken, `${sheetId}!${colStart}${absoluteRow}:${colEnd}${absoluteRow}`, merged);
    return { updated: true };
  }

  const newRow = [
    payload.name || "",
    payload.image || "",
    payload.link || "",
    payload.normalPrice ?? "",
    payload.weekendPrice ?? "",
  ];
  await appendRow(token, spreadsheetToken, `${sheetId}!${colStart}${dataStartRow}:${colEnd}${dataStartRow}`, newRow);
  return { updated: false };
}

async function testConnection() {
  const ctx = await prepareSheetContext();
  const sheets = await getSheetMeta(ctx.token, ctx.spreadsheetToken);
  const match = sheets.find((s) => s.sheetId === ctx.sheetId);
  if (!match) throw new Error("在这个表格里没找到链接对应的分表（sheet），确认没复制错标签页");
  return { title: match.title };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "SAVE_RECORD") {
    saveRecord(message.payload)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // keep the message channel open for the async response
  }
  if (message.type === "TEST_CONNECTION") {
    testConnection()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});
