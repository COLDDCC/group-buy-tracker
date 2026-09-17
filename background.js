importScripts("utils.js");

const FEISHU_HOST = "https://open.feishu.cn";

// Each of the 5 fields the extension can write has its own column letter, independent
// of the others — the user's sheet can interleave manual-only columns (cn/个数/QQ号...)
// anywhere, and a field with no column configured is simply never written.
const COLUMN_FIELD_IDS = ["colName", "colImage", "colLink", "colNormalPrice", "colActualPrice"];
const COLUMN_DEFAULTS = { colName: "A", colImage: "B", colLink: "C", colNormalPrice: "D", colActualPrice: "E" };

async function getSettings() {
  // appId/appSecret are credentials — keep them in storage.local (this device only)
  // instead of storage.sync (synced through the user's Google account).
  const [local, synced] = await Promise.all([
    chrome.storage.local.get(["appId", "appSecret"]),
    chrome.storage.sync.get(["sheetUrl", "headerRow", ...COLUMN_FIELD_IDS]),
  ]);
  return { headerRow: 1, ...COLUMN_DEFAULTS, ...synced, ...local };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(resp, data) {
  if (resp.status === 429) return true;
  const msg = (data && data.msg) || "";
  return /too many request/i.test(msg);
}

// Wraps a Feishu API call: surfaces network failures and non-JSON responses (proxy
// errors, HTML error pages, etc.) as a readable message instead of a raw parse
// exception, turns a non-zero business `code` into a thrown Error uniformly, and
// retries with backoff on rate-limit responses (Feishu's per-document write QPS limit
// is easy to hit when saving several fields back to back).
async function feishuRequest(url, options, context, attempt = 1) {
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
    if (isRateLimitError(resp, data) && attempt < 4) {
      await sleep(attempt * 800);
      return feishuRequest(url, options, context, attempt + 1);
    }
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

// A Wiki node token isn't the underlying spreadsheetToken/appToken — resolve it once
// via the wiki API and cache the mapping locally (it never changes for a given doc).
// Handles both products: parsed.product says which obj_type to expect back.
async function resolveObjToken(token, parsed) {
  if (!parsed.isWiki) return parsed.token;

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
  const expectedType = parsed.product === "bitable" ? "bitable" : "sheet";
  if (node.obj_type && node.obj_type !== expectedType) {
    const expectedLabel = parsed.product === "bitable" ? "多维表格" : "电子表格";
    throw new Error(`这个知识库节点不是${expectedLabel}（类型是 ${node.obj_type}），请确认链接是否正确`);
  }
  await chrome.storage.local.set({ [cacheKey]: node.obj_token });
  return node.obj_token;
}

function sheetsUrl(spreadsheetToken, suffix) {
  return `${FEISHU_HOST}/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}${suffix}`;
}

function bitableUrl(appToken, suffix) {
  return `${FEISHU_HOST}/open-apis/bitable/v1/apps/${appToken}${suffix}`;
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

// Diagnostic-only: returns the *raw* valueRange for a single cell (unlike readRange,
// which throws everything away except .values) so we can see exactly what Feishu
// stored for the IMAGE() formula cell — whether it came back with anything indicating
// a live formula, or just the literal text. Never throws; a failed read just means no
// debug info, which shouldn't block the save.
async function readCellRaw(token, spreadsheetToken, range) {
  try {
    const data = await feishuRequest(
      sheetsUrl(spreadsheetToken, `/values/${encodeURIComponent(range)}`),
      { headers: { Authorization: `Bearer ${token}` } },
      "读取单元格失败"
    );
    return JSON.stringify(data.data && data.data.valueRange);
  } catch (err) {
    return `读取失败：${err.message}`;
  }
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

async function getBitableTables(token, appToken) {
  const data = await feishuRequest(
    bitableUrl(appToken, "/tables"),
    { headers: { Authorization: `Bearer ${token}` } },
    "读取多维表格信息失败"
  );
  return (data.data && data.data.items) || [];
}

// Finds records whose `linkFieldName` field equals `linkValue` exactly — this is the
// Bitable equivalent of the Sheets version's "read the whole link column and compare
// locally", but done server-side via a filtered query instead of pulling ~5000 rows.
async function searchBitableRecords(token, appToken, tableId, linkFieldName, linkValue) {
  const data = await feishuRequest(
    bitableUrl(appToken, `/tables/${tableId}/records/search`),
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        field_names: [linkFieldName],
        filter: {
          conjunction: "and",
          conditions: [{ field_name: linkFieldName, operator: "is", value: [linkValue] }],
        },
      }),
    },
    "查重失败"
  );
  return (data.data && data.data.items) || [];
}

async function createBitableRecord(token, appToken, tableId, fields) {
  const data = await feishuRequest(
    bitableUrl(appToken, `/tables/${tableId}/records`),
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ fields }),
    },
    "新建记录失败"
  );
  return data.data.record;
}

async function updateBitableRecord(token, appToken, tableId, recordId, fields) {
  const data = await feishuRequest(
    bitableUrl(appToken, `/tables/${tableId}/records/${recordId}`),
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ fields }),
    },
    "更新记录失败"
  );
  return data.data.record;
}

function guessImageExt(url, mimeType) {
  const fromUrl = (url.match(/\.(jpe?g|png|gif|bmp)(?:$|\?)/i) || [])[1];
  if (fromUrl) return "." + fromUrl.toLowerCase().replace("jpeg", "jpg");
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/gif") return ".gif";
  return ".jpg";
}

// Bitable's "attachment" field (used here to get a real thumbnail, unlike a plain
// text/URL field) needs the actual file bytes uploaded to Feishu's drive first —
// there's no equivalent of the Sheets side's "=IMAGE(url)" trick that lets Feishu
// fetch the image itself. So: download the image from the product page's site, then
// re-upload those bytes to Feishu. This is why host_permissions had to widen to all
// sites (manifest.json) — a background fetch to an arbitrary shopping site only
// bypasses that site's CORS restrictions when the extension actually holds a host
// permission covering it.
async function uploadImageToBitable(token, appToken, imageUrl) {
  let resp;
  try {
    resp = await fetch(imageUrl);
  } catch (err) {
    throw new Error(`下载图片失败（${err.message}），可能是图片站有防盗链限制`);
  }
  if (!resp.ok) throw new Error(`下载图片失败（HTTP ${resp.status}），可能是图片站有防盗链限制`);
  const blob = await resp.blob();

  const fileName = `image${guessImageExt(imageUrl, blob.type)}`;
  const form = new FormData();
  form.append("file_name", fileName);
  form.append("parent_type", "bitable_image");
  form.append("parent_node", appToken);
  form.append("size", String(blob.size));
  form.append("file", blob, fileName);

  let uploadResp;
  try {
    uploadResp = await fetch(`${FEISHU_HOST}/open-apis/drive/v1/medias/upload_all`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
  } catch (err) {
    throw new Error(`上传图片到飞书失败（${err.message}）`);
  }
  let data;
  try {
    data = await uploadResp.json();
  } catch (err) {
    throw new Error(`上传图片到飞书失败：返回了无法解析的内容（HTTP ${uploadResp.status}）`);
  }
  if (data.code !== 0) throw new Error(`上传图片到飞书失败：${data.msg || `错误码 ${data.code}`}`);
  return { file_token: data.data.file_token, name: fileName };
}

// Feishu Sheets renders a thumbnail for a cell whose value is an IMAGE() formula —
// confirmed by live testing. It does NOT support .webp images (fixWebpUrl in
// popup.js already rewrites 駿河屋's webp links to jpg before this ever sees them);
// other sites' webp images will just show #VALUE! in this cell, same as any other
// image Feishu can't fetch (hotlink-protected, too large, not actually public).
//
// A plain "=IMAGE(...)" string doesn't work through the /values write endpoint —
// confirmed by the read-back debug output: Feishu treated it as a rich-text value
// (the URL inside got auto-linkified into a `type: "url"` segment) instead of a
// formula. The value has to explicitly say what it is.
function imageFormula(url) {
  return { type: "formula", text: `=IMAGE("${url.replace(/"/g, "")}")` };
}

async function prepareContext() {
  const settings = await getSettings();
  const { appId, appSecret, sheetUrl } = settings;
  if (!appId || !appSecret || !sheetUrl) {
    throw new Error("请先在插件设置里填好飞书 App ID / App Secret / 表格链接");
  }
  const parsed = parseSheetUrl(sheetUrl);
  if (!parsed) throw new Error("表格链接格式无法识别，请重新从浏览器地址栏复制完整链接");
  if (parsed.product === "sheets" && !parsed.sheetId) {
    throw new Error("链接里没有 ?sheet=xxx 参数，请确认复制的是分表标签页的完整链接");
  }
  if (parsed.product === "bitable" && !parsed.tableId) {
    throw new Error("链接里没有 ?table=xxx 参数，请确认复制的是多维表格具体数据表标签页的完整链接");
  }
  if (!settings.colLink) {
    const what = parsed.product === "bitable" ? "字段名" : "列";
    throw new Error(`请先在插件设置里填「商品链接」对应的${what}，插件靠它去重`);
  }

  const token = await getTenantAccessToken(appId, appSecret);
  const objToken = await resolveObjToken(token, parsed);
  const headerRow = parseInt(settings.headerRow, 10) || 1;

  const columns = {};
  for (const id of COLUMN_FIELD_IDS) columns[id] = (settings[id] || "").trim();

  return { token, objToken, parsed, headerRow, columns };
}

async function saveRecord(payload) {
  const ctx = await prepareContext();
  return ctx.parsed.product === "bitable" ? saveRecordBitable(ctx, payload) : saveRecordSheets(ctx, payload);
}

async function saveRecordBitable(ctx, payload) {
  const { token, objToken, parsed, columns } = ctx;
  const link = normalizeLink(payload.link);
  const linkField = columns.colLink;

  const matches = await searchBitableRecords(token, objToken, parsed.tableId, linkField, link);
  const existing = matches[0];

  const fields = { [linkField]: link };
  if (columns.colName && payload.name) fields[columns.colName] = payload.name;
  if (columns.colNormalPrice && payload.normalPrice != null) fields[columns.colNormalPrice] = payload.normalPrice;
  if (columns.colActualPrice && payload.actualPrice != null) fields[columns.colActualPrice] = payload.actualPrice;

  // Uploading the image is the one step that can fail on its own (hotlink protection,
  // an image host that's down, an unsupported format) without that being a reason to
  // lose the rest of the record — same "best effort" spirit as the Sheets side's
  // IMAGE() formula, which also just shows #ERROR/#VALUE! instead of blocking the save.
  let imageDebug = null;
  if (columns.colImage && payload.image) {
    try {
      const uploaded = await uploadImageToBitable(token, objToken, payload.image);
      fields[columns.colImage] = [uploaded];
    } catch (err) {
      imageDebug = `图片没有保存成功：${err.message}（其他字段已正常保存）`;
    }
  }

  const record = existing
    ? await updateBitableRecord(token, objToken, parsed.tableId, existing.record_id, fields)
    : await createBitableRecord(token, objToken, parsed.tableId, fields);

  return { updated: !!existing, row: null, recordId: record.record_id, imageDebug };
}

async function saveRecordSheets(ctx, payload) {
  const { token, objToken: spreadsheetToken, headerRow, columns } = ctx;
  const sheetId = ctx.parsed.sheetId;

  const link = normalizeLink(payload.link);
  const dataStartRow = headerRow + 1;
  const dataEndRow = dataStartRow + 4999;

  // Only need the link column to find the matching row (or, if none matches, the next
  // empty row to append at) — the other fields are written independently below, so
  // there's no need to read them at all.
  const linkColRange = `${sheetId}!${columns.colLink}${dataStartRow}:${columns.colLink}${dataEndRow}`;
  const linkRows = await readRange(token, spreadsheetToken, linkColRange);
  const linkValues = linkRows.map((r) => (r && r[0]) || "");

  // Feishu pads the response out to the full requested range instead of trimming
  // trailing blank rows, so linkValues.length is NOT "how many rows have data" — it's
  // always ~5000. Scan backward for the last actually-filled cell instead.
  let lastFilledOffset = -1;
  for (let i = linkValues.length - 1; i >= 0; i--) {
    if (linkValues[i]) {
      lastFilledOffset = i;
      break;
    }
  }

  const existingIndex = linkValues.findIndex((v) => v === link);
  const updated = existingIndex !== -1;
  const absoluteRow = updated ? dataStartRow + existingIndex : dataStartRow + lastFilledOffset + 1;

  const fieldValues = {
    colName: payload.name,
    colLink: link,
    colNormalPrice: payload.normalPrice,
    colActualPrice: payload.actualPrice,
  };

  if (payload.image) fieldValues.colImage = imageFormula(payload.image);

  // Write each configured field to its own single cell — never touches columns the
  // user didn't map (manual-only columns like cn/个数/QQ号 stay untouched), and skips
  // any field left blank so it doesn't blank out a value already sitting in the sheet.
  // One at a time, not Promise.all: Feishu's per-document write QPS limit is easy to
  // trip by firing several writes at the same instant.
  const fieldsToWrite = COLUMN_FIELD_IDS.filter(
    (id) => columns[id] && fieldValues[id] !== null && fieldValues[id] !== undefined && fieldValues[id] !== ""
  );
  for (const id of fieldsToWrite) {
    const col = columns[id];
    await writeRange(token, spreadsheetToken, `${sheetId}!${col}${absoluteRow}:${col}${absoluteRow}`, [fieldValues[id]]);
  }

  // Diagnostic: read the image cell straight back so the popup can show exactly what
  // Feishu now has stored there — settles whether the IMAGE() string is being kept as
  // a live formula or just literal text, instead of guessing from the outside.
  let imageDebug = null;
  if (fieldValues.colImage) {
    const col = columns.colImage;
    const raw = await readCellRaw(token, spreadsheetToken, `${sheetId}!${col}${absoluteRow}:${col}${absoluteRow}`);
    imageDebug = `图片格子读回内容：${raw}`;
  }

  return { updated, row: absoluteRow, imageDebug };
}

async function testConnection() {
  const ctx = await prepareContext();
  if (ctx.parsed.product === "bitable") {
    const tables = await getBitableTables(ctx.token, ctx.objToken);
    const match = tables.find((t) => t.table_id === ctx.parsed.tableId);
    if (!match) throw new Error("在这个多维表格里没找到链接对应的数据表，确认没复制错标签页");
    return { title: match.name };
  }
  const sheets = await getSheetMeta(ctx.token, ctx.objToken);
  const match = sheets.find((s) => s.sheetId === ctx.parsed.sheetId);
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
