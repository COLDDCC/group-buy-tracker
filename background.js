importScripts("utils.js");

const FEISHU_HOST = "https://open.feishu.cn";
const COLUMN_COUNT = 5; // 商品名称, 商品图片链接, 商品链接, 平时价, 周末价 (in that order)
const LINK_OFFSET = 2; // 商品链接 is the 3rd of the 5 columns

async function getSettings() {
  // appId/appSecret are credentials — keep them in storage.local (this device only)
  // instead of storage.sync (synced through the user's Google account).
  const [local, synced] = await Promise.all([
    chrome.storage.local.get(["appId", "appSecret"]),
    chrome.storage.sync.get(["sheetUrl", "colStart", "headerRow", "holidayDates"]),
  ]);
  return { colStart: "A", headerRow: 1, ...synced, ...local };
}

// Wraps a Feishu API call: surfaces network failures and non-JSON responses (proxy
// errors, HTML error pages, etc.) as a readable message instead of a raw parse
// exception, and turns a non-zero business `code` into a thrown Error uniformly.
async function feishuRequest(url, options, context) {
  let resp;
  try {
    resp = await fetch(url, options);
  } catch (err) {
    throw new Error(`${context}：网络请求失败（${err.message}）`);
  }
  let data;
  try {
    data = await resp.json();
  } catch (err) {
    throw new Error(`${context}：飞书返回了无法解析的内容（HTTP ${resp.status}）`);
  }
  if (data.code !== 0) {
    throw new Error(`${context}：${data.msg || `错误码 ${data.code}`}`);
  }
  return data;
}

// tenant_access_token is valid for ~2h; cache it in memory (service worker can be
// evicted between uses, that's fine — a cache miss just re-fetches).
let tokenCache = { token: null, expiresAt: 0 };

async function getTenantAccessToken(appId, appSecret) {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) return tokenCache.token;

  const data = await feishuRequest(
    `${FEISHU_HOST}/open-apis/auth/v3/tenant_access_token/internal`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    },
    "获取飞书 token 失败"
  );
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

  const data = await feishuRequest(
    `${FEISHU_HOST}/open-apis/wiki/v2/spaces/get_node?token=${encodeURIComponent(parsed.token)}`,
    { headers: { Authorization: `Bearer ${token}` } },
    "解析知识库链接失败"
  );
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
  const data = await feishuRequest(
    sheetsUrl(spreadsheetToken, "/metainfo"),
    { headers: { Authorization: `Bearer ${token}` } },
    "读取表格信息失败"
  );
  return (data.data && data.data.sheets) || [];
}

async function readRange(token, spreadsheetToken, range) {
  const data = await feishuRequest(
    sheetsUrl(spreadsheetToken, `/values/${encodeURIComponent(range)}`),
    { headers: { Authorization: `Bearer ${token}` } },
    "读取表格内容失败"
  );
  return (data.data && data.data.valueRange && data.data.valueRange.values) || [];
}

async function appendRow(token, spreadsheetToken, range, row) {
  await feishuRequest(
    sheetsUrl(spreadsheetToken, "/values_append?insertDataOption=INSERT_ROWS"),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ valueRange: { range, values: [row] } }),
    },
    "新增行失败"
  );
}

async function writeRange(token, spreadsheetToken, range, row) {
  await feishuRequest(
    sheetsUrl(spreadsheetToken, "/values"),
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ valueRange: { range, values: [row] } }),
    },
    "更新行失败"
  );
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
  const colStart = settings.colStart || "A";
  const colStartIndex = columnLetterToIndex(colStart);
  const colEnd = indexToColumnLetter(colStartIndex + COLUMN_COUNT - 1);
  const headerRow = parseInt(settings.headerRow, 10) || 1;

  return { token, spreadsheetToken, sheetId: parsed.sheetId, colStart, colEnd, headerRow };
}

async function saveRecord(payload) {
  const ctx = await prepareSheetContext();
  const { token, spreadsheetToken, sheetId, colStart, colEnd, headerRow } = ctx;

  const link = normalizeLink(payload.link);
  const dataStartRow = headerRow + 1;
  const dataEndRow = dataStartRow + 4999;
  const readRangeStr = `${sheetId}!${colStart}${dataStartRow}:${colEnd}${dataEndRow}`;
  const rows = await readRange(token, spreadsheetToken, readRangeStr);

  const existingIndex = rows.findIndex((r) => (r && r[LINK_OFFSET]) === link);

  if (existingIndex !== -1) {
    const existing = rows[existingIndex] || [];
    const merged = [
      payload.name || existing[0] || "",
      payload.image || existing[1] || "",
      link || existing[2] || "",
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
    link || "",
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
