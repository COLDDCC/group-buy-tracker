const els = {
  scrapeBtn: document.getElementById("scrapeBtn"),
  scrapeStatus: document.getElementById("scrapeStatus"),
  form: document.getElementById("recordForm"),
  image: document.getElementById("image"),
  imagePreview: document.getElementById("imagePreview"),
  name: document.getElementById("name"),
  link: document.getElementById("link"),
  normalPrice: document.getElementById("normalPrice"),
  actualPrice: document.getElementById("actualPrice"),
  saveStatus: document.getElementById("saveStatus"),
  imageDebug: document.getElementById("imageDebug"),
  openOptions: document.getElementById("openOptions"),
};

els.openOptions.addEventListener("click", () => chrome.runtime.openOptionsPage());

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
  // Feishu's IMAGE() formula (used to render a thumbnail — see saveRecord in
  // background.js) can't load .webp images. 骏河屋/suruga-ya serves both a jpg and a
  // webp version of every product photo at predictable, swappable paths, so rewrite
  // to the jpg one here rather than silently shipping a link that'll never render.
  function fixWebpUrl(url) {
    try {
      const u = new URL(url);
      if (/(^|\.)suruga-ya\.jp$/i.test(u.hostname)) {
        u.pathname = u.pathname.replace("/pics_webp/", "/pics_light/").replace(/\.webp$/i, "");
      }
      return u.toString();
    } catch (e) {
      return url;
    }
  }

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
    if (og) return fixWebpUrl(og);
    const imgs = Array.from(document.querySelectorAll("img")).filter((img) => {
      const r = img.getBoundingClientRect();
      return r.width >= 150 && r.height >= 150 && img.src;
    });
    imgs.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return rb.width * rb.height - ra.width * ra.height;
    });
    return imgs.length ? fixWebpUrl(imgs[0].src) : "";
  }

  function isStruckThrough(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.textDecorationLine && style.textDecorationLine.includes("line-through")) return true;
    const cls = (el.className || "").toString().toLowerCase();
    return /line-through|original|delete|old-?price|划线/.test(cls);
  }

  function guessPrices() {
    // Supports ¥/￥-prefixed prices, Chinese 元, and Japanese 円 (骏河屋/suruga-ya.jp-style
    // shops price in yen, e.g. "150円（税込）" — no ¥ symbol at all), plus
    // comma-grouped thousands like "1,500円".
    const numberPattern = "\\d{1,3}(?:,\\d{3})*(?:\\.\\d{1,2})?";
    const priceRe = new RegExp(`[¥￥]\\s?${numberPattern}|${numberPattern}\\s?(?:円|元)`);
    const numberOnlyRe = new RegExp(`(${numberPattern})`);
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
      const match = text.match(numberOnlyRe);
      if (!match) continue;
      const value = parseFloat(match[1].replace(/,/g, ""));
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

async function runScrape() {
  els.scrapeStatus.textContent = "抓取中…";
  els.scrapeStatus.className = "hint";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) throw new Error("找不到当前标签页");
    if (!/^https?:/.test(tab.url || "")) throw new Error("这不是普通网页，插件抓不了（比如浏览器内置页面）");

    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scrapeProductPage,
    });

    els.name.value = result.name || "";
    els.link.value = normalizeLink(result.url || "");
    els.image.value = result.image || "";
    updateImagePreview();

    // "平时价格" is the regular/struck-through price if the page shows one, "实际价格"
    // is what you'd actually pay right now. When the page only has one price (no
    // discount running), both fields get that same number instead of one being left
    // blank.
    const normal = result.originalPrice != null ? result.originalPrice : result.currentPrice;
    const actual = result.currentPrice != null ? result.currentPrice : result.originalPrice;
    if (normal != null) els.normalPrice.value = normal;
    if (actual != null) els.actualPrice.value = actual;

    els.scrapeStatus.textContent = "已自动抓取，请核对图片/名称/价格后再保存";
    els.scrapeStatus.className = "hint success";
  } catch (err) {
    els.scrapeStatus.textContent = `抓取失败：${err.message}（可以手动填写各字段）`;
    els.scrapeStatus.className = "hint error";
  }
}

// Popup打开时就自动抓一次，不用等用户点按钮；按钮留着给页面内容后加载完（比如图片懒加载）时手动
// 重新抓一遍用。
runScrape();
els.scrapeBtn.addEventListener("click", runScrape);

// --- save ------------------------------------------------------------------

els.form.addEventListener("submit", async (e) => {
  e.preventDefault();
  els.saveStatus.textContent = "保存中…";
  els.saveStatus.className = "hint";

  const payload = {
    name: els.name.value.trim(),
    image: els.image.value.trim(),
    link: normalizeLink(els.link.value.trim()),
    normalPrice: els.normalPrice.value === "" ? null : parseFloat(els.normalPrice.value),
    actualPrice: els.actualPrice.value === "" ? null : parseFloat(els.actualPrice.value),
  };

  // If only one of the two price fields got filled in, mirror it into the other one —
  // there's no case where "only one price exists" should mean leaving a cell blank.
  if (payload.actualPrice == null && payload.normalPrice != null) {
    payload.actualPrice = payload.normalPrice;
  } else if (payload.normalPrice == null && payload.actualPrice != null) {
    payload.normalPrice = payload.actualPrice;
  }

  if (!payload.name || !payload.link) {
    els.saveStatus.textContent = "商品名称和商品链接不能为空";
    els.saveStatus.className = "hint error";
    return;
  }

  els.imageDebug.textContent = "";
  els.imageDebug.classList.remove("visible");

  try {
    const response = await chrome.runtime.sendMessage({ type: "SAVE_RECORD", payload });
    if (response && response.ok) {
      const where = response.row ? `（第 ${response.row} 行）` : "";
      els.saveStatus.textContent = (response.updated ? "已更新已有记录 ✅" : "已写入新记录 ✅") + where;
      els.saveStatus.className = "hint success";
      // Extra detail about the image field, straight after writing it — for 电子表格
      // this is Feishu's raw read-back of the cell, for 多维表格 it's an upload error
      // (if any). Lets you just screenshot this instead of digging through DevTools
      // when the thumbnail doesn't show up.
      if (response.imageDebug) {
        els.imageDebug.textContent = response.imageDebug;
        els.imageDebug.classList.add("visible");
      }
    } else {
      throw new Error((response && response.error) || "未知错误");
    }
  } catch (err) {
    els.saveStatus.textContent = `保存失败：${err.message}`;
    els.saveStatus.className = "hint error";
  }
});
