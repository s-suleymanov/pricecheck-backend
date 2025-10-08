// background.js - single content.js, compare + resolve using price_feed only

const API_BASES = ["https://pricecheck-backend.onrender.com"];

function siteOK(url = "") {
  return /(amazon|target|walmart|bestbuy)\./i.test(url);
}

async function fetchJSON(url, opts) {
  const c = new AbortController();
  const id = setTimeout(() => c.abort("timeout"), 10000);
  try {
    const r = await fetch(url, { ...opts, signal: c.signal, headers: { Accept: "application/json" } });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(id);
  }
}

async function apiCompareByASIN(asin) {
  const qs = new URLSearchParams({ asin }).toString();
  for (const base of API_BASES) {
    const url = `${base.replace(/\/+$/, "")}/v1/compare?${qs}`;
    const data = await fetchJSON(url);
    if (data && Array.isArray(data.results)) return data;
  }
  return { results: [] };
}

async function apiResolve({ store, store_key, title }) {
  const qs = new URLSearchParams({ store, store_key: store_key || "", title: title || "" }).toString();
  for (const base of API_BASES) {
    const url = `${base.replace(/\/+$/, "")}/v1/resolve?${qs}`;
    const data = await fetchJSON(url);
    if (data && typeof data.asin === "string") return data; // { asin: "B0..." } or { asin: null }
  }
  return { asin: null };
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  if (!siteOK(tab.url || "")) return;

  // try toggle first
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_SIDEBAR" });
    return;
  } catch {}

  // inject once then toggle
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
  } catch {}
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_SIDEBAR" });
  } catch {}
});

// messages from content
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

  if (msg?.type === "RESOLVE_COMPARE_REQUEST") {
    (async () => {
      const { store, store_key, title } = msg.payload || {};
      const r = await apiResolve({ store, store_key, title });
      if (!r?.asin) return sendResponse({ results: [], asin: null });
      const c = await apiCompareByASIN(r.asin);
      sendResponse({ results: c.results || [], asin: r.asin });
    })();
    return true;
  }
});
