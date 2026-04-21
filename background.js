const API_BASES = ["https://pricecheck-extension.onrender.com"];
const SITE_BASE = "https://www.pricechecktool.com";
const INSTALL_LANDING_KEY = "pc_install_landing_opened_v1";

// Initialize side panel behavior
if (chrome.sidePanel?.setPanelBehavior) {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: false })
    .catch((e) => console.log("[pc:bg] setPanelBehavior failed", String(e)));
} else {
  console.log("[pc:bg] chrome.sidePanel API unavailable");
}

if (chrome.sidePanel?.setOptions) {
  chrome.sidePanel
    .setOptions({ enabled: false })
    .catch((e) => console.log("[pc:bg] disable default side panel failed", String(e)));
}

// Set uninstall URL
try {
  const v = chrome.runtime.getManifest().version;
  const url =
    `${SITE_BASE}/uninstall` +
    `?utm_source=extension&utm_medium=uninstall&utm_campaign=uninstall` +
    `&v=${encodeURIComponent(v)}`;
  chrome.runtime.setUninstallURL(url);
} catch (e) {
  console.log("[pc:bg] uninstall url failed", String(e));
}

// Handle installation
chrome.runtime.onInstalled.addListener((details) => {
  chrome.storage.local.get([INSTALL_LANDING_KEY], (st) => {
    if (details?.reason === "install" && !(st && st[INSTALL_LANDING_KEY])) {
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
    }
  });
});

async function openPanelForTab(tabLike = null) {
  if (!chrome.sidePanel?.open) {
    console.log("[pc:bg] sidePanel.open unavailable");
    return { ok: false, error: "sidepanel_open_unavailable" };
  }

  const tab =
    tabLike?.id
      ? tabLike
      : await getActiveTabForCurrentWindow();

  if (!tab?.id) {
    console.log("[pc:bg] openPanelForTab: no active tab id");
    return { ok: false, error: "no_active_tab" };
  }

  const sourceUrl = String(tab.url || "").trim();
  const supported = isCoreStore(sourceUrl);

  const prepPromise = Promise.all([
    setPanelEnabled(tab.id, true),
    applyPanelOptions(tab.id, true),
    setPanelState(tab.id, {
      mode: supported ? "loading" : "unsupported",
      sourceUrl,
      url: supported ? "" : `${SITE_BASE}/`,
    }),
  ]).catch((e) => {
    console.log("[pc:bg] openPanelForTab prep failed", String(e));
  });

  await chrome.sidePanel.open({ tabId: tab.id });

  await prepPromise;

  clearSyncTabUrl(tab.id);

  if (supported) {
    syncPanelForTab(tab).catch((e) =>
      console.log("[pc:bg] openPanelForTab sync failed", String(e))
    );
  }

  return { ok: true, tabId: tab.id };
}

chrome.action.onClicked.addListener((clickedTab) => {
  openPanelForTab(clickedTab).catch((e) => {
    console.log("[pc:bg] action click failed", String(e));
  });
});

// Check if URL is from a supported store
function isCoreStore(url = "") {
  try {
    const host = new URL(String(url || "")).hostname.toLowerCase();
    return (
      host === "amazon.com" || host.endsWith(".amazon.com") ||
      host === "target.com" || host.endsWith(".target.com") ||
      host === "walmart.com" || host.endsWith(".walmart.com") ||
      host === "bestbuy.com" || host.endsWith(".bestbuy.com")
    );
  } catch {
    return false;
  }
}

// Check if URL is a valid web URL
function isWebUrl(url = "") {
  return /^https?:\/\//i.test(String(url || ""));
}

function compareStoreKey(s = "") {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

// Track last sync URLs per tab
const LAST_SYNC_URL_BY_TAB = new Map();

function shouldSyncTabUrl(tabId, url = "") {
  const next = String(url || "").trim();
  if (!next) return false;

  const prev = LAST_SYNC_URL_BY_TAB.get(tabId);
  if (prev === next) return false;

  LAST_SYNC_URL_BY_TAB.set(tabId, next);
  return true;
}

function clearSyncTabUrl(tabId) {
  LAST_SYNC_URL_BY_TAB.delete(tabId);
}

// Panel state management
function panelStateKey(tabId) {
  return `pc_panel_state_${tabId}`;
}

function panelEnabledKey(tabId) {
  return `pc_panel_enabled_${tabId}`;
}

async function setPanelEnabled(tabId, enabled) {
  const key = panelEnabledKey(tabId);
  if (enabled) {
    await chrome.storage.local.set({ [key]: true });
  } else {
    await chrome.storage.local.remove([key]);
  }
}

async function isPanelEnabled(tabId) {
  const key = panelEnabledKey(tabId);
  const st = await chrome.storage.local.get([key]);
  return !!st?.[key];
}

async function applyPanelOptions(tabId, enabled) {
  if (!chrome.sidePanel?.setOptions || !tabId) return;

  if (enabled) {
    await chrome.sidePanel.setOptions({
      tabId,
      path: "sidepanel.html",
      enabled: true,
    });
  } else {
    await chrome.sidePanel.setOptions({
      tabId,
      enabled: false,
    });
  }
}

async function closeAnySidePanelForTab(tab) {
  if (!chrome.sidePanel?.close || !tab) return;

  if (tab.id) {
    try {
      await chrome.sidePanel.close({ tabId: tab.id });
    } catch (e) {
      console.log("[pc:bg] sidePanel.close(tabId) failed", String(e));
    }
  }

  if (tab.windowId != null) {
    try {
      await chrome.sidePanel.close({ windowId: tab.windowId });
    } catch (e) {
      console.log("[pc:bg] sidePanel.close(windowId) failed", String(e));
    }
  }
}

function buildPanelState({ mode = "loading", sourceUrl = "", url = "" } = {}) {
  return {
    mode: String(mode || "loading").trim() || "loading",
    sourceUrl: String(sourceUrl || "").trim(),
    url: String(url || `${SITE_BASE}/`).trim() || `${SITE_BASE}/`,
    updatedAt: Date.now(),
  };
}

async function setPanelState(tabId, { mode = "loading", sourceUrl = "", url = "" } = {}) {
  const key = panelStateKey(tabId);
  const state = buildPanelState({ mode, sourceUrl, url });
  await chrome.storage.local.set({ [key]: state });
  return state;
}

async function getPanelState(tabId) {
  const key = panelStateKey(tabId);
  const st = await chrome.storage.local.get([key]);
  return st?.[key] || null;
}

async function removePanelState(tabId) {
  const key = panelStateKey(tabId);
  await chrome.storage.local.remove([key]);
}

async function getActiveTabForCurrentWindow() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs?.[0] || null;
}

// Client ID for API tracking
let __CLIENT_ID = null;

async function getClientId() {
  if (__CLIENT_ID) return __CLIENT_ID;

  const stored = await chrome.storage.local.get(["pc_client_id"]);
  if (stored?.pc_client_id) {
    __CLIENT_ID = stored.pc_client_id;
    return __CLIENT_ID;
  }

  const id =
    (crypto?.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)) +
    "-" +
    Date.now();

  await chrome.storage.local.set({ pc_client_id: id });
  __CLIENT_ID = id;
  return __CLIENT_ID;
}

// Fetch JSON with timeout
async function fetchJSON(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    console.log("[pc:bg] fetch timeout after 12s:", url);
    controller.abort("timeout");
  }, 12000);

  const method = (opts.method || "GET").toUpperCase();
  const baseHeaders =
    method === "GET"
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

    if (!res.ok) {
      console.log("[pc:bg] fetch failed - not ok:", res.status);
      return null;
    }
    if (!text) {
      console.log("[pc:bg] fetch failed - empty response");
      return null;
    }

    try {
      const json = JSON.parse(text);
      console.log("[pc:bg] fetch parsed successfully");
      return json;
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

// API calls for price comparison
async function apiCompareByASIN(asin) {
  const a = String(asin || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(a)) return { results: [] };

  const qs = new URLSearchParams({ asin: a }).toString();
  for (const base of API_BASES) {
    const url = `${base.replace(/\/+$/, "")}/v1/compare?${qs}`;
    const data = await fetchJSON(url);
    if (data && Array.isArray(data.results)) return data;
  }
  return { results: [] };
}

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

async function apiCompareByURL(url) {
  const raw = String(url || "").trim();
  if (!raw) return { results: [] };

  const qs = new URLSearchParams({ url: raw }).toString();

  for (const base of API_BASES) {
    const endpoint = `${base.replace(/\/+$/, "")}/v1/compare_by_url?${qs}`;
    const data = await fetchJSON(endpoint);
    if (data && Array.isArray(data.results)) return data;
  }

  return { results: [] };
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
    if (data && data.ok) return data;
  }
  return null;
}

// Utility: slugify text
function slugify(s) {
  return (
    String(s || "")
      .trim()
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/-+/g, "-") || "product"
  );
}

// Parsers for different stores
function parseAmazonAsin(url = "") {
  return (
    String(url).match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?]|$)/i)?.[1]?.toUpperCase() || ""
  );
}

function parseTargetTcin(url = "") {
  try {
    const u = new URL(url);
    const pre = (u.searchParams.get("preselect") || "").trim();
    if (/^\d{8}$/.test(pre)) return pre;

    const tcin = (u.searchParams.get("tcin") || "").trim();
    if (/^\d{8}$/.test(tcin)) return tcin;
  } catch {}

  return String(url).match(/\/-\/A-(\d{8})(?:\b|\/|\?|#)/i)?.[1] || "";
}

function parseWalmartItemId(url = "") {
  try {
    const u = new URL(url);
    const qp = (u.searchParams.get("itemId") || "").trim();
    if (/^\d{6,20}$/.test(qp)) return qp;
  } catch {}

  return String(url).match(/\/ip\/(?:[^/]+\/)?([0-9]{6,20})(?:$|[/?#])/i)?.[1] || "";
}

function parseBestBuySku(url = "") {
  const s = String(url || "");
  return (
    s.match(/[?&]skuId=(\d{4,10})(?:&|$)/i)?.[1] ||
    s.match(/\/(\d{4,10})\.p(?:\?|$)/i)?.[1] ||
    ""
  );
}

function firstPci(results = []) {
  return String(results.find((r) => r && r.pci)?.pci || "").trim();
}

function dashboardUrlFromResolved({ pci, fallbackKind, fallbackValue, title }) {
  const slug = slugify(title);

  if (pci) {
    return `${SITE_BASE}/dashboard/${slug}/pci/${encodeURIComponent(pci)}/`;
  }

  if (fallbackKind && fallbackValue) {
    return `${SITE_BASE}/dashboard/${slug}/${fallbackKind}/${encodeURIComponent(fallbackValue)}/`;
  }

  return `${SITE_BASE}/browse/`;
}

async function resolveDashboardTarget(tab, observePayload = null) {
  const url = String(tab?.url || "");
  const observedStore = String(observePayload?.store || "").trim().toLowerCase();
  const observedSkuRaw = String(observePayload?.store_sku || "").trim();

  const observedAmazonAsin =
    observedStore === "amazon" && /^[A-Z0-9]{10}$/i.test(observedSkuRaw)
      ? observedSkuRaw.toUpperCase()
      : "";

  const observedTargetTcin =
    observedStore === "target" && /^\d{8}$/.test(observedSkuRaw)
      ? observedSkuRaw
      : "";

  const observedWalmartItemId =
    observedStore === "walmart" && /^\d{6,20}$/.test(observedSkuRaw)
      ? observedSkuRaw
      : "";

  const observedBestBuySku =
    observedStore === "bestbuy" && /^\d{4,10}$/.test(observedSkuRaw)
      ? observedSkuRaw
      : "";

  if (/amazon\./i.test(url)) {
    const asin = observedAmazonAsin || parseAmazonAsin(url);
    if (!asin) {
      return { mode: "unsupported", pci: "", fallbackKind: "", fallbackValue: "" };
    }

    const data = await apiCompareByASIN(asin);
    const results = Array.isArray(data?.results) ? data.results : [];
    if (!results.length) {
      return { mode: "unsupported", pci: "", fallbackKind: "", fallbackValue: "" };
    }

    return {
      mode: "dashboard",
      pci: firstPci(results),
      fallbackKind: "asin",
      fallbackValue: asin,
    };
  }

  if (/target\./i.test(url)) {
    const tcin = observedTargetTcin || parseTargetTcin(url);
    if (!tcin) {
      return { mode: "unsupported", pci: "", fallbackKind: "", fallbackValue: "" };
    }

    const data = await apiCompareByStoreSKU("target", tcin);
    const results = Array.isArray(data?.results) ? data.results : [];
    if (!results.length) {
      return { mode: "unsupported", pci: "", fallbackKind: "", fallbackValue: "" };
    }

    return {
      mode: "dashboard",
      pci: firstPci(results),
      fallbackKind: "tcin",
      fallbackValue: tcin,
    };
  }

  if (/walmart\./i.test(url)) {
    const wal = observedWalmartItemId || parseWalmartItemId(url);
    if (!wal) {
      return { mode: "unsupported", pci: "", fallbackKind: "", fallbackValue: "" };
    }

    const data = await apiCompareByStoreSKU("walmart", wal);
    const results = Array.isArray(data?.results) ? data.results : [];
    if (!results.length) {
      return { mode: "unsupported", pci: "", fallbackKind: "", fallbackValue: "" };
    }

    return {
      mode: "dashboard",
      pci: firstPci(results),
      fallbackKind: "wal",
      fallbackValue: wal,
    };
  }

  if (/bestbuy\./i.test(url)) {
  const bby = observedBestBuySku || parseBestBuySku(url);
  if (!bby) {
    return { mode: "unsupported", pci: "", fallbackKind: "", fallbackValue: "" };
  }

  const data = await apiCompareByStoreSKU("bestbuy", bby);
  const results = Array.isArray(data?.results) ? data.results : [];
  if (!results.length) {
    return { mode: "unsupported", pci: "", fallbackKind: "", fallbackValue: "" };
  }

  return {
    mode: "dashboard",
    pci: firstPci(results),
    fallbackKind: "bby",
    fallbackValue: bby,
  };
}

  if (isWebUrl(url)) {
    const data = await apiCompareByURL(url);
    const results = Array.isArray(data?.results) ? data.results : [];
    const pci = firstPci(results);

    if (results.length && pci) {
      return {
        mode: "dashboard",
        pci,
        fallbackKind: "",
        fallbackValue: "",
      };
    }

    return {
      mode: "unsupported",
      pci: "",
      fallbackKind: "",
      fallbackValue: "",
    };
  }

  return {
    mode: "unsupported",
    pci: "",
    fallbackKind: "",
    fallbackValue: "",
  };
}

async function checkMatchForTab(tabLike = null) {
  const tab =
    tabLike?.id
      ? tabLike
      : await getActiveTabForCurrentWindow();

  if (!tab?.id || !tab?.url) {
    return { ok: false, matched: false, reason: "no_active_tab", otherStores: [] };
  }

  const sourceUrl = String(tab.url || "").trim();
  if (!isCoreStore(sourceUrl)) {
    return { ok: true, matched: false, reason: "unsupported_site", otherStores: [] };
  }

  const observePayload = await scrapeObservePayload(tab.id).catch(() => null);

  const currentStore =
    compareStoreKey(observePayload?.store) ||
    (sourceUrl.includes("amazon.") ? "amazon" :
     sourceUrl.includes("target.") ? "target" :
     sourceUrl.includes("walmart.") ? "walmart" :
     sourceUrl.includes("bestbuy.") ? "bestbuy" : "");

  let data = { results: [] };

  if (currentStore === "amazon") {
    const asin =
      (/^[A-Z0-9]{10}$/i.test(String(observePayload?.store_sku || "").trim())
        ? String(observePayload.store_sku).trim().toUpperCase()
        : parseAmazonAsin(sourceUrl));

    if (!asin) {
      return { ok: true, matched: false, reason: "missing_anchor", otherStores: [] };
    }

    data = await apiCompareByASIN(asin);
  } else if (currentStore === "target") {
    const tcin =
      (/^\d{8}$/.test(String(observePayload?.store_sku || "").trim())
        ? String(observePayload.store_sku).trim()
        : parseTargetTcin(sourceUrl));

    if (!tcin) {
      return { ok: true, matched: false, reason: "missing_anchor", otherStores: [] };
    }

    data = await apiCompareByStoreSKU("target", tcin);
  } else if (currentStore === "walmart") {
    const itemId =
      (/^\d{6,20}$/.test(String(observePayload?.store_sku || "").trim())
        ? String(observePayload.store_sku).trim()
        : parseWalmartItemId(sourceUrl));

    if (!itemId) {
      return { ok: true, matched: false, reason: "missing_anchor", otherStores: [] };
    }

    data = await apiCompareByStoreSKU("walmart", itemId);
  } else if (currentStore === "bestbuy") {
    const sku =
      (/^\d{4,10}$/.test(String(observePayload?.store_sku || "").trim())
        ? String(observePayload.store_sku).trim()
        : parseBestBuySku(sourceUrl));

    if (!sku) {
      return { ok: true, matched: false, reason: "missing_anchor", otherStores: [] };
    }

    data = await apiCompareByStoreSKU("bestbuy", sku);
  } else {
    return { ok: true, matched: false, reason: "unsupported_site", otherStores: [] };
  }

  const results = Array.isArray(data?.results) ? data.results : [];

  const otherStores = [
    ...new Set(
      results
        .map((r) => compareStoreKey(r?.store))
        .filter((store) => store && store !== currentStore)
    )
  ];

  return {
    ok: true,
    matched: otherStores.length > 0,
    reason: otherStores.length > 0 ? "cross_store_match" : "no_cross_store_match",
    otherStores,
    resultCount: results.length,
  };
}

// Scrape observe payload from content script
async function scrapeObservePayload(tabId) {
  for (const waitMs of [0, 350, 900]) {
    if (waitMs) {
      await new Promise((r) => setTimeout(r, waitMs));
    }

    try {
      const resp = await chrome.tabs.sendMessage(tabId, { type: "PC_SCRAPE_OBSERVE" });
      if (resp?.ok && resp?.payload) return resp.payload;
      console.log("[pc:bg] scrape payload unavailable", { waitMs, resp });
    } catch (e) {
      console.log("[pc:bg] scrape message failed", { waitMs, err: String(e) });
    }
  }

  return null;
}

async function syncPanelForTab(tab) {
  try {
    if (!tab?.id) {
      console.log("[pc:bg] syncPanelForTab: no tab id");
      return;
    }
    if (!tab?.url) {
      console.log("[pc:bg] syncPanelForTab: no tab url");
      return;
    }

    const sourceUrl = String(tab.url || "").trim();
    const supported = isCoreStore(sourceUrl);
    console.log("[pc:bg] syncPanelForTab starting for:", sourceUrl, "supported:", supported);

    if (!chrome.sidePanel?.setOptions) {
      console.log("[pc:bg] sidePanel API unavailable during sync");
      return;
    }

    const panelEnabled = await isPanelEnabled(tab.id);
    if (!panelEnabled) {
      await applyPanelOptions(tab.id, false);
      return;
    }

    await applyPanelOptions(tab.id, true);

    if (!supported) {
      console.log("[pc:bg] page not supported, showing unsupported");
      await setPanelState(tab.id, {
        mode: "unsupported",
        sourceUrl,
        url: `${SITE_BASE}/`,
      });
      return;
    }

    await setPanelState(tab.id, {
      mode: "loading",
      sourceUrl,
      url: "",
    });

    console.log("[pc:bg] scraping product data...");
    const observePayload = await scrapeObservePayload(tab.id);
    console.log("[pc:bg] scrape result:", observePayload);

    const observedStore = String(observePayload?.store || "").trim().toLowerCase();
    const observedSku = String(observePayload?.store_sku || "").trim();

    let fallbackKind = "";
    let fallbackValue = "";

    if (/amazon\./i.test(sourceUrl)) {
      fallbackKind = "asin";
      fallbackValue =
        observedStore === "amazon" && /^[A-Z0-9]{10}$/i.test(observedSku)
          ? observedSku.toUpperCase()
          : parseAmazonAsin(sourceUrl);
    } else if (/target\./i.test(sourceUrl)) {
      fallbackKind = "tcin";
      fallbackValue =
        observedStore === "target" && /^\d{8}$/.test(observedSku)
          ? observedSku
          : parseTargetTcin(sourceUrl);
    } else if (/walmart\./i.test(sourceUrl)) {
      fallbackKind = "wal";
      fallbackValue =
        observedStore === "walmart" && /^\d{6,20}$/.test(observedSku)
          ? observedSku
          : parseWalmartItemId(sourceUrl);
    } else if (/bestbuy\./i.test(sourceUrl)) {
      fallbackKind = "bby";
      fallbackValue =
        observedStore === "bestbuy" && /^\d{4,10}$/.test(observedSku)
          ? observedSku
          : parseBestBuySku(sourceUrl);
    }

    console.log("[pc:bg] fallback values:", { fallbackKind, fallbackValue });

    // Observe first so brand new products still get inserted.
    if (
      observePayload &&
      observePayload.store &&
      observePayload.store_sku &&
      Number.isFinite(observePayload.price_cents)
    ) {
      try {
        console.log("[pc:bg] sending observe payload before resolve...");
        const observeResp = await apiObserve(observePayload);
        if (observeResp) console.log("[pc:bg] observe result", observeResp);
      } catch (e) {
        console.log("[pc:bg] observe failed", String(e));
      }
    } else if (observePayload) {
      console.log("[pc:bg] skipping observe - no price data");
    } else {
      console.log("[pc:bg] no observe payload at all");
    }

    let resolved = null;

    try {
      console.log("[pc:bg] resolving dashboard target...");
      resolved = await resolveDashboardTarget(tab, observePayload);
      console.log("[pc:bg] resolve result:", resolved);
    } catch (e) {
      console.log("[pc:bg] resolve failed with error:", String(e));
      resolved = null;
    }

    // Never show unsupported on the 4 supported stores.
    if (!resolved || resolved.mode === "unsupported") {
      console.log("[pc:bg] no dashboard match after observe, showing manual sidebar page");
      await setPanelState(tab.id, {
        mode: "iframe",
        sourceUrl,
        url: `${SITE_BASE}/`,
      });
      return;
    }

    const finalUrl = dashboardUrlFromResolved({
      pci: resolved?.pci || "",
      fallbackKind: resolved?.fallbackKind || fallbackKind,
      fallbackValue: resolved?.fallbackValue || fallbackValue,
      title: tab.title || "product",
    });

    console.log("[pc:bg] loading dashboard URL:", finalUrl);
    await setPanelState(tab.id, {
      mode: "iframe",
      sourceUrl,
      url: finalUrl,
    });
  } catch (e) {
    console.log("[pc:bg] syncPanelForTab crashed:", String(e));

    try {
      if (tab?.id) {
        const sourceUrl = String(tab.url || "").trim();
        const supported = isCoreStore(sourceUrl);

        await setPanelState(tab.id, {
          mode: supported ? "iframe" : "unsupported",
          sourceUrl,
          url: `${SITE_BASE}/`,
        });
      }
    } catch (e2) {
      console.log("[pc:bg] failed to set fallback state:", String(e2));
    }
  }
}

// Message handlers
async function syncActiveTabNow() {
  const tab = await getActiveTabForCurrentWindow();
  if (!tab?.id || !tab?.url) {
    return { ok: false, error: "no_active_tab" };
  }

  clearSyncTabUrl(tab.id);
  await syncPanelForTab(tab);

  const state = await getPanelState(tab.id);
  return {
    ok: true,
    tabId: tab.id,
    state: state || buildPanelState({ mode: "unsupported", sourceUrl: String(tab.url || ""), url: `${SITE_BASE}/` }),
  };
}

async function readActiveTabState() {
  const tab = await getActiveTabForCurrentWindow();
  if (!tab?.id) {
    return { ok: false, error: "no_active_tab" };
  }

  const enabled = await isPanelEnabled(tab.id);
  if (!enabled) {
    return {
      ok: true,
      tabId: tab.id,
      state: buildPanelState({
        mode: "unsupported",
        sourceUrl: String(tab.url || ""),
        url: `${SITE_BASE}/`,
      }),
    };
  }

  const sourceUrl = String(tab.url || "").trim();
  const supported = isCoreStore(sourceUrl);
  const state = await getPanelState(tab.id);

  return {
    ok: true,
    tabId: tab.id,
    state:
      state ||
      buildPanelState({
        mode: supported ? "loading" : "unsupported",
        sourceUrl,
        url: `${SITE_BASE}/`,
      }),
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg?.type) return;

  (async () => {
    if (msg.type === "PC_SYNC_ACTIVE_PANEL_STATE") {
      return await syncActiveTabNow();
    }

    if (msg.type === "PC_READ_ACTIVE_PANEL_STATE") {
      return await readActiveTabState();
    }

    if (msg.type === "PC_CHECK_MATCH_FOR_TAB") {
      const senderTab = sender?.tab?.id ? sender.tab : null;
      return await checkMatchForTab(senderTab);
    }

    if (msg.type === "PC_OPEN_SIDEPANEL_FOR_TAB") {
      const senderTab = sender?.tab?.id ? sender.tab : null;
      return await openPanelForTab(senderTab);
    }

    if (msg.type === "PC_OPEN_MANUAL_SEARCH") {
      const senderTab = sender?.tab?.id ? sender.tab : await getActiveTabForCurrentWindow();
      if (!senderTab?.id) return { ok: false, error: "no_active_tab" };

      await setPanelEnabled(senderTab.id, true);
      await applyPanelOptions(senderTab.id, true);

      const next = String(msg.url || `${SITE_BASE}/`).trim() || `${SITE_BASE}/`;
      const state = await setPanelState(senderTab.id, {
        mode: "iframe",
        sourceUrl: String(senderTab.url || ""),
        url: next,
      });

      return { ok: true, tabId: senderTab.id, state };
    }

    return { ok: false, error: "unknown_message" };
  })()
    .then((resp) => sendResponse(resp))
    .catch((e) => sendResponse({ ok: false, error: String(e) }));

  return true;
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (!tab?.id) return;

  try {
    const panelEnabled = await isPanelEnabled(tabId);

    if (!panelEnabled) {
      await applyPanelOptions(tabId, false);

      if (tab.active) {
        await closeAnySidePanelForTab(tab);
      }
      return;
    }

    const sourceUrl = String(tab.url || "").trim();
    if (!sourceUrl) {
      if (tab.active) {
        await applyPanelOptions(tabId, false);
        await closeAnySidePanelForTab(tab);
      }
      return;
    }

    if (info.status !== "complete") return;
    if (!shouldSyncTabUrl(tabId, sourceUrl)) return;

    await syncPanelForTab(tab);
  } catch (e) {
    console.log("[pc:bg] onUpdated sync failed", String(e));
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab?.id) return;

    const panelEnabled = await isPanelEnabled(tabId);

    if (!panelEnabled) {
      await applyPanelOptions(tabId, false);
      await closeAnySidePanelForTab(tab);
      return;
    }

    const sourceUrl = String(tab.url || "").trim();
    if (!sourceUrl) {
      await applyPanelOptions(tabId, false);
      await closeAnySidePanelForTab(tab);
      return;
    }

    await applyPanelOptions(tabId, true);

    const state = await getPanelState(tabId);

    if (!state) {
      clearSyncTabUrl(tabId);
      await syncPanelForTab(tab);
      return;
    }

    if (String(state.sourceUrl || "").trim() !== sourceUrl) {
      clearSyncTabUrl(tabId);
      await syncPanelForTab(tab);
      return;
    }
  } catch (e) {
    console.log("[pc:bg] onActivated sync failed", String(e));
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clearSyncTabUrl(tabId);

  removePanelState(tabId).catch((e) => {
    console.log("[pc:bg] remove panel state failed", String(e));
  });

  setPanelEnabled(tabId, false).catch((e) => {
    console.log("[pc:bg] remove panel enabled failed", String(e));
  });
});