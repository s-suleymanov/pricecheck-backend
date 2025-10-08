// content.js - unified multi-site, hardened singleton, ASIN or store_sku flow
(() => {
  "use strict";

  const ROOT_ID = "pricecheck-sidebar-root";

  // re-entry guard
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

  // utils
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

  // price helpers
  const toCents = (txt = "") => {
    const n = parseFloat(String(txt).replace(/[^0-9.]/g, ""));
    return isNaN(n) ? null : Math.round(n * 100);
  };

  // drivers per site
  const DRIVERS = {
    amazon: {
      store: "Amazon",
      getTitle() {
        return clean(document.getElementById("productTitle")?.innerText ||
                     document.querySelector("#title span")?.innerText || "");
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
      getStoreKey() { return null; }, // not needed
      productKey() {
        return `${this.getASIN() || ""}|${location.pathname}`;
      }
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
        const mPath = location.pathname.match(/\/A-([0-9A-Z]+)/i)?.[1];
        const mMeta = document.querySelector('meta[name="twitter:app:url:iphone"]')?.content?.match(/\/A-([0-9A-Z]+)/i)?.[1];
        const mText = document.body.innerText.match(/\bTCIN\s*[:#]?\s*([0-9A-Z]{5,})/i)?.[1];
        const tcin = mPath || mMeta || mText || null;
        if (tcin) return tcin;

        // fallback UPC from ld+json or page
        for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
          try {
            const j = JSON.parse(s.textContent.trim());
            const gtin = j?.gtin13 || j?.gtin12 || j?.sku;
            if (gtin && /^\d{12,13}$/.test(gtin)) return gtin.length === 13 && gtin.startsWith("0") ? gtin.slice(1) : gtin;
          } catch {}
        }
        const m = document.body.innerText.match(/(^|[^\d])(\d{12,13})(?!\d)/);
        if (m) return m[2].length === 13 && m[2].startsWith("0") ? m[2].slice(1) : m[2];
        return null;
      },
      productKey() {
        return `${this.getStoreKey() || ""}|${location.pathname}`;
      }
    },

    walmart: {
      store: "Walmart",
      getTitle() { return clean(document.querySelector("h1")?.innerText || document.title); },
      getPriceCents() {
        const el = document.querySelector('[itemprop="price"]') ||
                   document.querySelector('[data-automation-id="product-price"]') ||
                   document.querySelector('meta[itemprop="price"]');
        const raw = el?.getAttribute?.("content") || el?.textContent || "";
        const cents = toCents(raw);
        return cents;
      },
      getASIN() { return null; },
      getStoreKey() {
        const m = location.pathname.match(/\/ip\/[^/]+\/(\d+)/);
        if (m) return m[1]; // itemId
        // try ld+json
        for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
          try { const j = JSON.parse(s.textContent.trim()); if (j?.sku) return String(j.sku); } catch {}
        }
        // meta
        const meta = document.querySelector('meta[property="product:retailer_item_id"]')?.content;
        if (meta) return meta;
        return null;
      },
      productKey() { return `${this.getStoreKey() || ""}|${location.pathname}`; }
    },

    bestbuy: {
      store: "BestBuy",
      getTitle() { return clean(document.querySelector(".sku-title h1")?.innerText || document.querySelector("h1")?.innerText || document.title); },
      getPriceCents() {
        const el = document.querySelector(".priceView-hero-price span[aria-hidden='true']") ||
                   document.querySelector(".priceView-customer-price span");
        return toCents(el?.innerText || "");
      },
      getASIN() { return null; },
      getStoreKey() {
        const t = document.querySelector(".sku-value")?.innerText || "";
        const m = t.match(/\d+/);
        if (m) return m[0]; // SKU
        const meta = document.querySelector('meta[name="skuId"]')?.content;
        if (meta) return meta;
        return null;
      },
      productKey() { return `${this.getStoreKey() || ""}|${location.pathname}`; }
    }
  };

  // assets
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
      // kill accidental duplicates
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

      sh.querySelector("#ps-close")?.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); this.close(); });
      window.addEventListener("keydown", (e) => { if (this.open && (e.key === "Escape" || e.key === "Esc")) this.close(); });

      const logoEl = sh.querySelector("#ps-logo");
      if (logoEl) logoEl.src = chrome.runtime.getURL("icons/logo.png");

      sh.querySelector("#ps-details-toggle")?.addEventListener("click", (e) => {
        e.preventDefault();
        const content = sh.querySelector("#ps-details-content");
        const arrow = sh.querySelector("#ps-details-arrow");
        content?.classList.toggle("open");
        arrow?.classList.toggle("open");
      });

      // Resizer
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
        store_key: D.getStoreKey ? D.getStoreKey() : null
      };
      await safeSet({ lastSnapshot: snap });

      const asinEl = $("#ps-asin-val");
      asinEl && (asinEl.textContent = snap.asin || (site === "amazon" ? "Not found" : "Resolving..."));

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
        // non Amazon: resolve by store_key (your DB's store_sku)
        const resp = await safeSend({
          type: "RESOLVE_COMPARE_REQUEST",
          payload: { store: D.store, store_key: snap.store_key || "", title: snap.title }
        });
        if (asinEl) asinEl.textContent = resp?.asin || "Unknown";
        list = Array.isArray(resp?.results) ? resp.results.slice() : [];

        // always include current store card
        list.push({ store: D.store, product_name: snap.title, price_cents: snap.price_cents, url: location.href });

        // optional: if we could not resolve, add an Amazon search helper
        if (!resp?.asin) {
          const q = snap.store_key || snap.title || "";
          list.push({ store: "Amazon", product_name: "Search for a match", price_cents: null, url: `https://www.amazon.com/s?k=${encodeURIComponent(q)}` });
        }
      }

      if (list.length === 0) {
        resultsEl.innerHTML = `<div class="status">No prices found.</div>`;
        return;
      }
      resultsEl.innerHTML = "";

      list.sort((a, b) => (a.price_cents ?? Infinity) - (b.price_cents ?? Infinity));
      const bestPrice = list[0].price_cents ?? Infinity;

      const ICON = (k) => ICONS[k] || ICONS.default;

      for (const p of list) {
        const item = document.createElement("a");
        item.className = "result-card";
        item.href = p.url || "#";
        if (p.url) { item.target = "_blank"; item.rel = "noopener noreferrer"; }
        else item.addEventListener("click", (e) => e.preventDefault());

        const price = p.price_cents != null ? (p.price_cents / 100).toFixed(2) : "N/A";
        const storeKey = (p.store || "default").toLowerCase();
        const storeIcon = ICON(storeKey);
        const isBest = p.price_cents === bestPrice;

        item.innerHTML = `
          <div class="store-info">
            <img src="${storeIcon}" alt="${p.store || "Store"} logo" class="store-logo">
            <div class="store-and-product">
              <span class="store-name">${p.store || "Unknown"}</span>
              <span class="product-name">${clean(p.product_name || "")}</span>
            </div>
          </div>
          <div class="price-info">
            <span class="price">$${price}</span>
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
      window.PS = this;
    }
  };

  PS.init();
})();
