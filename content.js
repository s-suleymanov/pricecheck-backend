// content.js - unified multi-site, hardened singleton, ASIN or store_sku flow
(() => {
  "use strict";

  const ROOT_ID = "pricecheck-sidebar-root";

  // Re-entry guard
  if (globalThis.__PC_INIT_DONE__) {
    try {
      if (!globalThis.__PC_MSG_BOUND__) {
        chrome.runtime?.onMessage.addListener((m) => {
          if (m?.type === "TOGGLE_SIDEBAR") globalThis.__PC_SINGLETON__?.toggle();
        });
        globalThis.__PC_MSG_BOUND__ = true;
      }
    } catch {}
    return;
  }
  globalThis.__PC_INIT_DONE__ = true;

  // ---------- utils ----------
  const hasChrome = () => typeof chrome !== "undefined" && chrome?.runtime?.id;
  const safeSet = async (kv) => { try { if (hasChrome()) await chrome.storage.local.set(kv); } catch {} };
  const safeSend = (msg) => new Promise((res) => { try { chrome.runtime.sendMessage(msg, (r) => res(r)); } catch { res(null); } });
  const clean = (s = "") => s.replace(/[\u200E\u200F\u202A-\u202E]/g, "").replace(/\s+/g, " ").trim();

  const siteOf = (h = location.hostname) => {
    if (/amazon\./i.test(h)) return "amazon";
    if (/target\.com$/i.test(h) || /\.target\.com$/i.test(h)) return "target";
    if (/walmart\.com$/i.test(h) || /\.walmart\.com$/i.test(h)) return "walmart";
    if (/bestbuy\.com$/i.test(h) || /\.bestbuy\.com$/i.test(h)) return "bestbuy";
    return "unknown";
  };

  function normalizeStoreKey(store, key) {
    if (!key) return "";
    const s = String(store || "").toLowerCase();
    let k = String(key || "").trim();
    if (s === "target") {
      k = k.replace(/^A[-\s]?/i, "");   // A-12345678 -> 12345678
      k = k.replace(/[^0-9A-Z]/g, "");  // keep digits/letters
    } else if (s === "walmart" || s === "bestbuy") {
      k = k.replace(/\D+/g, "");        // digits only
    }
    return k;
  }

  // price helper
  const toCents = (txt = "") => {
    const n = parseFloat(String(txt).replace(/[^0-9.]/g, ""));
    return isNaN(n) ? null : Math.round(n * 100);
  };

  // ---------- drivers per site ----------
  const DRIVERS = {
    amazon: {
      store: "Amazon",
      getTitle() {
        return clean(
          document.getElementById("productTitle")?.innerText ||
          document.querySelector("#title span")?.innerText || ""
        );
      },
      getVariantLabel() {
  // 1) Try DOM-first (covers old + new twister UIs)
  const pieces = [];
  const domSelectors = [
    // new button-style twister
    '#twister .a-button-selected .a-button-text',
    '#inline-twister-expander-content .a-button-selected .a-button-text',
    // classic "selection" line
    '#variation_color_name .selection',
    '#variation_size_name .selection',
    '#variation_style_name .selection',
    '#variation_configuration .selection',
    '#variation_pattern_name .selection'
  ];
  for (const sel of domSelectors) {
    const el = document.querySelector(sel);
    const t = el && el.textContent && el.textContent.trim();
    if (t && !/^(Select|Choose)$/i.test(t) && !pieces.includes(t)) pieces.push(t);
  }
  if (pieces.length) return pieces.join(' ');

  // 2) Fallback: parse page scripts for variationValues + selectedVariationValues
  function tryParseWholeJSON(text) {
    const t = (text || '').trim();
    if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
      try { return JSON.parse(t); } catch { return null; }
    }
    return null;
  }
  function extractObjectForKey(text, key) {
    const idx = text.indexOf(key);
    if (idx === -1) return null;
    let i = text.indexOf('{', idx);
    if (i === -1) return null;
    let depth = 0, start = i, end = -1, inStr = false, esc = false;
    for (; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
      } else {
        if (ch === '"') inStr = true;
        else if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
      }
    }
    if (start >= 0 && end > start) {
      try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
    }
    return null;
  }

  let variationValues = null;
  let selectedVariationValues = null;

  for (const sc of document.querySelectorAll('script')) {
    const text = sc.textContent || '';
    if (!variationValues && text.includes('"variationValues"')) {
      const whole = tryParseWholeJSON(text);
      if (whole?.variationValues && typeof whole.variationValues === 'object') {
        variationValues = whole.variationValues;
      } else {
        const obj = extractObjectForKey(text, '"variationValues"');
        if (obj && typeof obj === 'object') variationValues = obj;
      }
    }
    if (!selectedVariationValues && text.includes('"selectedVariationValues"')) {
      const whole = tryParseWholeJSON(text);
      if (whole?.selectedVariationValues && typeof whole.selectedVariationValues === 'object') {
        selectedVariationValues = whole.selectedVariationValues;
      } else {
        const obj = extractObjectForKey(text, '"selectedVariationValues"');
        if (obj && typeof obj === 'object') selectedVariationValues = obj;
      }
    }
    if (variationValues && selectedVariationValues) break;
  }

  if (variationValues && selectedVariationValues) {
    const out = [];
    for (const dim of Object.keys(variationValues)) {
      const arr = variationValues[dim];
      const idx = parseInt(selectedVariationValues[dim], 10);
      if (Array.isArray(arr) && arr.length > 1 && Number.isFinite(idx)) {
        const val = String(arr[idx] ?? '').trim();
        if (val && !/^(Select|Choose)$/i.test(val)) out.push(val);
      }
    }
    if (out.length) return out.join(' ');
  }

  return '';
},
      getPriceCents() {
        const sels = [
          "#corePrice_feature_div .a-offscreen",
          ".priceToPay .a-offscreen",
          "#price .a-offscreen",
          "#price_inside_buybox",
          "[data-a-color='price'] .a-offscreen",
          ".a-price .a-offscreen"
        ];
        for (const sel of sels) {
          const el = document.querySelector(sel);
          if (el?.innerText) {
            const cents = toCents(el.innerText);
            if (cents != null) return cents;
          }
        }
        return null;
      },
      getASIN() {
        const fromUrl = location.pathname.match(/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?]|$)/i)?.[1];
        const fromAttr = document.querySelector("[data-asin]")?.getAttribute("data-asin");
        return (fromUrl || fromAttr || "").toUpperCase() || null;
      },
      getStoreKey() { return null; },
      productKey() { return `${this.getASIN() || ""}|${location.pathname}`; }
    },

    target: {
      store: "Target",
      getTitle() {
        return clean(document.querySelector('h1[data-test="product-title"]')?.innerText || document.title);
      },
      getPriceCents() {
        const sels = [
          '[data-test="product-price"]',
          '[data-test="offer-price"]',
          '[data-test^="price"]',
          'meta[itemprop="price"]'
        ];
        for (const sel of sels) {
          const el = document.querySelector(sel);
          const raw = el?.getAttribute?.("content") || el?.textContent || "";
          const cents = toCents(raw);
          if (cents != null) return cents;
        }
        return null;
      },
      getASIN() { return null; },
      getStoreKey() {
        // Prefer TCIN, normalize to digits/letters only
        const mPath = location.pathname.match(/\/A-([0-9A-Z]+)/i)?.[1];
        const mMeta = document.querySelector('meta[name="twitter:app:url:iphone"]')?.content?.match(/\/A-([0-9A-Z]+)/i)?.[1];
        const mText = document.body.innerText.match(/\bTCIN\s*[:#]?\s*([0-9A-Z]{5,})/i)?.[1];
        const tcinRaw = mPath || mMeta || mText || null;
        if (tcinRaw) return normalizeStoreKey("Target", tcinRaw);

        // Fallback UPC from ld+json or page text
        for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
          try {
            const j = JSON.parse(s.textContent.trim());
            const gtin = j?.gtin13 || j?.gtin12 || j?.sku;
            if (gtin && /^\d{12,13}$/.test(gtin)) {
              return gtin.length === 13 && gtin.startsWith("0") ? gtin.slice(1) : gtin;
            }
          } catch {}
        }
        const m = document.body.innerText.match(/(^|[^\d])(\d{12,13})(?!\d)/);
        if (m) return m[2].length === 13 && m[2].startsWith("0") ? m[2].slice(1) : m[2];
        return null;
      },
      productKey() { return `${this.getStoreKey() || ""}|${location.pathname}`; }
    },

    walmart: {
      store: "Walmart",
      getTitle() { return clean(document.querySelector("h1")?.innerText || document.title); },
      getPriceCents() {
        const el = document.querySelector('[itemprop="price"]') ||
                   document.querySelector('[data-automation-id="product-price"]') ||
                   document.querySelector('meta[itemprop="price"]');
        const raw = el?.getAttribute?.("content") || el?.textContent || "";
        return toCents(raw);
      },
      getASIN() { return null; },
      getStoreKey() {
        const m = location.pathname.match(/\/ip\/[^/]+\/(\d+)/);
        if (m) return normalizeStoreKey("Walmart", m[1]); // itemId
        for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
          try { const j = JSON.parse(s.textContent.trim()); if (j?.sku) return normalizeStoreKey("Walmart", String(j.sku)); } catch {}
        }
        const meta = document.querySelector('meta[property="product:retailer_item_id"]')?.content;
        if (meta) return normalizeStoreKey("Walmart", meta);
        return null;
      },
      productKey() { return `${this.getStoreKey() || ""}|${location.pathname}`; }
    },

    bestbuy: {
      store: "BestBuy",
      getTitle() {
        return clean(
          document.querySelector(".sku-title h1")?.innerText ||
          document.querySelector("h1")?.innerText || document.title
        );
      },
      getPriceCents() {
        const el = document.querySelector(".priceView-hero-price span[aria-hidden='true']") ||
                   document.querySelector(".priceView-customer-price span");
        return toCents(el?.innerText || "");
      },
      getASIN() { return null; },
      getStoreKey() {
        const t = document.querySelector(".sku-value")?.innerText || "";
        const m = t.match(/\d+/);
        if (m) return normalizeStoreKey("BestBuy", m[0]);
        const meta = document.querySelector('meta[name="skuId"]')?.content;
        if (meta) return normalizeStoreKey("BestBuy", meta);
        return null;
      },
      productKey() { return `${this.getStoreKey() || ""}|${location.pathname}`; }
    }
  };

  // ---------- assets ----------
  const HTML_URL = chrome.runtime.getURL("content.html");
  const CSS_URL  = chrome.runtime.getURL("content.css");
  const ICONS = {
    target:  chrome.runtime.getURL("icons/target-circle.png"),
    amazon:  chrome.runtime.getURL("icons/amazon.png"),
    walmart: chrome.runtime.getURL("icons/walmart.png"),
    bestbuy: chrome.runtime.getURL("icons/bestbuy.png"),
    default: chrome.runtime.getURL("icons/logo.png")
  };
  const __assetCache = new Map();
  async function loadAsset(url) {
    if (__assetCache.has(url)) return __assetCache.get(url);
    const res = await fetch(url);
    const text = await res.text();
    __assetCache.set(url, text);
    return text;
  }

  // ---------- singleton controller ----------
  const PS = {
    id: ROOT_ID,
    width: 380,
    open: false,
    root: null,
    shadow: null,
    _mo: null,
    _debounceTimer: null,
    _lastKey: null,
    _inflight: null,

    async ensure() {
      // Kill accidental duplicates except the first
      const all = Array.from(document.querySelectorAll(`#${this.id}`));
      for (let i = 1; i < all.length; i++) all[i].remove();

      const existing = document.getElementById(this.id);
      if (existing) {
        this.root = existing;
        this.shadow = existing.shadowRoot;
        return existing;
      }

      const root = document.createElement("div");
      root.id = this.id;
      root.style.all = "initial";
      root.style.position = "fixed";
      root.style.top = "0";
      root.style.left = "0";
      root.style.height = "100%";
      root.style.width = this.width + "px";
      root.style.zIndex = "2147483647";
      root.style.transform = "translateX(-100%)";
      root.style.transition = "transform 160ms ease";
      root.style.willChange = "transform";

      document.documentElement.appendChild(root);
      const sh = root.attachShadow({ mode: "open" });

      const [html, css] = await Promise.all([loadAsset(HTML_URL), loadAsset(CSS_URL)]);
      const style = document.createElement("style");
      style.textContent = css;
      const container = document.createElement("div");
      container.innerHTML = html;
      sh.appendChild(style);
      sh.appendChild(container);

      // close button
      sh.querySelector("#ps-close")?.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); this.close(); });
      // Esc to close
      window.addEventListener("keydown", (e) => { if (this.open && (e.key === "Escape" || e.key === "Esc")) this.close(); });

      const logoEl = sh.querySelector("#ps-logo");
      if (logoEl) logoEl.src = chrome.runtime.getURL("icons/logo.png");

      // resizer
      let resizing = false;
      sh.querySelector("#ps-resize")?.addEventListener("mousedown", (e) => {
        e.preventDefault();
        resizing = true;
        document.documentElement.style.cursor = "ew-resize";
      });
      window.addEventListener("mousemove", (e) => {
        if (!resizing) return;
        const w = Math.min(Math.max(300, e.clientX), Math.min(700, window.innerWidth - 120));
        this.width = w;
        root.style.width = w + "px";
        this.applyPagePush();
      });
      window.addEventListener("mouseup", () => {
        if (!resizing) return;
        resizing = false;
        document.documentElement.style.cursor = "";
      });

      this.root = root;
      this.shadow = sh;
      return root;
    },

    applyPagePush() {
      const html = document.documentElement;
      html.style.transition = "padding-left 160ms ease";
      html.style.willChange = "padding-left";
      if (this.open) {
        html.style.paddingLeft = this.width + "px";
        this.root.style.transform = "translateX(0%)";
      } else {
        html.style.paddingLeft = "0";
        this.root.style.transform = "translateX(-100%)";
      }
    },

       async populate() {
      if (!this.shadow) return;
      const sh = this.shadow;
      const $ = (sel) => sh.querySelector(sel);

      const site = siteOf();
      const D = DRIVERS[site] || DRIVERS.amazon;

      const snap = {
        title: D.getTitle(),
        asin: D.getASIN ? D.getASIN() : null,
        price_cents: D.getPriceCents ? D.getPriceCents() : null,
        store_key: D.getStoreKey ? D.getStoreKey() : null,
        variant_label: D.getVariantLabel ? D.getVariantLabel() : null
      };
      await safeSet({ lastSnapshot: snap });

      sh.querySelector('#ps-variant-val').textContent = (snap.variant_label || '').trim?.() || '';
      const asinEl = sh.querySelector('#ps-asin-val');
      asinEl && (asinEl.textContent = snap.asin || (site === 'amazon' ? 'Not found' : 'Resolving...'));

      // New: send observation to backend (records into price_history)
      // Only if we have a price to record
      if (Number.isFinite(snap.price_cents)) {
        const payload =
          site === 'amazon'
            ? { store: 'Amazon', asin: snap.asin || null, price_cents: snap.price_cents, url: location.href, title: snap.title }
            : { store: D.store, store_sku: snap.store_key || null, price_cents: snap.price_cents, url: location.href, title: snap.title };

        // Fire and forget; backend validates keys
        try { await safeSend({ type: 'OBSERVE_PRICE', payload }); } catch {}
      }

      const resultsEl = $("#ps-results");
      if (!resultsEl) return;
      resultsEl.innerHTML = `<div class="status">Searching...</div>`;

      let list = [];

      if (site === "amazon") {
        if (!snap.asin) { resultsEl.innerHTML = `<div class="status">ASIN not found on this page.</div>`; return; }
        const resp = await safeSend({ type: "COMPARE_REQUEST", payload: { asin: snap.asin } });
        list = Array.isArray(resp?.results) ? resp.results.slice() : [];

        const hasAmazon = list.some(p => (p.store || "").toLowerCase() === "amazon");
        if (!hasAmazon) {
          list.push({ store: "Amazon", product_name: snap.title, price_cents: snap.price_cents, url: location.href });
        }
      } else {
        // Non Amazon - resolve by store_sku
        const resp = await safeSend({
          type: "RESOLVE_COMPARE_REQUEST",
          payload: { store: D.store, store_key: snap.store_key || "", title: snap.title }
        });

        const resolvedASIN = resp?.asin || null;
        if (asinEl) asinEl.textContent = resolvedASIN || "Unknown";

        list = Array.isArray(resp?.results) ? resp.results.slice() : [];

        // Always include current store card
        const alreadySelf = list.some(p => {
          const s1 = (p.store || "").toLowerCase();
          const s2 = (D.store || "").toLowerCase();
          const skuMatches = normalizeStoreKey(D.store, p.store_sku || "") === (snap.store_key || "");
          const urlMatches = p.url && p.url.split("?")[0] === location.href.split("?")[0];
          return s1 === s2 && (skuMatches || urlMatches);
        });
        if (!alreadySelf) {
          list.push({ store: D.store, product_name: snap.title, price_cents: snap.price_cents, url: location.href, notes: null  });
        }

        const hasAmazon = list.some(p => (p.store || "").toLowerCase() === "amazon");
        if (resolvedASIN && !hasAmazon) {
          list.push({
            store: "Amazon",
            product_name: snap.title || "View on Amazon",
            price_cents: null,
            url: `https://www.amazon.com/dp/${resolvedASIN}`
          });
        }

        if (!resolvedASIN) {
          const q = snap.title || snap.store_key || "";
          list.push({
            store: "Amazon",
            product_name: "Search for a match",
            price_cents: null,
            url: `https://www.amazon.com/s?k=${encodeURIComponent(q)}`
          });
        }
      }

      if (list.length === 0) {
        resultsEl.innerHTML = `<div class="status">No prices found.</div>`;
        return;
      }
      resultsEl.innerHTML = "";

      // Sort by price, nulls last
      list.sort((a, b) => (a.price_cents ?? Infinity) - (b.price_cents ?? Infinity));
      const bestPrice = list[0].price_cents ?? Infinity;

      const ICON = (k) => ICONS[k] || ICONS.default;

      for (const p of list) {
        const item = document.createElement("a");
        item.className = "result-card";
        item.href = p.url || "#";
        if (p.url) { item.target = "_blank"; item.rel = "noopener noreferrer"; }
        else item.addEventListener("click", (e) => e.preventDefault());

        const price = Number.isFinite(p.price_cents) ? (p.price_cents / 100).toFixed(2) : "";
        const storeKey = (p.store || "default").toLowerCase();
        const storeIcon = ICON(storeKey);
        const isBest = p.price_cents === bestPrice;
        const noteHtml = p.notes ? `<div class="store-note">${p.notes}</div>` : "";

        item.innerHTML = `
          <div class="store-info">
            <img src="${storeIcon}" alt="${p.store || "Store"} logo" class="store-logo">
            <div class="store-and-product">
              <span class="store-name">${p.store || "Unknown"}</span>
              ${noteHtml}
            </div>
          </div>
          <div class="price-info">
            <span class="price">${price ? `$${price}` : ""}</span>
            ${isBest && storeKey !== "amazon" ? `<span class="savings-tag best-price">Best Price</span>` : ""}
          </div>
        `;

        if (storeKey === "amazon") item.classList.add("current-site");
        resultsEl.appendChild(item);
      }
    },


    async openSidebar() { await this.ensure(); this.open = true; this.applyPagePush(); await this.populate(); },
    close() { if (!this.root) return; this.open = false; this.applyPagePush(); },
    toggle() { this.open ? this.close() : this.openSidebar(); },

    _debounce(fn, wait = 600) { return (...args) => { clearTimeout(this._debounceTimer); this._debounceTimer = setTimeout(() => fn.apply(this, args), wait); }; },
    _productKey() {
      const site = siteOf();
      const D = DRIVERS[site] || DRIVERS.amazon;
      const key = site === "amazon" ? (D.getASIN() || "") : (D.getStoreKey() || "");
      return `${key}|${location.pathname}`;
    },

    async _refreshIfChanged() {
      if (!this.open) return;
      const key = this._productKey();
      if (key === this._lastKey) return;
      this._lastKey = key;

      if (this._inflight && typeof this._inflight.abort === "function") {
        try { this._inflight.abort(); } catch {}
      }
      const ac = typeof AbortController !== "undefined" ? new AbortController() : null;
      this._inflight = ac;

      try { await this.populate(); } catch {}
      finally { this._inflight = null; }
    },

    _bindProductObservers() {
      const debounced = this._debounce(this._refreshIfChanged.bind(this), 600);
      const _pushState = history.pushState;
      if (!_pushState.__pc_wrapped__) {
        history.pushState = function() { _pushState.apply(this, arguments); debounced(); };
        _pushState.__pc_wrapped__ = true;
      }
      window.addEventListener("popstate", debounced);

      const root = document.getElementById("dp-container") || document.body;
      this._mo = new MutationObserver(debounced);
      this._mo.observe(root, { subtree: true, childList: true });

      debounced();
    },

    _bindRuntimeMessage() {
      if (globalThis.__PC_MSG_BOUND__) return;
      chrome.runtime?.onMessage.addListener((m) => { if (m?.type === "TOGGLE_SIDEBAR") this.toggle(); });
      globalThis.__PC_MSG_BOUND__ = true;
    },

    init() {
      this._bindRuntimeMessage();
      this._bindProductObservers();
      window.addEventListener("pageshow", (e) => { if (e.persisted && this.open) this.applyPagePush(); });
      globalThis.__PC_SINGLETON__ = this;
      window.PS = this; // optional debug
    }
  };

  PS.init();
})();
