// content.js — unified Amazon, Target, Walmart, BestBuy sidebar
(() => {
  "use strict";

  const ROOT_ID = "pricecheck-sidebar-root";

  // Prevent re-entry
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

  // ---------- helpers ----------
  const hasChrome = () => typeof chrome !== "undefined" && chrome?.runtime?.id;
  const safeSend = (msg) =>
    new Promise((res) => {
      try {
        chrome.runtime.sendMessage(msg, (r) => res(r));
      } catch {
        res(null);
      }
    });
  const safeSet = async (kv) => {
    try {
      if (hasChrome()) await chrome.storage.local.set(kv);
    } catch {}
  };
  const clean = (s = "") =>
    s.replace(/[\u200E\u200F\u202A-\u202E]/g, "").replace(/\s+/g, " ").trim();

  const siteOf = (h = location.hostname) => {
    if (h.includes("amazon.")) return "amazon";
    if (h.includes("target.")) return "target";
    if (h.includes("walmart.")) return "walmart";
    if (h.includes("bestbuy.")) return "bestbuy";
    return "unknown";
  };

  const toCents = (txt = "") => {
    const n = parseFloat(String(txt).replace(/[^0-9.]/g, ""));
    return isNaN(n) ? null : Math.round(n * 100);
  };

  const storeKey = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

  const storeLabel = (s) => {
    const k = storeKey(s);
    if (k === "bestbuy") return "Best Buy";
    return s || "Unknown";
  };

  const normalizeUPC = (raw) => {
    let k = String(raw || "").replace(/[^0-9]/g, "");
    if (k.length === 14 && k.startsWith("0")) k = k.slice(1);
    if (k.length === 13 && k.startsWith("0")) k = k.slice(1);
    return k;
  };

  // ---------- Amazon ----------
  function getAmazonPriceCents() {
    const pref = document.querySelector(".priceToPay .a-offscreen");
    if (pref?.innerText) {
      const v = toCents(pref.innerText);
      if (Number.isFinite(v)) return v;
    }
    const nodes = document.querySelectorAll(
      ".a-price .a-offscreen, [data-a-color='price'] .a-offscreen, #corePrice_feature_div .a-offscreen"
    );
    for (const el of nodes) {
      const text = el?.innerText;
      if (!text) continue;
      let bad = false;
      let p = el;
      for (let i = 0; i < 4 && p; i++) {
        if (
          p.classList?.contains("a-text-price") ||
          p.classList?.contains("basisPrice") ||
          p.getAttribute?.("data-a-strike") === "true"
        ) {
          bad = true;
          break;
        }
        p = p.parentElement;
      }
      if (bad) continue;
      const v = toCents(text);
      if (Number.isFinite(v)) return v;
    }
    return null;
  }

  // ---------- DRIVERS ----------
  const DRIVERS = {
    amazon: {
      store: "Amazon",
      getTitle() {
        return clean(
          document.getElementById("productTitle")?.innerText ||
            document.querySelector("#title span")?.innerText ||
            ""
        );
      },
      getASIN() {
        const fromUrl = location.pathname.match(
          /(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?]|$)/i
        )?.[1];
        const fromAttr = document
          .querySelector("[data-asin]")
          ?.getAttribute("data-asin");
        return (fromUrl || fromAttr || "").toUpperCase() || null;
      },
      getVariantLabel() {
        const picks = new Set();
        const selList = [
          "#twister .a-button-selected .a-button-text",
          "#variation_color_name .selection",
          "#variation_size_name .selection",
          "#variation_style_name .selection",
          "#variation_pattern_name .selection",
        ];
        selList.forEach((sel) =>
          document.querySelectorAll(sel).forEach((el) => {
            const t = clean(el.textContent);
            if (t) picks.add(t);
          })
        );
        return Array.from(picks).join(" ");
      },
      getPriceCents: getAmazonPriceCents,
      getStoreSKU() {
        return null;
      },
    },

    // ---------- Target ----------
    target: {
      store: "Target",
      getTitle() {
        const t =
          document.querySelector('h1[data-test="product-title"]')?.innerText ||
          document.querySelector('meta[property="og:title"]')?.content ||
          document.title;
        return clean(t);
      },
      getPriceCents() {
        const sels = [
          '[data-test="product-price"]',
          '[data-test="offer-price"]',
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
      getASIN() {
        return null;
      },
      getStoreSKU() {
        // 1) From URL
        const m = location.pathname.match(/\/A-([0-9]{6,12})(?:$|[/?#])/i);
        if (m) return m[1];
        // 2) JSON blobs
        const scripts = document.querySelectorAll("script");
        for (const s of scripts) {
          const txt = s.textContent || "";
          const tcin = txt.match(/"tcin"\s*:\s*"([0-9]{6,12})"/i);
          if (tcin) return tcin[1];
        }
        return null;
      },
    },

    // ---------- Walmart ----------
    walmart: {
      store: "Walmart",
      getTitle() {
        return clean(
          document.querySelector("h1")?.innerText || document.title
        );
      },
      getPriceCents() {
        const el =
          document.querySelector('[itemprop="price"]') ||
          document.querySelector('[data-automation-id="product-price"]');
        const raw = el?.getAttribute?.("content") || el?.textContent || "";
        return toCents(raw);
      },
      getASIN() {
        return null;
      },
      getStoreSKU() {
        // itemId from URL: /ip/.../<itemId>
        const m = location.pathname.match(
          /\/ip\/[^/]+\/([0-9]{6,20})(?:$|[/?#])/i
        );
        if (m) return m[1];
        // fallback from script JSON
        const scripts = document.querySelectorAll("script");
        for (const s of scripts) {
          const txt = s.textContent || "";
          const m2 = txt.match(/"itemId"\s*:\s*"([0-9]{6,20})"/i);
          if (m2) return m2[1];
        }
        return null;
      },
    },

    // ---------- BestBuy ----------
    bestbuy: {
      store: "BestBuy",
      getTitle() {
        return clean(
          document.querySelector(".sku-title h1")?.innerText ||
            document.querySelector("h1")?.innerText ||
            document.title
        );
      },
      getPriceCents() {
        const el =
          document.querySelector(
            ".priceView-hero-price span[aria-hidden='true']"
          ) || document.querySelector(".priceView-customer-price span");
        return toCents(el?.innerText || "");
      },
      getASIN() {
        return null;
      },
      getStoreSKU() {
        // 1) meta[itemprop=sku]
        const meta = document.querySelector('meta[itemprop="sku"]')?.content;
        if (meta && /^\d{4,10}$/.test(meta)) return meta;
        // 2) JSON blobs — "skuId":"6512123"
        const scripts = document.querySelectorAll("script");
        for (const s of scripts) {
          const txt = s.textContent || "";
          const m = txt.match(/"skuId"\s*:\s*"([0-9]{4,10})"/i);
          if (m) return m[1];
        }
        // 3) fallback visible text
        const bodyText = document.body.innerText || "";
        const m2 = bodyText.match(/\bSKU\s*:?[\s#]*([0-9]{4,10})\b/i);
        if (m2) return m2[1];
        return null;
      },
    },
  };

  // ---------- assets ----------
  const HTML_URL = chrome.runtime.getURL("content.html");
  const CSS_URL = chrome.runtime.getURL("content.css");
  const ICONS = {
    amazon: chrome.runtime.getURL("icons/amazon.png"),
    target: chrome.runtime.getURL("icons/target-circle.png"),
    walmart: chrome.runtime.getURL("icons/walmart.png"),
    bestbuy: chrome.runtime.getURL("icons/bestbuy.png"),
    apple: chrome.runtime.getURL("icons/apple.png"),
    samsung: chrome.runtime.getURL("icons/samsung.png"),
    lg: chrome.runtime.getURL("icons/lg.png"),
    segway: chrome.runtime.getURL("icons/segway.png"),
    default: chrome.runtime.getURL("icons/logo.png"),
    dji: chrome.runtime.getURL("icons/dji.png"),
  };

  const __cache = new Map();
  async function loadAsset(url) {
    if (__cache.has(url)) return __cache.get(url);
    const res = await fetch(url);
    const text = await res.text();
    __cache.set(url, text);
    return text;
  }

  const PS = {
  id: ROOT_ID,
  width: 380,
  open: false,
  root: null,
  shadow: null,

  // New: tracking for auto refresh
  watchTimer: null,
  lastKey: null,
  isPopulating: false,

  // Build a "key" for the current product and URL
  makeKey() {
    const site = siteOf();
    const D = DRIVERS[site] || DRIVERS.amazon;
    const asin = D.getASIN ? D.getASIN() : null;
    const sku = D.getStoreSKU ? D.getStoreSKU() : null;
    const title = D.getTitle ? D.getTitle() : null;
    return [site, asin, sku, title, location.href].join("|");
  },

  // Start watching for product changes while sidebar is open
  startWatcher() {
    if (this.watchTimer) return;
    this.lastKey = this.makeKey();
    this.watchTimer = setInterval(async () => {
      if (!this.open) return;
      const keyNow = this.makeKey();
      if (keyNow === this.lastKey) return;
      this.lastKey = keyNow;

      if (this.isPopulating) return;
      try {
        this.isPopulating = true;
        await this.populate();
      } finally {
        this.isPopulating = false;
      }
    }, 1200); // about once per second
  },

  // Stop watcher when sidebar is closed
  stopWatcher() {
    if (this.watchTimer) {
      clearInterval(this.watchTimer);
      this.watchTimer = null;
    }
  },

  async ensure() {
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
    document.documentElement.appendChild(root);
    const sh = root.attachShadow({ mode: "open" });

    const [html, css] = await Promise.all([
      loadAsset(HTML_URL),
      loadAsset(CSS_URL),
    ]);
    const style = document.createElement("style");
    style.textContent = css;
    const container = document.createElement("div");
    container.innerHTML = html;
    sh.appendChild(style);
    sh.appendChild(container);

    sh.querySelector("#ps-close")?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    });

    const logoEl = sh.querySelector("#ps-logo");
    if (logoEl) logoEl.src = chrome.runtime.getURL("icons/logo.png");

    this.root = root;
    this.shadow = sh;
    return root;
  },

  async populate() {
    if (!this.shadow) return;
    const sh = this.shadow;
    const site = siteOf();
    const D = DRIVERS[site] || DRIVERS.amazon;

    const snap = {
      title: D.getTitle(),
      asin: D.getASIN ? D.getASIN() : null,
      price_cents: D.getPriceCents ? D.getPriceCents() : null,
      store_sku: D.getStoreSKU ? D.getStoreSKU() : null,
    };
    await safeSet({ lastSnapshot: snap });

    const resultsEl = sh.querySelector("#ps-results");
    const statusEl =
      resultsEl.querySelector(".status") ||
      (() => {
        const el = document.createElement("div");
        el.className = "status";
        resultsEl.prepend(el);
        return el;
      })();
    statusEl.textContent = "Searching...";

    const prodLabelEl = sh.querySelector(".asin-row strong");
    const prodValEl = sh.querySelector("#ps-asin-val");

    if (prodLabelEl && prodValEl) {
      if (site === "amazon") {
        prodLabelEl.textContent = "ASIN";
        prodValEl.textContent = snap.asin || "Not found";
      } else if (site === "target") {
        prodLabelEl.textContent = "TCIN";
        prodValEl.textContent = snap.store_sku || "Not found";
      } else {
        prodLabelEl.textContent = "SKU";
        prodValEl.textContent = snap.store_sku || "Not found";
      }
    }

    let list = [];
    let resolvedASIN = snap.asin;

    if (site === "amazon") {
      if (!snap.asin) {
        statusEl.textContent = "ASIN not found.";
        return;
      }
      const resp = await safeSend({
        type: "COMPARE_REQUEST",
        payload: { asin: snap.asin },
      });
      list = Array.isArray(resp?.results) ? resp.results.slice() : [];
    } else {
      if (!snap.store_sku) {
        statusEl.textContent = "No product ID found.";
        return;
      }
      const resp = await safeSend({
        type: "RESOLVE_COMPARE_REQUEST",
        payload: { store: D.store, store_sku: snap.store_sku },
      });
      resolvedASIN = resp?.asin || null;
      list = Array.isArray(resp?.results) ? resp.results.slice() : [];
    }

    const bcEl = sh.querySelector("#ps-variant-val");
    if (bcEl) {
      let src = list.find((r) => (r.store || "").toLowerCase() === "amazon");
      if (!src) src = list.find((r) => r.brand || r.category);
      const brand = src?.brand || "";
      const category = src?.category || "";
      const bc = [brand, category].filter(Boolean).join(" ");
      bcEl.textContent = bc || "N/A";
    }

    statusEl.textContent = "";
    if (!list.length) {
      statusEl.textContent = "No prices found.";
      // still update lastKey so watcher does not spam
      this.lastKey = this.makeKey();
      return;
    }

    // Only keep entries with real prices
    const priced = list.filter(p => Number.isFinite(p?.price_cents));
    if (!priced.length) {
      statusEl.textContent = "No prices found.";
      this.lastKey = this.makeKey();
      return;
    }

    // Sort cheapest → most expensive
    priced.sort((a, b) => a.price_cents - b.price_cents);

    const ICON = (k) => ICONS[k] || ICONS.default;

    const currentStore = (D.store || "").toLowerCase();
    const currentRow = priced.find(
      r => (r.store || "").toLowerCase() === currentStore
    );
    const currentPrice = currentRow?.price_cents ?? null;

    const cheapestPrice = priced[0].price_cents;
    const mostExpensivePrice = priced[priced.length - 1].price_cents;

    resultsEl.innerHTML = "";

    priced.forEach(p => {
      const storeLower = (p.store || "").toLowerCase();
      const isCurrentSite = storeLower === currentStore;

      let tagsHTML = "";

      // GLOBAL savings: cheapest vs most expensive
      if (p.price_cents === cheapestPrice && mostExpensivePrice > cheapestPrice) {
        const diff = (mostExpensivePrice - cheapestPrice) / 100;
        tagsHTML += `<span class="savings-tag">Save $${diff.toFixed(2)}</span>`;
      }

      const card = document.createElement("a");
      card.className = "result-card";
      if (isCurrentSite) card.classList.add("current-site");

      card.href = p.url || "#";
      card.target = "_blank";
      card.innerHTML = `
        <div class="store-info">
          <img src="${ICON(storeLower)}" class="store-logo" />
          <div class="store-and-product">
            <span class="store-name">${storeLabel(p.store)}</span>
          </div>
        </div>
        <div class="price-info">
          <span class="price">$${(p.price_cents / 100).toFixed(2)}</span>
          ${tagsHTML}
        </div>
      `;
      resultsEl.appendChild(card);
    });


    // refresh the key after a successful populate
    this.lastKey = this.makeKey();
  },

  async openSidebar() {
    await this.ensure();
    this.open = true;
    this.root.style.transform = "translateX(0%)";
    await this.populate();
    this.startWatcher();
  },

  close() {
    this.open = false;
    this.root.style.transform = "translateX(-100%)";
    this.stopWatcher();
  },

  toggle() {
    this.open ? this.close() : this.openSidebar();
  },

  init() {
    chrome.runtime?.onMessage.addListener((m) => {
      if (m?.type === "TOGGLE_SIDEBAR") this.toggle();
    });
    globalThis.__PC_SINGLETON__ = this;
  },
};


  PS.init();
})();
