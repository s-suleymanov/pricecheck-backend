// background.js - Service Worker for the PriceCheck Extension

// Try local first, then fallback to Render
const API_BASES = [
  "https://pricecheck-backend.onrender.com",
  "http://localhost:4000"
];

// --- Caching ---
const cache = new Map();
const TTL_MS = 5 * 60 * 1000;

function getCache(key) {
  const v = cache.get(key);
  if (!v) return null;
  if (Date.now() - v.t > TTL_MS) {
    cache.delete(key);
    return null;
  }
  return v.data;
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

async function fetchCompare(params) {
  const qs = new URLSearchParams(params).toString();
  for (const baseRaw of API_BASES) {
    const base = baseRaw.replace(/\/+$/, "");
    const url = `${base}/v1/compare?${qs}`;
    const data = await fetchJSON(url);
    if (data && Array.isArray(data.results)) {
      return data;
    }
  }
  return { results: [] };
}

// Toolbar click -> inject content.js and toggle sidebar
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  if (!/^https?:\/\/([a-z0-9-]+\.)*amazon\./i.test(tab.url || "")) return;

  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
  } catch {}
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_SIDEBAR" });
  } catch {}
});

// Handle compare request from content.js
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "COMPARE_REQUEST") return;

  const { upc, asin, title } = msg.payload || {};
  const key = JSON.stringify({ upc, asin, title });

  const hit = getCache(key);
  if (hit) {
    sendResponse(hit);
    return;
  }

  (async () => {
    const data = await fetchCompare({ upc: upc || "", asin: asin || "", title: title || "" });
    const payload = { results: Array.isArray(data?.results) ? data.results : [] };
    cache.set(key, { t: Date.now(), data: payload });
    sendResponse(payload);
  })();

  return true;
});
