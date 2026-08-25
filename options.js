// appId/appSecret are credentials — stored in storage.local (this device only) so they
// never leave the machine through Chrome sync. Everything else is just config and is
// fine synced across the user's own devices.
const LOCAL_FIELD_IDS = ["appId", "appSecret"];
const SYNC_FIELD_IDS = [
  "sheetUrl",
  "colName",
  "colImage",
  "colLink",
  "colNormalPrice",
  "colWeekendPrice",
  "headerRow",
  "holidayDates",
];
const ALL_FIELD_IDS = [...LOCAL_FIELD_IDS, ...SYNC_FIELD_IDS];

const DEFAULTS = {
  colName: "A",
  colImage: "B",
  colLink: "C",
  colNormalPrice: "D",
  colWeekendPrice: "E",
  headerRow: "1",
};

const statusEl = document.getElementById("status");

async function load() {
  const [local, synced] = await Promise.all([
    chrome.storage.local.get(LOCAL_FIELD_IDS),
    chrome.storage.sync.get(SYNC_FIELD_IDS),
  ]);
  const stored = { ...local, ...synced };
  for (const id of ALL_FIELD_IDS) {
    document.getElementById(id).value = stored[id] ?? DEFAULTS[id] ?? "";
  }
}
load();

async function persistValues() {
  const local = {};
  for (const id of LOCAL_FIELD_IDS) local[id] = document.getElementById(id).value.trim();
  const synced = {};
  for (const id of SYNC_FIELD_IDS) synced[id] = document.getElementById(id).value.trim();
  await Promise.all([chrome.storage.local.set(local), chrome.storage.sync.set(synced)]);
}

document.getElementById("sheetUrl").addEventListener("blur", (e) => {
  const parsed = parseSheetUrl(e.target.value.trim());
  if (e.target.value.trim() && !parsed) {
    statusEl.textContent = "这个链接看起来不是飞书表格链接（应该包含 /wiki/ 或 /sheets/），请重新复制";
    statusEl.className = "hint error";
  } else if (parsed && !parsed.sheetId) {
    statusEl.textContent = "链接里没有 ?sheet=xxx，请确认复制的是具体分表标签页的链接，不是整个文档首页";
    statusEl.className = "hint error";
  } else {
    statusEl.textContent = "";
  }
});

document.getElementById("save").addEventListener("click", async () => {
  await persistValues();
  statusEl.textContent = "已保存 ✅";
  statusEl.className = "hint success";
});

document.getElementById("test").addEventListener("click", async () => {
  statusEl.textContent = "测试中…";
  statusEl.className = "hint";
  await persistValues();

  try {
    const response = await chrome.runtime.sendMessage({ type: "TEST_CONNECTION" });
    if (response && response.ok) {
      statusEl.textContent = `连接成功 ✅ 找到分表「${response.title}」`;
      statusEl.className = "hint success";
    } else {
      throw new Error((response && response.error) || "未知错误");
    }
  } catch (err) {
    statusEl.textContent = `连接失败：${err.message}`;
    statusEl.className = "hint error";
  }
});
