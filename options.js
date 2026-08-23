const FIELD_IDS = ["appId", "appSecret", "sheetUrl", "colStart", "headerRow", "holidayDates"];

const DEFAULTS = {
  colStart: "A",
  headerRow: "1",
};

const statusEl = document.getElementById("status");

async function load() {
  const stored = await chrome.storage.sync.get(FIELD_IDS);
  for (const id of FIELD_IDS) {
    const value = stored[id] ?? DEFAULTS[id] ?? "";
    document.getElementById(id).value = value;
  }
}
load();

function collectValues() {
  const values = {};
  for (const id of FIELD_IDS) values[id] = document.getElementById(id).value.trim();
  return values;
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
  await chrome.storage.sync.set(collectValues());
  statusEl.textContent = "已保存 ✅";
  statusEl.className = "hint success";
});

document.getElementById("test").addEventListener("click", async () => {
  statusEl.textContent = "测试中…";
  statusEl.className = "hint";
  await chrome.storage.sync.set(collectValues());

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
