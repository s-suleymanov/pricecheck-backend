// background.js
const API_BASES = ["https://pricecheck-extension.onrender.com"];

// post-install welcome page (opens once)
const SITE_BASE = "https://www.pricechecktool.com";


const INSTALL_LANDING_KEY = "pc_install_landing_opened_v1";

try {
  const v = chrome.runtime.getManifest().version;

  const url =
    `${SITE_BASE}/uninstall` +
    `?utm_source=extension&utm_medium=uninstall&utm_campaign=uninstall` +
    `&v=${encodeURIComponent(v)}`;

  chrome.runtime.setUninstallURL(url);
} catch {}

const PEEK_KEY = "pc_peek_tab_pinned";

chrome.runtime.onInstalled.addListener((details) => {
  if (details?.reason !== "install") return;

  chrome.storage.local.get([INSTALL_LANDING_KEY, PEEK_KEY], (st) => {
    // Default: pinned ON after install
    if (!st || typeof st[PEEK_KEY] === "undefined") {
      chrome.storage.local.set({ [PEEK_KEY]: true });
    }

    if (st && st[INSTALL_LANDING_KEY]) return;

    const v = chrome.runtime.getManifest().version;
    const id = chrome.runtime.id;

    const url =
      `${SITE_BASE}/installed` +
      `?utm_source=extension&utm_medium=post_install&utm_campaign=install` +
      `&v=${encodeURIComponent(v)}` +
      `&ext_id=${encodeURIComponent(id)}`;

    chrome.tabs.create({ url }, () => {
      chrome.storage.local.set({ [INSTALL_LANDING_KEY]: true });
    });
  });
});

function siteOK(url = "") {
  return /(amazon|target|walmart|bestbuy)\./i.test(url);
}

let __CLIENT_ID = null;

async function getClientId() {
  if (__CLIENT_ID) return __CLIENT_ID;

  const stored = await chrome.storage.local.get(["pc_client_id"]);
  if (stored?.pc_client_id) {
    __CLIENT_ID = stored.pc_client_id;
    return __CLIENT_ID;
  }

  // install-scoped random id
  const id = (crypto?.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)) + "-" + Date.now();
  await chrome.storage.local.set({ pc_client_id: id });
  __CLIENT_ID = id;
  return __CLIENT_ID;
}

async function fetchJSON(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), 12000);

  const method = (opts.method || "GET").toUpperCase();
  const baseHeaders = method === "GET"
    ? { Accept: "application/json" }
    : { Accept: "application/json", "Content-Type": "application/json" };

  const headers = { ...baseHeaders, ...(opts.headers || {}) };

  const t0 = Date.now();
  try {
    console.log("[pc:bg] fetch ->", method, url);

    const res = await fetch(url, { ...opts, method, headers, signal: controller.signal });
    const ms = Date.now() - t0;

    const text = await res.text().catch(() => "");
    const head = text ? text.slice(0, 300) : "";

    console.log("[pc:bg] fetch <-", method, url, "status=", res.status, "ms=", ms, "bodyHead=", head);

    if (!res.ok) return null;
    if (!text) return null;

    try {
      return JSON.parse(text);
    } catch (e) {
      console.log("[pc:bg] JSON parse failed", url, "err=", String(e));
      return null;
    }
  } catch (e) {
    const ms = Date.now() - t0;
    console.log("[pc:bg] fetch ERROR", method, url, "ms=", ms, "err=", String(e));
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function apiCompareByASIN(asin) {
  const a = String(asin || "").toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(a)) return { results: [] };
  const qs = new URLSearchParams({ asin: a }).toString();
  for (const base of API_BASES) {
    const url = `${base.replace(/\/+$/, "")}/v1/compare?${qs}`;
    const data = await fetchJSON(url);
    if (data && Array.isArray(data.results)) return data;
  }
  return { results: [] };
}

// New: compare by store_sku (e.g., TCIN) → backend resolves to UPC → runs compare
async function apiCompareByStoreSKU(store, store_sku) {
  if (!store || !store_sku) return { asin: null, results: [] };
  const qs = new URLSearchParams({
    store: String(store || "").toLowerCase(),
    store_sku: String(store_sku || "").trim()
  }).toString();
  for (const base of API_BASES) {
    const url = `${base.replace(/\/+$/, "")}/v1/compare_by_store_sku?${qs}`;
    const data = await fetchJSON(url);
    if (data && Array.isArray(data.results)) return data;
  }
  return { asin: null, results: [] };
}

async function apiObserve(payload) {
  const clientId = await getClientId();

  for (const base of API_BASES) {
    const url = `${base.replace(/\/+$/, "")}/v1/observe`;
    const data = await fetchJSON(url, {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "X-PC-Client": clientId },
    });
    if (data && data.ok) return true;
  }
  return false;
}

async function shouldAutoInject() {
  try {
    const st = await chrome.storage.local.get([PEEK_KEY]);
    return !!st?.[PEEK_KEY];
  } catch {
    return false;
  }
}

async function ensureInjected(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PC_PING" });
    return;
  } catch {}

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.bundle.js"],
    });
  } catch {}
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;

  const url = tab?.url || "";
  if (!siteOK(url)) return;

  (async () => {
    const pinned = await shouldAutoInject();
    if (!pinned) return;
    await ensureInjected(tabId);
  })();
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  if (!siteOK(tab.url || "")) return;

  try { await chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_SIDEBAR" }); return; } catch {}

  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.bundle.js"] });
  } catch {}
  try { await chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_SIDEBAR" }); } catch {}
});

// bus
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "COMPARE_REQUEST") {
    (async () => {
      const asin = (msg.payload?.asin || "").toUpperCase();
      if (!asin) return sendResponse({ results: [] });
      const data = await apiCompareByASIN(asin);
      sendResponse({ results: data.results || [] });
    })();
    return true;
  }

  // Non-Amazon path: use store_sku (TCIN, etc.)
  if (msg?.type === "RESOLVE_COMPARE_REQUEST") {
    (async () => {
      const { store, store_sku } = msg.payload || {};
      if (store && store_sku) {
        const data = await apiCompareByStoreSKU(store, store_sku);
        return sendResponse({ results: data?.results || [], asin: data?.asin || null });
      }
      return sendResponse({ results: [], asin: null });
    })();
    return true;
  }

     if (msg?.type === "OBSERVE_PRICE") {
    console.log("[bus] OBSERVE_PRICE from", _sender?.tab?.url, msg.payload);

    (async () => {
      const tabUrl = _sender?.tab?.url || "";
      if (!siteOK(tabUrl)) return sendResponse({ ok: false, error: "siteOK=false" });

      const ok = await apiObserve(msg.payload || {});
      console.log("[bus] OBSERVE_PRICE apiObserve ok=", ok);
      sendResponse({ ok });
    })();
    return true;
  }
});