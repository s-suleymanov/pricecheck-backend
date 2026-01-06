// background.js
const API_BASES = ["https://pricecheck-extension.onrender.com"];

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

// GET-only helper for CORS-simple requests when possible
async function fetchJSON(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), 12000);
  try {
    const method = (opts.method || "GET").toUpperCase();
        const baseHeaders = method === "GET"
      ? { Accept: "application/json" }
      : { Accept: "application/json", "Content-Type": "application/json" };
    const headers = { ...baseHeaders, ...(opts.headers || {}) };
    const res = await fetch(url, { ...opts, method, headers, signal: controller.signal });
    if (!res.ok) return null;
    const text = await res.text();
    if (!text) return null;
    try { return JSON.parse(text); } catch { return null; }
  } catch {
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
  const qs = new URLSearchParams({ store, store_sku }).toString();
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

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  if (!siteOK(tab.url || "")) return;

  try { await chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_SIDEBAR" }); return; } catch {}

  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
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
