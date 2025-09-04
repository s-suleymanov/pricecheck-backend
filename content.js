// content.js - Injects sidebar and scrapes product data (fixed singleton build)
(() => {
  "use strict";

  // Prevent double-injection
  if (window.__PS_INJECTED__) return;
  window.__PS_INJECTED__ = true;

  // ---------- utils ----------
  const hasChrome = () => typeof chrome !== "undefined" && chrome?.runtime?.id;

  const safeSet = async (kv) => {
    try { if (hasChrome()) await chrome.storage.local.set(kv); } catch {}
  };

  const safeSend = (msg) => new Promise((res) => {
    if (!hasChrome()) return res(null);
    try { chrome.runtime.sendMessage(msg, (r) => res(r)); } catch { res(null); }
  });

  const clean = (s = "") => s.replace(/[\u200E\u200F\u202A-\u202E]/g, "").replace(/\s+/g, " ").trim();

  const extractUPC = (str) => {
    const m = clean(str).match(/(?:^|[^\d])(\d{12,13})(?!\d)/);
    if (!m) return null;
    let c = m[1];
    if (c.length === 13 && c.startsWith("0")) c = c.slice(1);
    return c.length === 12 ? c : null;
  };

  const getTitle = () =>
    clean(document.getElementById("productTitle")?.innerText ||
          document.querySelector("#title span")?.innerText || "") || null;

  const getASIN = () => {
    const fromUrl = location.pathname.match(/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?]|$)/i)?.[1];
    const fromAttr = document.querySelector("[data-asin]")?.getAttribute("data-asin");
    return (fromUrl || fromAttr || "").toUpperCase() || null;
  };

  // Stops at first comma or semicolon if present
  const smartTruncate = (title) => {
    if (!title) return "N/A";
    const commaIndex = title.indexOf(",");
    const semicolonIndex = title.indexOf(";");
    let endIndex = -1;
    if (commaIndex > -1 && semicolonIndex > -1) endIndex = Math.min(commaIndex, semicolonIndex);
    else if (commaIndex > -1) endIndex = commaIndex;
    else if (semicolonIndex > -1) endIndex = semicolonIndex;
    return endIndex > -1 ? title.substring(0, endIndex) : title;
  };

  const getPrice = () => {
    const sels = [
      "#corePrice_feature_div .a-offscreen",
      ".priceToPay .a-offscreen",
      "#price .a-offscreen",
      "#price_inside_buybox",
      ".a-price-whole"
    ];
    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (el && el.innerText) {
        const priceText = el.innerText.replace(/[^0-9.]/g, "");
        const price = parseFloat(priceText);
        if (!isNaN(price)) return Math.round(price * 100);
      }
    }
    return null;
  };

  function findUPC() {
    const tableRowSelectors = [
      "#prodDetails tr",
      "table#productDetails_techSpec_section_1 tr",
      "table#productDetails_detailBullets_sections1 tr",
      "#technicalSpecifications_section_1 tr",
      "#poExpander tr"
    ];
    for (const sel of tableRowSelectors) {
      for (const tr of document.querySelectorAll(sel)) {
        const label = clean(tr.querySelector("th,.a-text-bold,.a-color-secondary,.label")?.innerText||tr.firstElementChild?.innerText||"");
        if (!/upc|ean|gtin/i.test(label)) continue;
        const valEl = tr.querySelector("td:last-child")||tr.querySelector("td")||tr;
        const upc = extractUPC(valEl.innerText);
        if (upc) return upc;
      }
    }
    const bulletSelectors = ["#detailBullets_feature_div li","#detailBulletsWrapper_feature_div li","#detailBulletsWrapper_feature_div span"];
    for (const sel of bulletSelectors) {
      for (const el of document.querySelectorAll(sel)) {
        const txt = clean(el.innerText);
        if (/upc|ean|gtin/i.test(txt)) {
          const upc = extractUPC(txt);
          if (upc) return upc;
        }
      }
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const t = clean(node.nodeValue || "");
      if (!/upc/i.test(t)) continue;
      let upc = extractUPC(t) || extractUPC(node.parentElement?.innerText || "");
      if (upc) return upc;
      const row = node.parentElement?.closest("tr,li,div,span,td,th");
      if (row) {
        upc = extractUPC(row.innerText) ||
              extractUPC(row.querySelector("td + td, th + td")?.innerText || "") ||
              extractUPC(row.nextElementSibling?.innerText || "");
        if (upc) return upc;
      }
    }
    return null;
  }

  // ---------- sidebar assets ----------
  const HTML_URL = chrome.runtime.getURL("content.html");
  const CSS_URL  = chrome.runtime.getURL("content.css");
  const ICONS = {
    target:  chrome.runtime.getURL("icons/target-circle.png"),
    amazon:  chrome.runtime.getURL("icons/amazon-a.png"),
    apple:   chrome.runtime.getURL("icons/apple.png"),
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

  // ---------- singleton PS ----------
  const PS = {
    id: "pricecheck-sidebar-root",
    width: 380,
    open: false,
    root: null,
    shadow: null,
    _msgBound: false,
    _mo: null,
    _debounceTimer: null,
    _lastKey: null,
    _inflight: null,

    async ensure() {
      if (this.root) return this.root;

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

      // wire close button
      const closeBtn = sh.querySelector("#ps-close");
      if (closeBtn) {
        closeBtn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.close();
        });
      }

      const logoEl = sh.querySelector("#ps-logo");
      if (logoEl) logoEl.src = chrome.runtime.getURL("icons/logo.png");

      // disclosure dropdown
      sh.querySelector("#ps-details-toggle")?.addEventListener("click", (e) => {
        e.preventDefault();
        const content = sh.querySelector("#ps-details-content");
        const arrow = sh.querySelector("#ps-details-arrow");
        content?.classList.toggle("open");
        arrow?.classList.toggle("open");
      });

      // resize
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

      const snap = { title: getTitle(), upc: findUPC(), asin: getASIN(), price_cents: getPrice() };
      await safeSet({ lastSnapshot: snap });

      const upcEl = $("#ps-upc-val");
      const asinEl = $("#ps-asin-val");
      if (upcEl) upcEl.textContent = snap.upc || "Not Found";
      if (asinEl) asinEl.textContent = snap.asin || "N/A";

      const resultsEl = $("#ps-results");
      if (!resultsEl) return;
      resultsEl.innerHTML = `<div class="status">Searching...</div>`;

      if (!snap.upc) {
        resultsEl.innerHTML = `<div class="status">UPC not found on this page.</div>`;
        return;
      }

      const amazonPrice = snap.price_cents;
      const resp = await safeSend({ type: "COMPARE_REQUEST", payload: { upc: snap.upc } });

      // Keep every row from the DB
      let list = Array.isArray(resp?.results) ? resp.results.slice() : [];

      // Only add the synthetic Amazon row if DB did not already return an Amazon row
      const hasAmazonAlready = list.some(p => (p.store || "").toLowerCase() === "amazon");
      if (!hasAmazonAlready && amazonPrice !== null) {
        list.push({
          store: "Amazon",
          product_name: snap.title,
          price_cents: amazonPrice,
          url: window.location.href
        });
      }

      // If there is nothing to show at all, bail out early
      if (list.length === 0) {
        resultsEl.innerHTML = `<div class="status">No prices found.</div>`;
        return;
      }
      resultsEl.innerHTML = "";

      // Sort by price but keep the full list
      list.sort((a, b) => (a.price_cents ?? Infinity) - (b.price_cents ?? Infinity));

      const bestPrice = list[0].price_cents ?? Infinity;


      for (const p of list) {
        const item = document.createElement("a");
        item.className = "result-card";
        item.href = p.url;
        item.target = "_blank";
        item.rel = "noopener noreferrer";

        const price = p.price_cents != null ? (p.price_cents / 100).toFixed(2) : "N/A";
        let savings = 0;
        let isBest = false;
        if (amazonPrice !== null && p.price_cents !== null && p.price_cents < amazonPrice) {
          savings = amazonPrice - p.price_cents;
        } else if (p.price_cents === bestPrice) {
          isBest = true;
        }

        const storeKey = (p.store || "default").toLowerCase();
        const storeIcon = ICONS[storeKey] || ICONS.default;

        item.innerHTML = `
          <div class="store-info">
            <img src="${storeIcon}" alt="${p.store} logo" class="store-logo">
            <div class="store-and-product">
              <span class="store-name">${p.store || "Unknown"}</span>
              <span class="product-name">${smartTruncate(p.product_name)}</span>
            </div>
          </div>
          <div class="price-info">
            <span class="price">$${price}</span>
            ${
              savings > 0
                ? `<span class="savings-tag">Save $${(savings / 100).toFixed(2)}</span>`
                : isBest && storeKey !== "amazon"
                  ? `<span class="savings-tag best-price">Best Price</span>`
                  : ""
            }
          </div>
        `;

        if (storeKey === "amazon") item.classList.add("current-site");
        resultsEl.appendChild(item);
      }
    },

    async openSidebar() {
      await this.ensure();
      this.open = true;
      this.applyPagePush();
      await this.populate();
    },

    close() {
      if (!this.root) return;
      this.open = false;
      this.applyPagePush();
    },

    toggle() {
      this.open ? this.close() : this.openSidebar();
    },

    // ---------- product change detection tied to "open" state ----------
    _debounce(fn, wait = 600) {
      return (...args) => {
        clearTimeout(this._debounceTimer);
        this._debounceTimer = setTimeout(() => fn.apply(this, args), wait);
      };
    },

    _productKey() {
      // UPC or ASIN or path
      const asin = getASIN() || "";
      let upc = "";
      try {
        const m = document.body.innerText.match(/(^|[^\d])(\d{12,13})(?!\d)/);
        upc = m ? m[2] : "";
      } catch {}
      return `${upc}|${asin}|${location.pathname}`;
    },

    async _refreshIfChanged() {
      if (!this.open) return; // never auto open
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

      // URL changes on SPAs
      const _pushState = history.pushState;
      if (!_pushState.__ps_wrapped__) {
        history.pushState = function() { _pushState.apply(this, arguments); debounced(); };
        history.pushState.__ps_wrapped__ = true;
      }
      window.addEventListener("popstate", debounced);

      // DOM changes near product area
      const root = document.getElementById("dp-container") || document.body;
      this._mo = new MutationObserver(debounced);
      this._mo.observe(root, { subtree: true, childList: true });

      // first run
      debounced();
    },

    _bindRuntimeMessage() {
      if (this._msgBound) return;
      const onMsg = (m) => {
        if (m?.type === "TOGGLE_SIDEBAR") this.toggle();
      };
      chrome.runtime?.onMessage.addListener(onMsg);
      this._msgBound = true;
    },

    init() {
      this._bindRuntimeMessage();
      this._bindProductObservers();

      // Restore layout after bfcache navigation if it was open
      window.addEventListener("pageshow", (e) => {
        if (e.persisted && this.open) this.applyPagePush();
      });

      // expose for debugging
      window.PS = this;
    }
  };

  // init once
  PS.init();
})();
