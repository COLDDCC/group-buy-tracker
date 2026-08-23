const els = {
  scrapeBtn: document.getElementById("scrapeBtn"),
  scrapeStatus: document.getElementById("scrapeStatus"),
  form: document.getElementById("recordForm"),
  image: document.getElementById("image"),
  imagePreview: document.getElementById("imagePreview"),
  name: document.getElementById("name"),
  link: document.getElementById("link"),
  normalPrice: document.getElementById("normalPrice"),
  weekendPrice: document.getElementById("weekendPrice"),
  forceHoliday: document.getElementById("forceHoliday"),
  dayTypeHint: document.getElementById("dayTypeHint"),
  saveStatus: document.getElementById("saveStatus"),
  openOptions: document.getElementById("openOptions"),
};

els.openOptions.addEventListener("click", () => chrome.runtime.openOptionsPage());

// --- day-type banner -------------------------------------------------------

async function refreshDayTypeHint() {
  const { holidayDates = "" } = await chrome.storage.sync.get("holidayDates");
  const holidaySet = parseHolidayList(holidayDates);
  const auto = isWeekendOrHoliday(new Date(), holidaySet);
  els.forceHoliday.checked = auto;
  els.dayTypeHint.textContent = auto
    ? "今天自动判定为「周末/节假日」，抓取到的价格会先填进周末价"
    : "今天自动判定为「平时」，抓取到的价格会先填进平时价";
}
refreshDayTypeHint();
els.forceHoliday.addEventListener("change", () => {
  els.dayTypeHint.textContent = els.forceHoliday.checked
    ? "已手动切换为「周末/节假日」"
    : "已手动切换为「平时」";
});

// --- image preview -----------------------------------------------------

function updateImagePreview() {
  const url = els.image.value.trim();
  if (url) {
    els.imagePreview.src = url;
    els.imagePreview.classList.add("visible");
  } else {
    els.imagePreview.classList.remove("visible");
  }
}
els.image.addEventListener("input", updateImagePreview);
els.imagePreview.addEventListener("error", () => els.imagePreview.classList.remove("visible"));

// --- scraping ------------------------------------------------------------

// Injected into the product page. Must be self-contained (no closures over
// popup.js variables) since chrome.scripting.executeScript serializes it.
function scrapeProductPage() {
  function meta(name) {
    const el =
      document.querySelector(`meta[property="${name}"]`) ||
      document.querySelector(`meta[name="${name}"]`);
    return el ? el.content : "";
  }

  function guessName() {
    return (
      meta("og:title") ||
      (document.querySelector("h1") || {}).innerText ||
      document.title ||
      ""
    ).trim();
  }

  function guessImage() {
    const og = meta("og:image");
    if (og) return og;
    const imgs = Array.from(document.querySelectorAll("img")).filter((img) => {
      const r = img.getBoundingClientRect();
      return r.width >= 150 && r.height >= 150 && img.src;
    });
    imgs.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return rb.width * rb.height - ra.width * ra.height;
    });
    return imgs.length ? imgs[0].src : "";
  }

  function isStruckThrough(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.textDecorationLine && style.textDecorationLine.includes("line-through")) return true;
    const cls = (el.className || "").toString().toLowerCase();
    return /line-through|original|delete|old-?price|划线/.test(cls);
  }

  function guessPrices() {
    const priceRe = /[¥￥]\s?\d+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?\s?元/;
    const candidates = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const text = node.nodeValue.trim();
      if (!text || !priceRe.test(text)) continue;
      const parent = node.parentElement;
      if (!parent) continue;
      const rect = parent.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue; // hidden
      const match = text.match(/(\d+(?:\.\d{1,2})?)/);
      if (!match) continue;
      const value = parseFloat(match[1]);
      if (!Number.isFinite(value) || value <= 0) continue;
      const fontSize = parseFloat(window.getComputedStyle(parent).fontSize) || 0;
      candidates.push({ value, fontSize, struck: isStruckThrough(parent), top: rect.top });
    }
    if (!candidates.length) return { current: null, original: null };

    const struck = candidates.filter((c) => c.struck);
    const normal = candidates.filter((c) => !c.struck);

    // "Current" price: the largest, most prominent non-struck-through number near
    // the top of the page (product price blocks are almost always above the fold).
    const pool = normal.length ? normal : candidates;
    pool.sort((a, b) => b.fontSize - a.fontSize || a.top - b.top);
    const current = pool[0].value;

    let original = null;
    if (struck.length) {
      struck.sort((a, b) => b.fontSize - a.fontSize || a.top - b.top);
      original = struck[0].value;
    }
    return { current, original };
  }

  const prices = guessPrices();
  return {
    url: location.href,
    name: guessName(),
    image: guessImage(),
    currentPrice: prices.current,
    originalPrice: prices.original,
  };
}

els.scrapeBtn.addEventListener("click", async () => {
  els.scrapeStatus.textContent = "抓取中…";
  els.scrapeStatus.className = "hint";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) throw new Error("找不到当前标签页");

    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scrapeProductPage,
    });

    els.name.value = result.name || "";
    els.link.value = result.url || "";
    els.image.value = result.image || "";
    updateImagePreview();

    const isHoliday = els.forceHoliday.checked;
    const target = isHoliday ? els.weekendPrice : els.normalPrice;
    const other = isHoliday ? els.normalPrice : els.weekendPrice;
    if (result.currentPrice != null) target.value = result.currentPrice;
    if (result.originalPrice != null && !other.value) other.value = result.originalPrice;

    els.scrapeStatus.textContent = "抓取完成，请核对图片/名称/价格后再保存";
    els.scrapeStatus.className = "hint success";
  } catch (err) {
    els.scrapeStatus.textContent = `抓取失败：${err.message}（可以手动填写各字段）`;
    els.scrapeStatus.className = "hint error";
  }
});

// --- save ------------------------------------------------------------------

els.form.addEventListener("submit", async (e) => {
  e.preventDefault();
  els.saveStatus.textContent = "保存中…";
  els.saveStatus.className = "hint";

  const payload = {
    name: els.name.value.trim(),
    image: els.image.value.trim(),
    link: els.link.value.trim(),
    normalPrice: els.normalPrice.value === "" ? null : parseFloat(els.normalPrice.value),
    weekendPrice: els.weekendPrice.value === "" ? null : parseFloat(els.weekendPrice.value),
  };

  if (!payload.name || !payload.link) {
    els.saveStatus.textContent = "商品名称和商品链接不能为空";
    els.saveStatus.className = "hint error";
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({ type: "SAVE_RECORD", payload });
    if (response && response.ok) {
      els.saveStatus.textContent = response.updated ? "已更新已有记录 ✅" : "已写入新记录 ✅";
      els.saveStatus.className = "hint success";
    } else {
      throw new Error((response && response.error) || "未知错误");
    }
  } catch (err) {
    els.saveStatus.textContent = `保存失败：${err.message}`;
    els.saveStatus.className = "hint error";
  }
});
