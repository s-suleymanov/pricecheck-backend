// background.js
const API_BASES = ["https://pricecheck-backend.onrender.com"];

function siteOK(url = "") {
  return /(amazon|target|walmart|bestbuy)\./i.test(url);
}

async function fetchJSON(url, opts) {
  const c = new AbortController();
  const id = setTimeout(() => c.abort('timeout'), 10000);
  try {
    const r = await fetch(url, {
      ...opts,
      signal: c.signal,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' }
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(id);
  }
}

const REQUEST_TIMEOUT_MS = 8000; // keep
async function apiCompareByUPC(store, upc) {
  const qs = new URLSearchParams({ store, upc }).toString();
  for (const base of API_BASES) {
    const url = `${base.replace(/\/+$/, '')}/v1/compare_by_upc?${qs}`;
    const data = await fetchJSON(url);
    if (data && Array.isArray(data.results)) return data;
  }
  return { asin: null, results: [] };
}


async function apiCompareByASIN(asin) {
  const qs = new URLSearchParams({ asin }).toString();
  for (const base of API_BASES) {
    const url = `${base.replace(/\/+$/, '')}/v1/compare?${qs}`;
    const data = await fetchJSON(url);
    if (data && Array.isArray(data.results)) return data;
  }
  return { results: [] };
}

async function apiResolve({ store, store_key, title }) {
  const qs = new URLSearchParams({ store, store_key: store_key || '', title: title || '' }).toString();
  for (const base of API_BASES) {
    const url = `${base.replace(/\/+$/, '')}/v1/resolve?${qs}`;
    const data = await fetchJSON(url);
    if (data && typeof data.asin !== 'undefined') return data;
  }
  return { asin: null };
}

async function apiObserve(payload) {
  for (const base of API_BASES) {
    const url = `${base.replace(/\/+$/, '')}/v1/observe`;
    const data = await fetchJSON(url, { method: 'POST', body: JSON.stringify(payload) });
    if (data && data.ok) return true;
  }
  return false;
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  if (!siteOK(tab.url || '')) return;

  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_SIDEBAR' });
    return;
  } catch {}

  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
  } catch {}
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_SIDEBAR' });
  } catch {}
});

// messages from content
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'COMPARE_REQUEST') {
    (async () => {
      const asin = (msg.payload?.asin || '').toUpperCase();
      if (!asin) return sendResponse({ results: [] });
      const data = await apiCompareByASIN(asin);
      sendResponse({ results: data.results || [] });
    })();
    return true;
  }

if (msg?.type === 'RESOLVE_COMPARE_REQUEST') {
  (async () => {
    const { store, store_key, title } = msg.payload || {};
    // Try UPC one-shot first (fast path)
    let data = await apiCompareByUPC(store, store_key || '');
    if (!data?.asin) {
      // Fallback to the old 2-step path
      const r = await apiResolve({ store, store_key, title });
      if (!r?.asin) return sendResponse({ results: [], asin: null });
      const c = await apiCompareByASIN(r.asin);
      return sendResponse({ results: c.results || [], asin: r.asin });
    }
    sendResponse({ results: data.results || [], asin: data.asin || null });
  })();
  return true;
}

  // New: record a price observation into backend
  if (msg?.type === 'OBSERVE_PRICE') {
    (async () => {
      const ok = await apiObserve(msg.payload || {});
      sendResponse({ ok });
    })();
    return true;
  }
});
