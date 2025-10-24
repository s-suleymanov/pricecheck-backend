// content.js - fast path only (Amazon: ASIN -> compare, Others: UPC -> compare_by_upc)
(() => {
  "use strict";

  const ROOT_ID = "pricecheck-sidebar-root";

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
  const safeSend = (msg) => new Promise((res) => { try { chrome.runtime.sendMessage(msg, (r) => res(r)); } catch { res(null); } });
  const clean = (s = "") => s.replace(/[\u200E\u200F\u202A-\u202E]/g, "").replace(/\s+/g, " ").trim();
  const toCents = (txt = "") => { const n = parseFloat(String(txt).replace(/[^0-9.]/g, "")); return isNaN(n) ? null : Math.round(n * 100); };

  const siteOf = (h = location.hostname) => {
    if (/amazon\./i.test(h)) return "amazon";
    if (/target\.com$/i.test(h) || /\.target\.com$/i.test(h)) return "target";
    if (/walmart\./i.test(h)) return "walmart";
    if (/bestbuy\./i.test(h)) return "bestbuy";
    return "unknown";
  };

  // ---------- drivers (minimal) ----------
  const DRIVERS = {
    amazon: {
      store: "Amazon",
      getTitle() {
        return clean(document.getElementById("productTitle")?.innerText || document.querySelector("#title span")?.innerText || "");
      },
      getPriceCents() {
        const pref = document.querySelector(".priceToPay .a-offscreen");
        if (pref?.innerText) {
          const v = toCents(pref.innerText);
          if (Number.isFinite(v)) return v;
        }
        const nodes = Array.from(document.querySelectorAll(".a-price .a-offscreen, [data-a-color='price'] .a-offscreen, #corePrice_feature_div .a-offscreen"));
        for (const el of nodes) {
          if (!el?.innerText) continue;
          // skip strikethrough/MSRP
          let bad = false, p = el;
          for (let i = 0; i < 4 && p; i++) {
            if (p.classList?.contains("a-text-price") || p.classList?.contains("basisPrice") || p.getAttribute?.("data-a-strike") === "true") { bad = true; break; }
            p = p.parentElement;
          }
          if (bad) continue;
          const v = toCents(el.innerText);
          if (Number.isFinite(v)) return v;
        }
        return null;
      },
      getASIN() {
        const fromUrl = location.pathname.match(/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?]|$)/i)?.[1];
        const fromAttr = document.querySelector("[data-asin]")?.getAttribute("data-asin");
        return (fromUrl || fromAttr || "").toUpperCase() || null;
      },
      getStoreKey() { return null; }
    },

    target: {
      store: "Target",
      getTitle() { return clean(document.querySelector('h1[data-test="product-title"]')?.innerText || document.title); },
      getPriceCents() {
        const sels = ['[data-test="product-price"]','[data-test="offer-price"]','[data-test^="price"]','meta[itemprop="price"]'];
        for (const sel of sels) {
          const el = document.querySelector(sel);
          const raw = el?.getAttribute?.("content") || el?.textContent || "";
          const cents = toCents(raw);
          if (cents != null) return cents;
        }
        return null;
      },
      // Return UPC quickly (structured JSON or simple page regex)
      getStoreKey() {
        for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
          try {
            const j = JSON.parse(s.textContent.trim());
            const gtin = j?.gtin12 || j?.gtin13;
            if (gtin && /^\d{12,13}$/.test(gtin)) return gtin.length === 13 && gtin.startsWith("0") ? gtin.slice(1) : gtin;
          } catch {}
        }
        const m = document.body.innerText.match(/(^|[^\d])(\d{12,13})(?!\d)/);
        if (m) { const code = m[2]; return code.length === 13 && code.startsWith("0") ? code.slice(1) : code; }
        return null;
      }
    },

    walmart: {
      store: "Walmart",
      getTitle() { return clean(document.querySelector("h1")?.innerText || document.title); },
      getPriceCents() {
        const el = document.querySelector('[itemprop="price"]') || document.querySelector('[data-automation-id="product-price"]') || document.querySelector('meta[itemprop="price"]');
        const raw = el?.getAttribute?.("content") || el?.textContent || "";
        return toCents(raw);
      },
      getStoreKey() {
        const meta = document.querySelector('meta[property="product:retailer_item_id"]')?.content;
        if (meta) return String(meta).replace(/\D+/g, "");
        const m = location.pathname.match(/\/ip\/[^/]+\/(\d+)/);
        return m ? String(m[1]).replace(/\D+/g, "") : null;
      }
    },

    bestbuy: {
      store: "BestBuy",
      getTitle() { return clean(document.querySelector(".sku-title h1")?.innerText || document.querySelector("h1")?.innerText || document.title); },
      getPriceCents() {
        const el = document.querySelector(".priceView-hero-price span[aria-hidden='true']") || document.querySelector(".priceView-customer-price span");
        return toCents(el?.innerText || "");
      },
      getStoreKey() {
        const t = document.querySelector(".sku-value")?.innerText || "";
        const m = t.match(/\d+/);
        return m ? m[0] : null;
      }
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

  // ---------- singleton ----------
  const PS = {
    id: ROOT_ID,
    width: 360,
    open: false,
    root: null,
    shadow: null,
    _mo: null,
    _debounceTimer: null,
    _lastKey: null,
    _inflight: null,

    async ensure() {
      const dupes = Array.from(document.querySelectorAll(`#${this.id}`));
      for (let i = 1; i < dupes.length; i++) dupes[i].remove();

      const existing = document.getElementById(this.id);
      if (existing) { this.root = existing; this.shadow = existing.shadowRoot; return existing; }

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
      root.style.transition = "transform 140ms ease";

      document.documentElement.appendChild(root);
      const sh = root.attachShadow({ mode: "open" });

      const [html, css] = await Promise.all([loadAsset(HTML_URL), loadAsset(CSS_URL)]);
      const style = document.createElement("style"); style.textContent = css;
      const container = document.createElement("div"); container.innerHTML = html;
      sh.appendChild(style); sh.appendChild(container);

      sh.querySelector("#ps-close")?.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); this.close(); });
      window.addEventListener("keydown", (e) => { if (this.open && (e.key === "Escape" || e.key === "Esc")) this.close(); });

      const logoEl = sh.querySelector("#ps-logo");
      if (logoEl) logoEl.src = chrome.runtime.getURL("icons/logo.png");

      this.root = root; this.shadow = sh;
      return root;
    },

    applyPagePush() {
      const html = document.documentElement;
      if (this.open) {
        html.style.paddingLeft = this.width + "px";
        this.root.style.transform = "translateX(0%)";
      } else {
        html.style.paddingLeft = "0";
        this.root.style.transform = "translateX(-100%)";
      }
    },

    _reconcileResults(resultsEl, list, iconFor) {
      resultsEl.innerHTML = ""; // simplest & fastest: full replace

      for (const p of list) {
        const a = document.createElement("a");
        a.className = "result-card";

        // Force DP for Amazon if we know the ASIN
        let finalUrl = p.url || "";
        const isAmazon = (p.store || "").toLowerCase() === "amazon";
        if (isAmazon && p.asin && /^[A-Z0-9]{10}$/.test(String(p.asin))) {
          finalUrl = `https://www.amazon.com/dp/${String(p.asin).toUpperCase()}`;
        }
        if (finalUrl) { a.href = finalUrl; a.target = "_blank"; a.rel = "noopener noreferrer"; }

        const price = Number.isFinite(p.price_cents) ? `$${(p.price_cents / 100).toFixed(2)}` : "";
        const storeKey = (p.store || "default").toLowerCase();
        const storeIcon = iconFor(storeKey);

        a.innerHTML = `
          <div class="store-info">
            <img src="${storeIcon}" alt="${p.store || "Store"}" class="store-logo">
            <span class="store-name">${p.store || "Unknown"}</span>
          </div>
          <div class="price-info">
            <span class="price">${price}</span>
          </div>
        `;
        resultsEl.appendChild(a);
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

      const resultsEl = $("#ps-results");
      if (!resultsEl) return;

      let statusEl = resultsEl.querySelector(".status");
      if (!statusEl) {
        statusEl = document.createElement("div");
        statusEl.className = "status";
        resultsEl.prepend(statusEl);
      }
      statusEl.style.display = "block";
      statusEl.textContent = "Searching...";

      let list = [];
      let resolvedASIN = snap.asin;

      if (site === "amazon") {
        if (!snap.asin) { statusEl.textContent = "ASIN not found."; return; }
        const resp = await safeSend({ type: "COMPARE_REQUEST", payload: { asin: snap.asin } });
        list = Array.isArray(resp?.results) ? resp.results : [];
      } else {
        const resp = await safeSend({
          type: "RESOLVE_COMPARE_REQUEST",
          payload: { store: D.store, store_key: snap.store_key || "" }
        });
        resolvedASIN = resp?.asin || null;
        list = Array.isArray(resp?.results) ? resp.results : [];

        // Ensure Amazon card has DP if we know ASIN
        if (resolvedASIN) {
          list = list.map(r => (r.store || "").toLowerCase() === "amazon"
            ? { ...r, asin: resolvedASIN, url: `https://www.amazon.com/dp/${resolvedASIN}` }
            : r
          );
        }
      }

      if (!list.length) {
        statusEl.textContent = "No prices found.";
        return;
      }

      list.sort((a, b) => (a.price_cents ?? Infinity) - (b.price_cents ?? Infinity));
      statusEl.textContent = "";
      statusEl.style.display = "none";

      const ICON = (k) => ICONS[k] || ICONS.default;
      this._reconcileResults(resultsEl, list, ICON);
    },

    async openSidebar() { await this.ensure(); this.open = true; this.applyPagePush(); await this.populate(); },
    close() { if (!this.root) return; this.open = false; this.applyPagePush(); },
    toggle() { this.open ? this.close() : this.openSidebar(); },

    _debounce(fn, wait = 400) { return (...args) => { clearTimeout(this._debounceTimer); this._debounceTimer = setTimeout(() => fn.apply(this, args), wait); }; },

    _productKey() {
      const site = siteOf();
      const D = DRIVERS[site] || DRIVERS.amazon;
      const asin = D.getASIN ? D.getASIN() : "";
      const key = site === "amazon" ? asin : (D.getStoreKey() || "");
      return `${site}|${key}|${location.pathname}`;
    },

    async _refreshIfChanged() {
      if (!this.open) return;
      const key = this._productKey();
      if (key === this._lastKey) return;
      this._lastKey = key;

      try { await this.populate(); } catch {}
    },

    _bindProductObservers() {
      const triggerCheck = this._debounce(() => { this._refreshIfChanged().catch(() => {}); }, 250);

      const root = document.body;
      this._mo?.disconnect?.();
      this._mo = new MutationObserver(triggerCheck);
      this._mo.observe(root, { subtree: true, childList: true, attributes: true });
      let last = location.href;
      setInterval(() => {
        if (location.href !== last) { last = location.href; triggerCheck(); }
      }, 800);

      triggerCheck();
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
