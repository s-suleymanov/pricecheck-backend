// content.js
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
    if (/walmart\./i.test(h)) return "walmart";
    if (/bestbuy\./i.test(h)) return "bestbuy";
    return "unknown";
  };

  // ---------- helpers ----------
  function normalizeUPC(raw) {
    let k = String(raw || "").replace(/[^0-9]/g, "");
    if (k.length === 14 && k.startsWith("0")) k = k.slice(1);
    if (k.length === 13 && k.startsWith("0")) k = k.slice(1);
    return k;
  }
  function toCents(txt = "") {
    const n = parseFloat(String(txt).replace(/[^0-9.]/g, ""));
    return isNaN(n) ? null : Math.round(n * 100);
  }
  function extractUPCFromLdJson() {
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const j = JSON.parse(s.textContent.trim());
        const pick = (o) => o?.gtin12 || o?.gtin13 || o?.gtin14;
        if (Array.isArray(j)) {
          for (const it of j) {
            const gt = pick(it);
            if (gt && /^\d{12,14}$/.test(gt)) return normalizeUPC(gt);
          }
        } else {
          const gt = pick(j);
          if (gt && /^\d{12,14}$/.test(gt)) return normalizeUPC(gt);
        }
      } catch {}
    }
    return null;
  }

  // ---------- Amazon ----------
  function getAmazonPriceCents() {
    const pref = document.querySelector(".priceToPay .a-offscreen");
    if (pref?.innerText) {
      const v = toCents(pref.innerText);
      if (Number.isFinite(v)) return v;
    }
    const nodes = Array.from(document.querySelectorAll(".a-price .a-offscreen, [data-a-color='price'] .a-offscreen, #corePrice_feature_div .a-offscreen"));
    for (const el of nodes) {
      if (!el?.innerText) continue;
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
  }

  // ---------- site drivers ----------
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
        const cleanTxt = (t) => String(t || "").replace(/\s+/g, " ").replace(/^\s*(Select|Choose)\b.*$/i, "").trim();
        const picks = new Set();
        [
          "#twister .a-button-selected .a-button-text",
          "#inline-twister-expander-content .a-button-selected .a-button-text",
          "#twister [aria-pressed='true'] .a-button-text",
          "#twister [aria-checked='true'] .a-button-text",
          "#variation_color_name .selection",
          "#variation_size_name .selection",
          "#variation_style_name .selection",
          "#variation_configuration .selection",
          "#variation_pattern_name .selection",
          "#twister .a-dropdown-prompt",
        ].forEach((sel) => {
          document.querySelectorAll(sel).forEach((el) => {
            const t = cleanTxt(el.getAttribute?.("aria-label") || el.textContent);
            if (t) picks.add(t);
          });
        });
        return Array.from(picks).filter(Boolean).join(" ");
      },
      getPriceCents() { return getAmazonPriceCents(); },
      getASIN() {
        const fromUrl  = location.pathname.match(/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?]|$)/i)?.[1];
        const fromAttr = document.querySelector("[data-asin]")?.getAttribute("data-asin");
        const a = (fromUrl || fromAttr || "").toUpperCase();
        return a || null;
      },
      getStoreSKU() { return null; }, // not used for Amazon
      productKey() { return `${this.getASIN() || ""}|${location.pathname}`; }
    },

    // TARGET: store_sku = TCIN (no need to open specs)
    target: {
      store: "Target",
      getTitle() {
        const t = document.querySelector('h1[data-test="product-title"]')?.innerText
               || document.querySelector('meta[property="og:title"]')?.content
               || document.title;
        return clean(t || "");
      },
      getPriceCents() {
        const sels = [
          '[data-test="product-price"]',
          '[data-test="offer-price"]',
          '[data-test^="price"]',
          'meta[itemprop="price"]',
          'meta[property="product:price:amount"]',
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
      // TCIN from URL or preloaded JSON (works with specs closed)
      getStoreSKU() {
        // 1) URL like .../-/A-93167736
        const m = location.pathname.match(/\/A-([0-9]{6,12})(?:$|[/?#])/i);
        if (m) return m[1];

        // 2) embedded preloaded state blobs
        const scripts = Array.from(document.querySelectorAll("script")).slice(0, 80);
        for (const s of scripts) {
          const txt = s.textContent || "";
          const tcinMatch = txt.match(/"tcin"\s*:\s*"([0-9]{6,12})"/i) || txt.match(/"tcin"\s*:\s*([0-9]{6,12})/i);
          if (tcinMatch) return String(tcinMatch[1]);
        }
        return null;
      },
      productKey() { return `${this.getStoreSKU() || ""}|${location.pathname}`; }
    },

    walmart: {
      store: "Walmart",
      getTitle() { return clean(document.querySelector("h1")?.innerText || document.title); },
      getPriceCents() {
        const el = document.querySelector('[itemprop="price"]')
               || document.querySelector('[data-automation-id="product-price"]')
               || document.querySelector('meta[itemprop="price"]');
        const raw = el?.getAttribute?.("content") || el?.textContent || "";
        return toCents(raw);
      },
      getASIN() { return null; },
      // store_sku = item id from URL path when available
      getStoreSKU() {
        // e.g. /ip/<slug>/<ITEMID>
        const m = location.pathname.match(/\/ip\/[^/]+\/([0-9]{6,20})(?:$|[/?#])/i);
        if (m) return m[1];
        return null;
      },
      productKey() { return `${this.getStoreSKU() || ""}|${location.pathname}`; }
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
      // store_sku = numeric SKU from page
      getStoreSKU() {
        // Try meta or visible SKU label
        const meta = document.querySelector('meta[itemprop="sku"]')?.content;
        if (meta && /^\d{4,10}$/.test(meta)) return meta;
        const m = (document.body.innerText || "").match(/\bSKU\s*:?[\s#]*([0-9]{4,10})\b/i);
        if (m) return m[1];
        return null;
      },
      productKey() { return `${this.getStoreSKU() || ""}|${location.pathname}`; }
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
    width: 380,
    open: false,
    root: null,
    shadow: null,
    _mo: null,
    _debounceTimer: null,
    _lastKey: null,
    _inflight: null,

    async ensure() {
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

      // Resize
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

    _reconcileResults(resultsEl, list, iconFor) {
      const makeKey = (p) => `${(p.store || '').toLowerCase()}|${p.asin || p.url || ''}`;
      const next = new Map();
      list.forEach(p => next.set(makeKey(p), p));

      const existing = Array.from(resultsEl.querySelectorAll('.result-card'));
      const seen = new Set();

      for (const el of existing) {
        const k = el.dataset.key || '';
        const p = next.get(k);
        if (!p) { el.remove(); continue; }
        seen.add(k);

        const newPrice = Number.isFinite(p.price_cents) ? `$${(p.price_cents / 100).toFixed(2)}` : '';
        const priceEl = el.querySelector('.price');
        if (priceEl && priceEl.textContent !== newPrice) priceEl.textContent = newPrice;

        const newVar = p.variant_label ? String(p.variant_label).trim() : "";
        const varEl = el.querySelector('.ps-variant-val');
        if (varEl) {
          varEl.textContent = newVar;
          varEl.style.display = newVar ? '' : 'none';
        }

        const finalUrl = ((p.store || "").toLowerCase() === "amazon" && p.asin && /^[A-Z0-9]{10}$/.test(String(p.asin)))
          ? `https://www.amazon.com/dp/${String(p.asin).toUpperCase()}`
          : (p.url || "");

        if (finalUrl) {
          if (el.href !== finalUrl) el.href = finalUrl;
          el.target = "_blank";
          el.rel = "noopener noreferrer";
        } else {
          el.removeAttribute("href");
          el.removeAttribute("target");
          el.removeAttribute("rel");
        }
      }

      for (const [k, p] of next.entries()) {
        if (seen.has(k)) continue;

        const item = document.createElement("a");
        item.className = "result-card";
        item.dataset.key = k;

        const finalUrl = ((p.store || "").toLowerCase() === "amazon" && p.asin && /^[A-Z0-9]{10}$/.test(String(p.asin)))
          ? `https://www.amazon.com/dp/${String(p.asin).toUpperCase()}`
          : (p.url || "");

        if (finalUrl) {
          item.href = finalUrl;
          item.target = "_blank";
          item.rel = "noopener noreferrer";
        }

        const price = Number.isFinite(p.price_cents) ? (p.price_cents / 100).toFixed(2) : "";
        const storeKey = (p.store || "default").toLowerCase();
        const storeIcon = iconFor(storeKey);
        const variantText = p.variant_label ? String(p.variant_label).trim() : "";

        item.innerHTML = `
          <div class="store-info">
            <img src="${storeIcon}" alt="${p.store || "Store"} logo" class="store-logo">
            <div class="store-and-product">
              <span class="store-name">${p.store || "Unknown"}</span>
              <span class="ps-variant-val" style="${variantText ? "" : "display:none"}">${variantText || ""}</span>
            </div>
          </div>
          <div class="price-info">
            <span class="price">${price ? `$${price}` : ""}</span>
          </div>
        `;
        if (storeKey === "amazon") item.classList.add("current-site");
        resultsEl.appendChild(item);
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
        store_sku: D.getStoreSKU ? D.getStoreSKU() : null, // TCIN on Target, SKU on others
      };
      await safeSet({ lastSnapshot: snap });

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

      // Product line
      const prodLabelEl = sh.querySelector(".asin-row strong");
      const prodValEl   = sh.querySelector("#ps-asin-val");
      if (prodLabelEl && prodValEl) {
        if (site === "amazon") {
          prodLabelEl.textContent = "ASIN";
          prodValEl.textContent = snap.asin || "Not found";
        } else if (site === "target") {
          prodLabelEl.textContent = "TCIN";
          prodValEl.textContent = snap.store_sku || "Not found";
        } else {
          prodLabelEl.textContent = "Product";
          prodValEl.textContent = snap.store_sku || "Not found";
        }
      }

      let list = [];
      let resolvedASIN = snap.asin;

      if (site === "amazon") {
        if (!snap.asin) { statusEl.textContent = "ASIN not found on this page."; return; }
        const resp = await safeSend({ type: "COMPARE_REQUEST", payload: { asin: snap.asin } });
        list = Array.isArray(resp?.results) ? resp.results.slice() : [];

        const hasAmazon = list.some(p => (p.store || "").toLowerCase() === "amazon");
        if (!hasAmazon) {
          list.push({
            store: "Amazon",
            product_name: snap.title,
            price_cents: snap.price_cents,
            url: location.href,
            variant_label: DRIVERS.amazon.getVariantLabel ? DRIVERS.amazon.getVariantLabel() : null
          });
        }
      } else {
        if (!snap.store_sku || String(snap.store_sku).trim() === "") {
          list = [];
          resolvedASIN = null;
        } else {
          const resp = await safeSend({
            type: "RESOLVE_COMPARE_REQUEST",
            payload: { store: D.store, store_sku: snap.store_sku }
          });
          resolvedASIN = resp?.asin || null;
          list = Array.isArray(resp?.results) ? resp.results.slice() : [];

          const hasAmazon = list.some(p => (p.store || "").toLowerCase() === "amazon");
          if (resolvedASIN && !hasAmazon) {
            list.push({
              store: "Amazon",
              product_name: snap.title || "",
              price_cents: null,
              url: `https://www.amazon.com/dp/${resolvedASIN}`,
              variant_label: null,
              asin: resolvedASIN
            });
          }
        }
      }

      // Category line (brand + category if present)
      const bcEl = sh.querySelector("#ps-variant-val");
      if (bcEl) {
        const amazonRow = list.find(r => (r.store || "").toLowerCase() === "amazon");
        const brand = amazonRow?.brand || null;
        const category = amazonRow?.category || null;
        const bc = [brand, category].filter(Boolean).join(" ");
        bcEl.textContent = bc || "N/A";
      }

      // Observe current page price
      if (site === "amazon") {
        const payload = { store: "Amazon", asin: snap.asin || null, price_cents: snap.price_cents, url: location.href, title: snap.title };
        try { await safeSend({ type: "OBSERVE_PRICE", payload }); } catch {}
      } else if (snap.store_sku) {
        const payload = { store: D.store, store_sku: snap.store_sku, price_cents: snap.price_cents, url: location.href, title: snap.title };
        try { await safeSend({ type: "OBSERVE_PRICE", payload }); } catch {}
      }

      if (!list.length) { statusEl.textContent = "No prices found."; return; }

      const asinForLink = String((resolvedASIN || snap.asin || "")).toUpperCase();
      if (/^[A-Z0-9]{10}$/.test(asinForLink)) {
        list = list.map(r => {
          if ((r.store || "").toLowerCase() === "amazon") {
            r.asin = asinForLink;
            r.url  = `https://www.amazon.com/dp/${asinForLink}`;
          }
          return r;
        });
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

    _debounce(fn, wait = 600) { return (...args) => { clearTimeout(this._debounceTimer); this._debounceTimer = setTimeout(() => fn.apply(this, args), wait); }; },
    _productKey() {
      const site = siteOf();
      const D = DRIVERS[site] || DRIVERS.amazon;
      const asin = D.getASIN ? D.getASIN() : "";
      const sku  = D.getStoreSKU ? D.getStoreSKU() : "";
      const variant = D.getVariantLabel ? D.getVariantLabel() : "";
      const key = site === "amazon" ? `${asin}|${variant}` : (sku || "");
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
      const triggerCheck = this._debounce(() => {
        setTimeout(() => this._refreshIfChanged().catch(() => {}), 300);
      }, 200);

      const root =
        document.getElementById('dp-container') ||
        document.getElementById('twister') ||
        document.body;

      this._mo?.disconnect?.();
      this._mo = new MutationObserver(triggerCheck);
      this._mo.observe(root, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: [
          'class','aria-pressed','aria-checked','aria-label','data-defaultasin','data-asin','value'
        ]
      });

      let last = location.href;
      setInterval(() => { if (location.href !== last) { last = location.href; triggerCheck(); } }, 800);

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
