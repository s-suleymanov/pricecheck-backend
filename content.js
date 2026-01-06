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

  const STORE_LABELS = {
    amazon: "Amazon",
    target: "Target",
    walmart: "Walmart",
    bestbuy: "Best Buy",
    bby: "Best Buy",

    soloperformance: "Solo Performance",
    radicaladventures: "Radical Adventures",
    brandsmart: "BrandsMart",
    aliexpress: "AliExpress",
    electricsport: "Electric Sport",
    electricride: "Electric Ride",

    apple: "Apple",
    dji: "DJI",
    segway: "Segway",
    iscooter: "iScooter",

    lg: "LG",
    sony: "Sony",
    asus: "ASUS",
    hp: "HP",
    dell: "Dell",
    bose: "Bose",
  };

  const storeLabel = (s) => {
  const k = storeKey(s);

  // normalize a couple common inputs
  if (k === "bestbuycom" || k === "bestbuyinc") return "Best Buy";

  // mapping wins
  if (STORE_LABELS[k]) return STORE_LABELS[k];

  // fallback: reasonable title-case
  const raw = String(s || "").trim();
  if (!raw) return "Unknown";
  return raw
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());
};

function getAmazonPriceCents() {
  const toCents = (s) => {
    const n = parseFloat(String(s || "").replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) ? Math.round(n * 100) : null;
  };

  // 1) Most reliable on many PDPs (your example)
  // <input type="hidden" id="attach-base-product-price" value="159.98" />
  {
    const v = document.querySelector("#attach-base-product-price")?.getAttribute("value");
    const c = toCents(v);
    if (Number.isFinite(c) && c > 0) return c;
  }

  // 2) Limit search to the main price boxes (avoid ads/other modules)
  const root =
    document.querySelector("#corePriceDisplay_desktop_feature_div") ||
    document.querySelector("#corePriceDisplay_mobile_feature_div") ||
    document.querySelector("#apex_desktop") ||
    document.querySelector("#apex_mobile") ||
    document.querySelector("#ppd") ||
    document.querySelector("#centerCol") ||
    document.body;

  const badText = (t) => {
    const x = String(t || "").toLowerCase();
    return (
      x.includes("list price") ||
      x.includes("typical price") ||
      x.includes("was:") ||
      x.includes("msrp") ||
      x.includes("reference price") ||
      x.includes("with trade-in") ||
      x.includes("/month") ||
      x.includes("/mo") ||
      x.includes("/week") ||
      x.includes("2 weeks") ||
      x.includes("per month") ||
      x.includes("installment") ||
      x.includes("installments") ||
      x.includes("affirm") ||
      x.includes("klarna") ||
      x.includes("or $") // "Or $40.00/2 weeks"
    );
  };

  const isBadContext = (el) => {
    if (!el) return true;

    // Strike/list price wrapper often used for crossed-out prices
    if (el.closest(".a-text-price")) return true;

    // Financing widgets often live in their own blocks
    const ctxEl = el.closest("section,div,li,span") || el.parentElement || root;
    const ctx = ctxEl ? (ctxEl.innerText || ctxEl.textContent || "") : "";
    return badText(ctx);
  };

  const candidates = [];

  // 3) Prefer "price to pay" and core current price blocks first
  const preferredRoots = [
    root.querySelector("#priceToPay") || root.querySelector('[data-testid="priceToPay"]'),
    root.querySelector("#corePrice_feature_div"),
    root.querySelector("#corePriceDisplay_desktop_feature_div"),
    root.querySelector("#corePriceDisplay_mobile_feature_div"),
    root,
  ].filter(Boolean);

  // 3a) Offscreen price spans (usually the real current price)
  for (const r of preferredRoots) {
    const nodes = r.querySelectorAll(".a-price .a-offscreen, span.a-price.a-text-price span.a-offscreen");
    for (const el of nodes) {
      const raw = (el.textContent || "").trim();
      if (!raw) continue;

      // Must look like a price and not be in financing/list context
      if (!raw.includes("$")) continue;
      if (isBadContext(el)) continue;

      const cents = toCents(raw);
      if (Number.isFinite(cents) && cents > 0) candidates.push(cents);
    }
    if (candidates.length) break; // stop early if we already got good candidates from preferred areas
  }

  // 3b) If offscreen is missing, reconstruct from whole + fraction in the core price area
  if (!candidates.length) {
    for (const r of preferredRoots) {
      const whole = r.querySelector(".a-price-whole");
      const frac = r.querySelector(".a-price-fraction");
      if (whole && !isBadContext(whole)) {
        const w = (whole.textContent || "").replace(/[^\d]/g, "");
        const f = (frac?.textContent || "").replace(/[^\d]/g, "");
        if (w) {
          const s = f ? `${w}.${f.padEnd(2, "0").slice(0, 2)}` : w;
          const cents = toCents(s);
          if (Number.isFinite(cents) && cents > 0) return cents;
        }
      }
    }
  }

  if (candidates.length) {
    // If both current and other prices leak in, current is almost always the smallest real price candidate
    return Math.min(...candidates);
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
    const href = String(location.href);

    // 1) Most common Target PDP format: .../-/A-########
    let m = href.match(/\/-\/A-(\d{8})(?:\b|\/|\?|#)/i);
    if (m) return m[1];

    // 1b) Sometimes present as a query param
    const qp = new URL(href).searchParams.get("tcin");
    if (qp && /^\d{8}$/.test(qp)) return qp;

    // 2) JSON blobs (fallback)
    const scripts = document.querySelectorAll("script");
    for (const s of scripts) {
      const txt = s.textContent || "";
      const tcin = txt.match(/"tcin"\s*:\s*"(\d{8})"/i);
      if (tcin) return tcin[1];
    }

    return null;
  }
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
        const path = String(location.pathname || "");

        let m = path.match(/\/ip\/(?:[^/]+\/)?([0-9]{6,20})(?:$|[/?#])/i);
        if (m) return m[1];

        // Fallback: sometimes itemId is in the query params
        try {
          const qp = new URL(location.href).searchParams.get("itemId");
          if (qp && /^[0-9]{6,20}$/.test(qp)) return qp;
        } catch {}

        // Fallback from script JSON
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
      store: "Best Buy",
      getTitle() {
        return clean(
          document.querySelector(".sku-title h1")?.innerText ||
            document.querySelector("h1")?.innerText ||
            document.title
        );
      },
      getPriceCents() {
        // 1) meta tags (very reliable when present)
        {
          const m =
            document.querySelector('meta[property="product:price:amount"]')?.content ||
            document.querySelector('meta[itemprop="price"]')?.content;
          const c = toCents(m);
          if (Number.isFinite(c) && c > 0) return c;
        }

        // 2) visible hero price (your current approach)
        {
          const el =
            document.querySelector(".priceView-hero-price span[aria-hidden='true']") ||
            document.querySelector(".priceView-customer-price span") ||
            document.querySelector('[data-testid="customer-price"] span') ||
            document.querySelector('[data-testid="customer-price"]');
          const c = toCents(el?.textContent || "");
          if (Number.isFinite(c) && c > 0) return c;
        }

        // 3) last resort: search inside the main pricing area only
        {
          const root =
            document.querySelector('[data-testid="pricing-price"]') ||
            document.querySelector(".priceView-layout") ||
            document.querySelector("#pricing-price") ||
            document.querySelector("main") ||
            document.body;

          const nodes = root.querySelectorAll("span");
          for (const n of nodes) {
            const t = (n.textContent || "").trim();
            if (!t.includes("$")) continue;
            const c = toCents(t);
            if (Number.isFinite(c) && c > 0) return c;
          }
        }
        return null;
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

  function escHtml(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
    }

    function nonEmpty(s) {
    return !!String(s || "").trim();
  }

  function setRecallAlert(sh, recallUrl) {
    const el = sh?.querySelector?.("#ps-recall");
    if (!el) return;

    const hasRecall = !!String(recallUrl || "").trim();
    el.hidden = !hasRecall;

    if (hasRecall) {
      el.style.cursor = "pointer";
      el.onclick = () =>
        window.open(String(recallUrl).trim(), "_blank", "noopener,noreferrer");
    } else {
      el.style.cursor = "";
      el.onclick = null;
    }
  }

  function offerTagPill(offer_tag, isCurrent = false) {
    const t = String(offer_tag || "").trim();
    if (!t) return "";
    const cls = isCurrent ? "offer-pill offer-pill--current" : "offer-pill";
    return `<span class="${cls}">${escHtml(t)}</span>`;
  }

  // ---------- assets ----------
  const HTML_URL = chrome.runtime.getURL("content.html");
  const CSS_URL = chrome.runtime.getURL("content.css");
  const ICONS = {
    amazon: chrome.runtime.getURL("icons/amazon.webp"),
    target: chrome.runtime.getURL("icons/target-circle.webp"),
    walmart: chrome.runtime.getURL("icons/walmart.webp"),
    bestbuy: chrome.runtime.getURL("icons/bestbuy.webp"),
    apple: chrome.runtime.getURL("icons/apple.webp"),
    samsung: chrome.runtime.getURL("icons/samsung.webp"),
    lg: chrome.runtime.getURL("icons/lg.webp"),
    segway: chrome.runtime.getURL("icons/segway.webp"),
    default: chrome.runtime.getURL("icons/logo.png"),
    dji: chrome.runtime.getURL("icons/dji.webp"),
    hiboy: chrome.runtime.getURL("icons/hiboy.webp"),
    iscooter: chrome.runtime.getURL("icons/iscooter.webp"),
    radicaladventures: chrome.runtime.getURL("icons/radicaladventures.webp"),
    soloperformance: chrome.runtime.getURL("icons/sps.webp"),
    alibaba: chrome.runtime.getURL("icons/alibaba.webp"),
    temu: chrome.runtime.getURL("icons/temu.png"),
  };

  const __cache = new Map();
  async function loadAsset(url) {
    if (__cache.has(url)) return __cache.get(url);
    const res = await fetch(url);
    const text = await res.text();
    __cache.set(url, text);
    return text;
  }
  
  const DASHBOARD_BASE = "https://www.pricechecktool.com/dashboard/";

  function dashboardUrlForKey(key) {
    if (!key) return DASHBOARD_BASE;
    return `${DASHBOARD_BASE}?key=${encodeURIComponent(key)}`;
  }

  function keyForCurrentPage(site, snap) {
    const asin = (snap?.asin || "").trim().toUpperCase();
    const sku  = (snap?.store_sku || "").trim();

    if (site === "amazon" && asin) return `asin:${asin}`;
    if (site === "target" && sku) return `tcin:${sku}`;
    if (site === "walmart" && sku) return `wal:${sku}`;
    if (site === "bestbuy" && sku) return `bby:${sku}`;

    return "";
  }

  const PS = {
  id: ROOT_ID,
  width: 380,
  open: false,
  root: null,
  populateTimer: null,
  shadow: null,
  populateTime: null,
  populateSeq: 0, 
  lastGood: new Map(), // key -> { at, results }

  // New: tracking for auto refresh
  watchTimer: null,
  lastKey: null,
  isPopulating: false,
  observeMem: new Map(), // key -> { at, price_cents }
  observeWindow: [],     // timestamps for simple rate limit

  observeKey(site, snap) {
    const store = (DRIVERS[site]?.store || "").trim();
    const sku = site === "amazon"
      ? String(snap?.asin || "").trim().toUpperCase()
      : String(snap?.store_sku || "").trim();
    if (!store || !sku) return "";
    return `${store}::${sku}`;
  },

  observeAllowed(key, price_cents) {
    const now = Date.now();

    // basic per-install rate limit: max 30 observes per 10 minutes
    const windowMs = 10 * 60 * 1000;
    this.observeWindow = this.observeWindow.filter((t) => now - t < windowMs);
    if (this.observeWindow.length >= 30) return false;

    const prev = this.observeMem.get(key);
    const thirtyMin = 30 * 60 * 1000;
    if (prev && prev.price_cents === price_cents && (now - prev.at) < thirtyMin) {
      return false;
    }

    return true;
  },

  observeRemember(key, price_cents) {
    const now = Date.now();
    this.observeWindow.push(now);
    this.observeMem.set(key, { at: now, price_cents });
  },

  makeKey() {
    const site = siteOf();
    const D = DRIVERS[site] || DRIVERS.amazon;
    const asin = D.getASIN ? D.getASIN() : null;
    const sku  = D.getStoreSKU ? D.getStoreSKU() : null;
    return [site, asin, sku, location.href].join("|");
  },

  startWatcher() {
    if (this.watchTimer) return;

    // Initialize
    this.lastKey = this.makeKey();

    this.watchTimer = setInterval(() => {
      if (!this.open) return;

      const keyNow = this.makeKey();
      if (keyNow === this.lastKey) return;

      this.lastKey = keyNow;

      // Debounce: collapse rapid changes into one populate
      if (this.populateTimer) clearTimeout(this.populateTimer);

      this.populateTimer = setTimeout(async () => {
        if (!this.open) return;
        if (this.isPopulating) return;

        await this.populate();
      }, 350);
    }, 600); // faster detection, but debounced so it won't spam
  },

  stopWatcher() {
    if (this.watchTimer) {
      clearInterval(this.watchTimer);
      this.watchTimer = null;
    }
    if (this.populateTimer) {
      clearTimeout(this.populateTimer);
      this.populateTimer = null;
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

  // Prevent overlapping populates (variant switches can trigger rapid changes)
  if (this.isPopulating) return;
  this.isPopulating = true;

  const seq = ++this.populateSeq;

  try {
    const sh = this.shadow;
    const site = siteOf();

    // Footer spacing: only when the page actually has horizontal overflow
    {
      const footer =
        sh.querySelector("#ps-footer") ||
        sh.querySelector(".footer") ||
        sh.querySelector("#ps-footer-link")?.parentElement;

      if (footer) {
        const hasXOverflow =
          Math.ceil(document.documentElement.scrollWidth) >
          Math.ceil(document.documentElement.clientWidth);

        footer.style.marginBottom = (site === "amazon" && hasXOverflow) ? "15px" : "";
      }
    }

    const D = DRIVERS[site] || DRIVERS.amazon;

    const snap = {
      title: D.getTitle(),
      asin: D.getASIN ? D.getASIN() : null,
      price_cents: D.getPriceCents ? D.getPriceCents() : null,
      store_sku: D.getStoreSKU ? D.getStoreSKU() : null,
    };

    {
      const price = snap.price_cents;
      const key = this.observeKey(site, snap);

      // For Amazon, store_sku in DB is the ASIN (per your listings-first setup)
      const storeSkuForObserve = site === "amazon"
        ? String(snap.asin || "").trim().toUpperCase()
        : String(snap.store_sku || "").trim();

      if (Number.isFinite(price) && key && storeSkuForObserve) {
        if (this.observeAllowed(key, price)) {
          const payload = {
            store: site,
            store_sku: storeSkuForObserve,
            price_cents: price,
            title: snap.title || "",
            observed_at: new Date().toISOString(),
          };

          if (site === "bestbuy") {
              payload.url = String(location.href || "");
          }

          // Fire and forget, but remember only if it succeeds
          safeSend({ type: "OBSERVE_PRICE", payload }).then((r) => {
            if (r?.ok) this.observeRemember(key, price);
          }).catch(() => {});
        }
      }
    }
    await safeSet({ lastSnapshot: snap });

    // Footer dashboard link
    {
      const a = sh.querySelector("#ps-footer-link");
      if (a) {
        const key = keyForCurrentPage(site, snap);
        a.href = dashboardUrlForKey(key);
      }
    }

    const resultsEl = sh.querySelector("#ps-results");
    if (!resultsEl) {
      console.warn(
        "PriceCheck: #ps-results not found. Check content.html loaded and contains id='ps-results'."
      );
      return;
    }

    resultsEl.innerHTML = "";

    const statusEl = document.createElement("div");
    statusEl.className = "status";
    statusEl.textContent = "Searching...";
    resultsEl.appendChild(statusEl);

    {
      const warnEl = sh.querySelector("#ps-warn");
      if (warnEl) warnEl.hidden = true;
    }

    // Header product id line
    {
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
    }

    const keyNow = this.makeKey();

    const callAPI = async () => {
      if (site === "amazon") {
        if (!snap.asin) return null;
        return await safeSend({
          type: "COMPARE_REQUEST",
          payload: { asin: snap.asin },
        });
      } else {
        if (!snap.store_sku) return null;
        return await safeSend({
          type: "RESOLVE_COMPARE_REQUEST",
          payload: { store: site, store_sku: snap.store_sku },
        });
      }
    };

    // ---- API call with retry + stale guard ----
    let resp = await callAPI();

    // If a newer populate started, do nothing (prevents stale overwrite)
    if (seq !== this.populateSeq) return;

    // Retry once on null/invalid response (service worker waking or transient hiccup)
    if (!resp || !Array.isArray(resp.results)) {
      await new Promise((r) => setTimeout(r, 250));
      resp = await callAPI();
      if (seq !== this.populateSeq) return;
    }

    // If still invalid, we will fall back to last-good cache (if any)
    let list = Array.isArray(resp?.results) ? resp.results.slice() : null;

    if (!list) {
      const cached = this.lastGood.get(keyNow);
      if (cached && (Date.now() - cached.at) < 60_000) {
        list = cached.results.slice();
      } else {
        list = [];
      }
    }

    // Recall alert (from catalog.recall_url surfaced as recall_url on results)
    const recallUrl = Array.isArray(list)
      ? (list.find(r => nonEmpty(r?.recall_url))?.recall_url || null)
      : null;

    setRecallAlert(sh, recallUrl);

    {
      const warnEl = sh.querySelector("#ps-warn");
      if (warnEl) {
        const show = Array.isArray(list) && list.some((r) => r?.dropship_warning === true);
        warnEl.hidden = !show;
      }
    }

    // Cache good results for this exact key to prevent "stuck empty" UI
    if (list.length) {
      this.lastGood.set(keyNow, { at: Date.now(), results: list.slice() });
    }

    // Brand + category line
    {
      const bcEl = sh.querySelector("#ps-variant-val");
      if (bcEl) {
        let src = list.find((r) => (r.store || "").toLowerCase() === "amazon");
        if (!src) src = list.find((r) => r.brand || r.category);
        const brand = src?.brand || "";
        const category = src?.category || "";
        const bc = [brand, category].filter(Boolean).join(" ");
        bcEl.textContent = bc || "N/A";
      }
    }

    statusEl.textContent = "";

    // If empty, show reason but do NOT let stale populates overwrite later
    if (!list.length) {
      if (site === "amazon" && !snap.asin) {
        statusEl.textContent = "ASIN not found.";
      } else if (site !== "amazon" && !snap.store_sku) {
        statusEl.textContent = "No product ID found.";
      } else {
        statusEl.textContent = "No prices found.";
      }
      this.lastKey = this.makeKey();
      return;
    }

    // Only keep entries with real prices
    const priced = list.filter((p) => Number.isFinite(p?.price_cents));
    if (!priced.length) {
      statusEl.textContent = list.length
        ? "Matches found, but no stored prices yet."
        : "No prices found.";

      sh.querySelector("#ps-warn") && (sh.querySelector("#ps-warn").hidden = true);

      this.lastKey = this.makeKey();
      return;
    }

    // Sort cheapest → most expensive
    priced.sort((a, b) => a.price_cents - b.price_cents);

    const ICON = (k) => ICONS[k] || ICONS.default;

    const currentStore = storeKey(site);
    // (currentRow currently unused, but kept for future)
    // const currentRow = priced.find((r) => storeKey(r.store) === currentStore);

    const cheapestPrice = priced[0].price_cents;
    const mostExpensivePrice = priced[priced.length - 1].price_cents;

    priced.forEach((p) => {
      const storeLower = storeKey(p.store);
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

      const offerPillHTML = offerTagPill(p.offer_tag, isCurrentSite);

      card.innerHTML = `
        <div class="store-info">
          <img src="${ICON(storeLower)}" class="store-logo" />
          <div class="store-and-product">
            <div class="store-line">
              <span class="store-name">${escHtml(storeLabel(p.store))}</span>
              ${offerPillHTML}
            </div>
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
  } finally {
    // Only clear if we are still the latest populate attempt
    if (seq === this.populateSeq) this.isPopulating = false;
  }
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
