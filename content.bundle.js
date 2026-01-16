(() => {
  // src_content/sidebar.js
  function initPriceCheck() {
    "use strict";
    try {
      document.documentElement.dataset.pricecheckInit = "1";
    } catch {}

    const ROOT_ID = "pricecheck-sidebar-root";
    const hasChrome = () => typeof chrome !== "undefined" && chrome?.runtime?.id;

    const safeSend = (msg) =>
      new Promise((res) => {
        try {
          chrome.runtime.sendMessage(msg, (r) => {
            const err = chrome.runtime?.lastError;
            if (err) return res(null);
            res(r);
          });
        } catch (e) {
          res(null);
        }
      });

    const safeSet = async (kv) => {
      try {
        if (hasChrome()) await chrome.storage.local.set(kv);
      } catch {}
    };

    const safeGet = async (keys) => {
      try {
        if (hasChrome()) return await chrome.storage.local.get(keys);
      } catch {}
      return {};
    };

    const PEEK_KEY = "pc_peek_tab_pinned";

    const clean = (s = "") =>
      s
        .replace(/[\u200E\u200F\u202A-\u202E]/g, "")
        .replace(/\s+/g, " ")
        .trim();

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

    const storeKey = (s) =>
      String(s || "")
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "");

    const STORE_LABELS = {
      amazon: "Amazon",
      target: "Target",
      walmart: "Walmart",
      niu: "NIU",
      bestbuy: "Best Buy",
      bby: "Best Buy",
      soloperformance: "Solo Performance",
      radicaladventures: "Radical Adventures",
      brandsmart: "BrandsMart",
      aliexpress: "AliExpress",
      electricsport: "Electric Sport",
      electricride: "Electric Ride",
      gotrax: "GoTrax",
      doordash: "DoorDash",
      "5thwheel": "5th Wheel",
      aovo: "AOVO",
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
      electricmovement: "Electric Movement",
      hoverboardcom: "Hoverboard.com",
      wilsonsbikes: "Wilson's Bikes",
    };

    const storeLabel = (s) => {
      const k = storeKey(s);
      if (k === "bestbuycom" || k === "bestbuyinc") return "Best Buy";
      if (STORE_LABELS[k]) return STORE_LABELS[k];
      const raw = String(s || "").trim();
      if (!raw) return "Unknown";
      return raw.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
    };

    function getAmazonPriceCents() {
      const toCents2 = (s) => {
        const n = parseFloat(String(s || "").replace(/[^0-9.]/g, ""));
        return Number.isFinite(n) ? Math.round(n * 100) : null;
      };

      {
        const v = document
          .querySelector("#attach-base-product-price")
          ?.getAttribute("value");
        const c = toCents2(v);
        if (Number.isFinite(c) && c > 0) return c;
      }

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
          x.includes("or $")
        );
      };

      const isBadContext = (el) => {
        if (!el) return true;
        if (el.closest(".a-text-price")) return true;
        const ctxEl = el.closest("section,div,li,span") || el.parentElement || root;
        const ctx = ctxEl ? ctxEl.innerText || ctxEl.textContent || "" : "";
        return badText(ctx);
      };

      const candidates = [];

      const preferredRoots = [
        root.querySelector("#priceToPay") || root.querySelector('[data-testid="priceToPay"]'),
        root.querySelector("#corePrice_feature_div"),
        root.querySelector("#corePriceDisplay_desktop_feature_div"),
        root.querySelector("#corePriceDisplay_mobile_feature_div"),
        root,
      ].filter(Boolean);

      for (const r of preferredRoots) {
        const nodes = r.querySelectorAll(
          ".a-price .a-offscreen, span.a-price.a-text-price span.a-offscreen"
        );
        for (const el of nodes) {
          const raw = (el.textContent || "").trim();
          if (!raw) continue;
          if (!raw.includes("$")) continue;
          if (isBadContext(el)) continue;
          const cents = toCents2(raw);
          if (Number.isFinite(cents) && cents > 0) candidates.push(cents);
        }
        if (candidates.length) break;
      }

      if (!candidates.length) {
        for (const r of preferredRoots) {
          const whole = r.querySelector(".a-price-whole");
          const frac = r.querySelector(".a-price-fraction");
          if (whole && !isBadContext(whole)) {
            const w = (whole.textContent || "").replace(/[^\d]/g, "");
            const f = (frac?.textContent || "").replace(/[^\d]/g, "");
            if (w) {
              const s = f ? `${w}.${f.padEnd(2, "0").slice(0, 2)}` : w;
              const cents = toCents2(s);
              if (Number.isFinite(cents) && cents > 0) return cents;
            }
          }
        }
      }

      if (candidates.length) return Math.min(...candidates);
      return null;
    }

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
          const fromAttr = document.querySelector("[data-asin]")?.getAttribute("data-asin");
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
          let m = href.match(/\/-\/A-(\d{8})(?:\b|\/|\?|#)/i);
          if (m) return m[1];
          const qp = new URL(href).searchParams.get("tcin");
          if (qp && /^\d{8}$/.test(qp)) return qp;
          const scripts = document.querySelectorAll("script");
          for (const s of scripts) {
            const txt = s.textContent || "";
            const tcin = txt.match(/"tcin"\s*:\s*"(\d{8})"/i);
            if (tcin) return tcin[1];
          }
          return null;
        },
      },

      walmart: {
        store: "Walmart",
        getTitle() {
          return clean(document.querySelector("h1")?.innerText || document.title);
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
          try {
            const qp = new URL(location.href).searchParams.get("itemId");
            if (qp && /^[0-9]{6,20}$/.test(qp)) return qp;
          } catch {}
          const scripts = document.querySelectorAll("script");
          for (const s of scripts) {
            const txt = s.textContent || "";
            const m2 = txt.match(/"itemId"\s*:\s*"([0-9]{6,20})"/i);
            if (m2) return m2[1];
          }
          return null;
        },
      },

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
          {
            const m =
              document.querySelector('meta[property="product:price:amount"]')?.content ||
              document.querySelector('meta[itemprop="price"]')?.content;
            const c = toCents(m);
            if (Number.isFinite(c) && c > 0) return c;
          }
          {
            const el =
              document.querySelector(".priceView-hero-price span[aria-hidden='true']") ||
              document.querySelector(".priceView-customer-price span") ||
              document.querySelector('[data-testid="customer-price"] span') ||
              document.querySelector('[data-testid="customer-price"]') ||
              document.querySelector('[data-testid="customer-price"]');
            const c = toCents(el?.textContent || "");
            if (Number.isFinite(c) && c > 0) return c;
          }
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
          const meta = document.querySelector('meta[itemprop="sku"]')?.content;
          if (meta && /^\d{4,10}$/.test(meta)) return meta;

          const scripts = document.querySelectorAll("script");
          for (const s of scripts) {
            const txt = s.textContent || "";
            const m = txt.match(/"skuId"\s*:\s*"([0-9]{4,10})"/i);
            if (m) return m[1];
          }

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

    function centsToUSD(c) {
      return `$${(c / 100).toFixed(2)}`;
    }

    function setHtml(rootEl, sel, html) {
      const el = rootEl.querySelector(sel);
      if (!el) return;
      el.innerHTML = String(html ?? "");
    }

    function setText(rootEl, sel, val) {
      const el = rootEl.querySelector(sel);
      if (!el) return;
      el.textContent = String(val ?? "");
    }

    function showEl(rootEl, sel, show) {
      const el = rootEl.querySelector(sel);
      if (!el) return;
      el.hidden = !show;
    }

    function priceFor(p) {
      return Number.isFinite(p?.effective_price_cents) ? p.effective_price_cents : p?.price_cents;
    }

    function nonEmpty(s) {
      return !!String(s || "").trim();
    }

    function bestCouponOffer(list) {
      const withDeterministic = list
        .filter(
          (p) =>
            Number.isFinite(p?.price_cents) &&
            Number.isFinite(p?.effective_price_cents) &&
            p.effective_price_cents < p.price_cents
        )
        .sort((a, b) => a.effective_price_cents - b.effective_price_cents);

      return withDeterministic[0] || null;
    }

    function resetFooterCoupon(rootEl) {
      if (!rootEl || !rootEl.querySelector) return;

      rootEl.classList.remove("pc-has-coupon");

      const iconEl = rootEl.querySelector("#ps-footer-coupon-store-icon");
      if (iconEl) {
        iconEl.hidden = true;
        iconEl.removeAttribute("src");
        iconEl.removeAttribute("alt");
      }

      setText(rootEl, "#ps-footer-coupon-text", "");
      setText(rootEl, "#ps-footer-coupon-effective", "");
      setHtml(rootEl, "#ps-footer-coupon-pills", "");
      showEl(rootEl, "#ps-footer-coupon-pills", false);

      const couponEl = rootEl.querySelector("#ps-footer-coupon");
      if (couponEl) couponEl.hidden = true;
            if (couponEl) {
        couponEl.style.cursor = "";
        couponEl.removeAttribute("role");
        couponEl.removeAttribute("tabindex");
        couponEl.onclick = null;
        couponEl.onkeydown = null;
      }
    }

    function couponTopLine(p) {
      const t = String(p?.coupon_text || "").trim();
      if (!t) return "";
      return t.replace(/^\s*coupons?\s*:\s*/i, "").trim();
    }

    function couponPillsHTML(p) {
      const pills = [];

      const code = String(p?.coupon_code || "").trim();
      if (code) pills.push(`<span class="pill pill--muted">Code ${escHtml(code)}</span>`);

      if (p?.coupon_requires_clip === true) {
        pills.push(`<span class="pill pill--muted">Clip</span>`);
      }

      return pills.join("");
    }

    function updateFooter(rootEl, list) {
      const c = bestCouponOffer(list);

      if (c) {
        const iconEl = rootEl.querySelector("#ps-footer-coupon-store-icon");
        if (iconEl) {
          const k = storeKey(c.store);
          const src = ICONS[k] || ICONS.default;

          iconEl.src = src;
          rootEl.classList.add("pc-has-coupon");
          iconEl.alt = storeLabel(c.store);
          iconEl.hidden = false;
        }

        setText(rootEl, "#ps-verdict-label", "Coupons available");

        const couponEl = rootEl.querySelector("#ps-footer-coupon");
        if (!couponEl) return;

        couponEl.hidden = false;

          // Make coupon area clickable to the specific store offer page
        const href = String(c.url || "").trim();
        if (href) {
          couponEl.style.cursor = "pointer";
          couponEl.setAttribute("role", "link");
          couponEl.setAttribute("tabindex", "0");
          couponEl.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            window.open(href, "_blank", "noopener,noreferrer");
          };
          couponEl.onkeydown = (e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              window.open(href, "_blank", "noopener,noreferrer");
            }
          };
        } else {
          couponEl.style.cursor = "";
          couponEl.removeAttribute("role");
          couponEl.removeAttribute("tabindex");
          couponEl.onclick = null;
          couponEl.onkeydown = null;
        }

        setText(rootEl, "#ps-footer-coupon-text", couponTopLine(c));

        const pills = couponPillsHTML(c);
        setHtml(rootEl, "#ps-footer-coupon-pills", pills);
        showEl(rootEl, "#ps-footer-coupon-pills", !!pills);

        const eff = c?.effective_price_cents;
        if (Number.isFinite(eff)) {
          setText(rootEl, "#ps-footer-coupon-effective", centsToUSD(eff));
        } else {
          setText(rootEl, "#ps-footer-coupon-effective", "");
        }

        return;
      }

      rootEl.classList.remove("pc-has-coupon");
      setText(rootEl, "#ps-verdict-label", "No additional details");

      const couponEl = rootEl.querySelector("#ps-footer-coupon");
      if (couponEl) couponEl.hidden = true;

      if (couponEl) {
        couponEl.style.cursor = "";
        couponEl.removeAttribute("role");
        couponEl.removeAttribute("tabindex");
        couponEl.onclick = null;
        couponEl.onkeydown = null;
      }

      const iconEl = rootEl.querySelector("#ps-footer-coupon-store-icon");
      if (iconEl) {
        iconEl.hidden = true;
        iconEl.removeAttribute("src");
        iconEl.removeAttribute("alt");
      }

      setText(rootEl, "#ps-footer-coupon-text", "");
      setText(rootEl, "#ps-footer-coupon-effective", "");
      setHtml(rootEl, "#ps-footer-coupon-pills", "");
      showEl(rootEl, "#ps-footer-coupon-pills", false);
    }

    function getAmazonCouponSnap() {
      const price = getAmazonPriceCents();
      if (!Number.isFinite(price)) return null;

      const roots = [
        document.querySelector("#vpcButton")?.closest("div"),
        document.querySelector("#couponBadge")?.closest("div"),
        document.querySelector("[data-testid='coupon']"),
        document.querySelector("[id^='coupon']"),
        document.querySelector("[id*='Coupon']"),
        document.querySelector("#promoPriceBlockMessage_feature_div"),
        document.querySelector("#promotions_feature_div"),
        document.querySelector("#dealBadge_feature_div"),
      ].filter(Boolean);

      if (!roots.length) return null;

      const lines = [];
      for (const r of roots) {
        const t = clean(r.innerText || r.textContent || "");
        if (!t) continue;

        t.split(/\r?\n/).forEach((ln) => {
          const s = clean(ln);
          if (!s || s.length > 80) return;

          if (/^\s*terms\s*$/i.test(s)) return;
          if (/\|\s*terms\s*$/i.test(s)) return;

          const looksCoupon =
            /\b(clip|coupon|save|off|discount|deal|promotion|promo)\b/i.test(s) ||
            /\$\s*\d/i.test(s) ||
            /\b\d{1,2}\s*%\b/.test(s);

          if (!looksCoupon) return;

          lines.push(s);
        });
      }

      const joined = clean(lines.join(" • "));
      if (!joined) return null;

      let coupon_type = null;
      let coupon_value_cents = null;
      let coupon_value_pct = null;

      const mCents =
        joined.match(/\$\s*([0-9]+(?:\.[0-9]{1,2})?)\s*off\b/i) ||
        joined.match(/\bapply\s*\$\s*([0-9]+(?:\.[0-9]{1,2})?)\s*coupon\b/i);

      if (mCents) {
        coupon_type = "amount";
        coupon_value_cents = Math.round(parseFloat(mCents[1]) * 100);
      }

      const mPct = joined.match(/([0-9]{1,2})\s*%\s*off/i);
      if (!coupon_type && mPct) {
        coupon_type = "percent";
        coupon_value_pct = Math.min(99.99, Math.max(0, parseFloat(mPct[1])));
      }

      const coupon_text = coupon_type ? joined : /clip/i.test(joined) ? "Clip coupon" : "Coupon";
      const coupon_requires_clip = /clip/i.test(joined);

      let effective_price_cents = null;
      if (coupon_type === "amount" && Number.isFinite(coupon_value_cents)) {
        effective_price_cents = Math.max(0, price - coupon_value_cents);
      } else if (coupon_type === "percent" && Number.isFinite(coupon_value_pct)) {
        effective_price_cents = Math.max(0, Math.round(price * (1 - coupon_value_pct / 100)));
      }

      return {
        coupon_text,
        coupon_type,
        coupon_value_cents,
        coupon_value_pct,
        coupon_requires_clip,
        coupon_code: null,
        coupon_expires_at: null,
        effective_price_cents,
        coupon_observed_at: new Date().toISOString(),
      };
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

    function offerTagPill(offer_tag) {
      const t = String(offer_tag || "").trim();
      if (!t) return "";
      return `<span class="pill pill--muted offer-pill">${escHtml(t)}</span>`;
    }

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

    function slugify(s) {
      const t = clean(String(s || ""))
        .toLowerCase()
        .replace(/&/g, " and ")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .replace(/-+/g, "-");
      return t || "product";
    }

    function parseKey(key) {
      const t = String(key || "").trim();
      const m = t.match(/^([a-z]+)\s*:\s*(.+)$/i);
      if (!m) return null;

      const kindRaw = m[1].toLowerCase();
      let value = String(m[2] || "").trim();

      const kindMap = {
        asin: "asin",
        upc: "upc",
        pci: "pci",
        tcin: "tcin",
        bby: "bby",
        wal: "wal",
        walmart: "wal",
        sku: "sku",
        target: "tcin",
      };

      const kind = kindMap[kindRaw] || kindRaw;

      if (kind === "asin" || kind === "pci") value = value.toUpperCase();
      if (kind === "upc") value = value.replace(/\D/g, "");
      if (kind === "tcin") value = value.replace(/\D/g, "");
      if (kind === "bby" || kind === "wal" || kind === "sku") value = value.replace(/\s+/g, "");
      if (!value) return null;

      return { kind, value };
    }

    function dashboardUrlForKey(key, titleHint) {
      const parsed = parseKey(key);
      if (!parsed) return DASHBOARD_BASE;
      const slug = slugify(titleHint);
      return `${DASHBOARD_BASE}${slug}/${parsed.kind}/${encodeURIComponent(parsed.value)}/`;
    }

    function keyForCurrentPage(site, snap) {
      const asin = (snap?.asin || "").trim().toUpperCase();
      const sku = (snap?.store_sku || "").trim();
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
      container: null,
      populateTime: null,
      populateSeq: 0,
      lastGood: new Map(),
      watchTimer: null,
      lastKey: null,
      isPopulating: false,
      observeMem: new Map(),
      observeWindow: [],

      observeKey(site, snap) {
        const store = (DRIVERS[site]?.store || "").trim();
        const sku =
          site === "amazon"
            ? String(snap?.asin || "").trim().toUpperCase()
            : String(snap?.store_sku || "").trim();
        if (!store || !sku) return "";
        return `${store}::${sku}`;
      },

      getPeekTab() {
        return document.getElementById("ps-peek-tab");
      },

      observeAllowed(key, price_cents) {
        const now = Date.now();
        const windowMs = 10 * 60 * 1e3;
        this.observeWindow = this.observeWindow.filter((t) => now - t < windowMs);
        if (this.observeWindow.length >= 30) return false;

        const prev = this.observeMem.get(key);
        const thirtyMin = 30 * 60 * 1e3;
        if (prev && prev.price_cents === price_cents && now - prev.at < thirtyMin) {
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
        const sku = D.getStoreSKU ? D.getStoreSKU() : null;
        return [site, asin, sku, location.href].join("|");
      },

      startWatcher() {
        if (this.watchTimer) return;
        this.lastKey = this.makeKey();

        this.watchTimer = setInterval(() => {
          if (!this.open && !this.collapsed) return;


          const keyNow = this.makeKey();
          if (keyNow === this.lastKey) return;

          this.lastKey = keyNow;

          if (this.populateTimer) clearTimeout(this.populateTimer);
          this.populateTimer = setTimeout(async () => {
            if (!this.open && !this.collapsed) return;
            if (this.isPopulating) return;
            await this.populate();
          }, 350);
        }, 600);
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

      collapsed: false,
      hardClosed: false,
      summary: { count: 0, hasSavings: false, savingsCents: 0, bestPriceCents: null, hasCoupon: false },

      ensureTab() {
        const id = "ps-peek-tab";
        if (!this.root) return;

        // IMPORTANT: the tab lives on documentElement, not inside this.root
        let tab = document.getElementById(id);
        if (tab) return tab;

        tab = document.createElement("button");
        tab.id = id;
        tab.type = "button";
        tab.setAttribute("aria-label", "Show PriceCheck");
        tab.style.all = "initial";
        tab.style.position = "fixed";
        tab.style.top = "auto";
        tab.style.left = "0px";
        tab.style.bottom = "25px";
        tab.style.width = "100px";
        tab.style.height = "50px";
        tab.style.borderRadius = "0 14px 14px 0";
        tab.style.borderLeft = "0";
        tab.style.boxShadow = "0 6px 16px rgba(0,0,0,.14)";
        tab.style.border = "1px solid rgba(0,0,0,0.10)";
        tab.style.background = "#fff";
        tab.style.cursor = "pointer";
        tab.style.display = "none";
        tab.style.alignItems = "center";
        tab.style.justifyContent = "flex-end";
        tab.style.paddingRight = "14px"; 
        tab.style.userSelect = "none";
        tab.style.transition = "width 240ms ease, box-shadow 240ms ease, background 240ms ease, border-color 240ms ease";

        tab.innerHTML = `
          <div style="position:relative;width:100%;height:100%;display:flex;align-items:center;justify-content:flex-end;padding-right:10px;padding-top:2px;">
            <img id="ps-peek-logo" alt="" style="width:35px;height:35px;" />
            <div id="ps-peek-badge" style="
              position:absolute; 
              top:-10px; 
              right:-5.6px;
              min-width:20px; 
              height:20px; 
              padding:0 2px;
              border-radius:999px;
              font: 600 16px/18px system-ui, -apple-system, Segoe UI, Roboto, Arial;
              color:#fff;
              background:#6b7280;
              display:none;
              text-align:center;
            "></div>
          </div>
        `;

        tab.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.showFromCollapsed();
        });

      const W0 = "100px";
      const W1 = "110px";

      tab.addEventListener("mouseenter", () => {
        tab.style.width = W1;
        tab.style.boxShadow = "0 8px 20px rgba(0,0,0,.18)";
      });

      tab.addEventListener("mouseleave", () => {
        tab.style.width = W0;
        tab.style.boxShadow = "0 6px 16px rgba(0,0,0,.14)";
      });

        document.documentElement.appendChild(tab);

        const logo = tab.querySelector("#ps-peek-logo");
        if (logo) {
          // Always use the same asset, we only toggle grayscale via CSS filter.
          logo.src = chrome.runtime.getURL("icons/logo.png");
          logo.style.filter = "grayscale(1)";
        }

        return tab;
      },

      renderTab() {
        const tab = this.ensureTab();
        if (!tab) return;

        const badge = tab.querySelector("#ps-peek-badge");
        const s = this.summary || { count: 0, hasSavings: false, hasCoupon: false };
        const logo = tab.querySelector("#ps-peek-logo");
        if (logo) {
          // Colored if there is any meaningful signal, otherwise grey.
          const active = (s.count > 1) || !!s.hasSavings || !!s.hasCoupon;

          // Keep src stable to avoid caching and update issues.
          if (!logo.src || !logo.src.includes("icons/logo.png")) {
            logo.src = chrome.runtime.getURL("icons/logo.png");
          }

          logo.style.filter = active ? "none" : "grayscale(1)";
        }

        if (badge) {
          if (s.count > 1) {
            badge.textContent = String(Math.min(99, s.count));
            badge.style.display = "block";
          } else {
            badge.style.display = "none";
          }
        }

        const active = (s.count > 1) || !!s.hasSavings || !!s.hasCoupon;

        // Always solid white background (Google style)
        tab.style.background = "#ffffff";

        // Border is neutral when inactive, green ring when active
        tab.style.border = active
          ? "1px solid rgba(16,185,129,0.40)"
          : "1px solid rgba(0,0,0,0.10)";

        if (badge) {
          badge.style.background = active ? "#10b981" : "#6b7280";
        }
      },

      hideToCollapsed() {
        if (!this.root) return;
        this.collapsed = true;

        this.root.style.transform = "translateX(-100%)";

        const tab = this.ensureTab();
        if (tab) tab.style.display = "flex";

        this.renderTab();
        safeSet({ [PEEK_KEY]: true });
      },

      showFromCollapsed() {
        if (!this.root) return;
        this.collapsed = false;

        const tab = this.getPeekTab();
        if (tab) tab.remove();

        safeSet({ [PEEK_KEY]: false });

        this.root.style.transform = "translateX(0%)";
        this.populate().catch(() => {});
      },

      async ensure() {
        const existing = document.getElementById(this.id);

        if (existing) {
          this.root = existing;
          this.shadow = existing.shadowRoot;
          this.container =
            this.shadow?.querySelector("style")?.nextElementSibling || this.shadow?.querySelector("div");

          safeGet([PEEK_KEY]).then((st) => {
            if (st?.[PEEK_KEY] && !this.hardClosed) {
              this.collapsed = true;

              // IMPORTANT: keep it hidden on reload if minimized
              if (this.root) this.root.style.transform = "translateX(-100%)";

              const tab = this.ensureTab();
              if (tab) tab.style.display = "flex";
              this.renderTab();
            }
          });

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
        const [html, css] = await Promise.all([loadAsset(HTML_URL), loadAsset(CSS_URL)]);

        const style = document.createElement("style");
        style.textContent = css;

        const container = document.createElement("div");
        container.innerHTML = html;

        const found = container.querySelector("#ps-results");
        if (!found) {
          throw new Error("PriceCheck content.html missing #ps-results.");
        }

        sh.appendChild(style);
        sh.appendChild(container);

        this.container = container;

        container.querySelector("#ps-close")?.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.close();
        });

        container.querySelector("#ps-hide")?.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.hideToCollapsed();
        });

        const logoEl = container.querySelector("#ps-logo");
        if (logoEl) logoEl.src = chrome.runtime.getURL("icons/logo.png");

        this.root = root;
        this.shadow = sh;

        safeGet([PEEK_KEY]).then((st) => {
          if (st?.[PEEK_KEY] && !this.hardClosed) {
            this.collapsed = true;

            // IMPORTANT: keep it hidden on reload if minimized
            if (this.root) this.root.style.transform = "translateX(-100%)";

            const tab = this.ensureTab();
            if (tab) tab.style.display = "flex";
            this.renderTab();
          }
        });

        return root;
      },

      async populate() {
        if (!this.shadow) return;
        if (this.isPopulating) return;
        this.isPopulating = true;

        const seq = ++this.populateSeq;

        try {
          const sh = this.shadow;
          const root = this.container || sh;
          const rootEl = this.container || sh.host;

          resetFooterCoupon(rootEl);

          // Default summary for this page (assume no results until proven otherwise)
          this.summary = {
            count: 0,
            hasSavings: false,
            savingsCents: 0,
            bestPriceCents: null,
            hasCoupon: false,
          };
          if (this.collapsed) this.renderTab();

          const site = siteOf();

          {
            const footer =
              root.querySelector("#ps-footer") ||
              root.querySelector(".footer") ||
              root.querySelector("#ps-footer-link")?.parentElement;

            if (footer) {
              const hasXOverflow =
                Math.ceil(document.documentElement.scrollWidth) >
                Math.ceil(document.documentElement.clientWidth);

              footer.style.marginBottom = site === "amazon" && hasXOverflow ? "15px" : "";
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
            const storeSkuForObserve =
              site === "amazon"
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

                if (site === "bestbuy") payload.url = String(location.href || "");

                if (site === "amazon") {
                  const c = getAmazonCouponSnap();
                  if (c && Number.isFinite(c.effective_price_cents)) {
                    Object.assign(payload, c);
                  }
                }

                safeSend({ type: "OBSERVE_PRICE", payload })
                  .then((r) => {
                    if (r?.ok) this.observeRemember(key, price);
                  })
                  .catch(() => {});
              }
            }
          }

          await safeSet({ lastSnapshot: snap });

          {
            const a = root.querySelector("#ps-open");
            if (a) {
              const key = keyForCurrentPage(site, snap);
              a.href = dashboardUrlForKey(key, snap.title);
            }
          }

          const resultsEl = root.querySelector("#ps-results");
          if (!resultsEl) return;

          resultsEl.innerHTML = "";

          const statusEl = document.createElement("div");
          statusEl.className = "status";
          statusEl.textContent = "Searching...";
          resultsEl.appendChild(statusEl);

          {
            const warnEl = root.querySelector("#ps-warn");
            if (warnEl) warnEl.hidden = true;
          }

          {
            const prodLabelEl = root.querySelector("#ps-prod-label");
            const prodValEl = root.querySelector("#ps-asin-val");

            if (prodLabelEl) {
              if (site === "amazon") prodLabelEl.textContent = "ASIN";
              else if (site === "target") prodLabelEl.textContent = "TCIN";
              else if (site === "walmart") prodLabelEl.textContent = "Item ID";
              else if (site === "bestbuy") prodLabelEl.textContent = "SKU";
              else prodLabelEl.textContent = "Product";
            }

            if (prodValEl) {
              const val = site === "amazon" ? snap.asin || "Not found" : snap.store_sku || "Not found";
              prodValEl.textContent = val;
            }
          }

          const keyNow = this.makeKey();

          const callAPI = async () => {
            if (site === "amazon") {
              if (!snap.asin) return null;
              return await safeSend({ type: "COMPARE_REQUEST", payload: { asin: snap.asin } });
            } else {
              if (!snap.store_sku) return null;
              return await safeSend({
                type: "RESOLVE_COMPARE_REQUEST",
                payload: { store: site, store_sku: snap.store_sku },
              });
            }
          };

          let resp = await callAPI();

          if (seq !== this.populateSeq) return;

          if (!resp || !Array.isArray(resp.results)) {
            await new Promise((r) => setTimeout(r, 250));
            resp = await callAPI();
            if (seq !== this.populateSeq) return;
          }

          let list = Array.isArray(resp?.results) ? resp.results.slice() : null;

          if (!list) {
            const cached = this.lastGood.get(keyNow);
            if (cached && Date.now() - cached.at < 6e4) list = cached.results.slice();
            else list = [];
          }

          const recallUrl = Array.isArray(list)
            ? list.find((r) => nonEmpty(r?.recall_url))?.recall_url || null
            : null;

          setRecallAlert(root, recallUrl);

          {
            const warnEl = root.querySelector("#ps-warn");
            if (warnEl) {
              const show = Array.isArray(list) && list.some((r) => r?.dropship_warning === true);
              warnEl.hidden = !show;
            }
          }

          if (list.length) {
            this.lastGood.set(keyNow, { at: Date.now(), results: list.slice() });
          }

          {
            const bcEl = root.querySelector("#ps-variant-val");
            if (bcEl) {
              let src = list.find((r) => (r.store || "").toLowerCase() === "amazon");
              if (!src) src = list.find((r) => r.brand || r.category);
              const brand = src?.brand || "";
              const category = src?.category || "";
              const bc = [brand, category].filter(Boolean).join(" ");
              bcEl.textContent = bc || "N/A";
            }
          }

          if (!list.length) {
            if (site === "amazon" && !snap.asin) statusEl.textContent = "ASIN not found.";
            else if (site !== "amazon" && !snap.store_sku) statusEl.textContent = "No product ID found.";
            else statusEl.textContent = "No prices found.";

            this.summary = {
              count: 0,
              hasSavings: false,
              savingsCents: 0,
              bestPriceCents: null,
              hasCoupon: false,
            };
            if (this.collapsed) this.renderTab();

            this.lastKey = this.makeKey();
            resetFooterCoupon(rootEl);
            return;
          }

          const priced = list.filter((p) => Number.isFinite(priceFor(p)));

          if (!priced.length) {
          statusEl.textContent = "Matches found, but no stored prices yet.";
          const w = root.querySelector("#ps-warn");
          if (w) w.hidden = true;

          this.summary = {
            count: 0,
            hasSavings: false,
            savingsCents: 0,
            bestPriceCents: null,
            hasCoupon: false,
          };
          if (this.collapsed) this.renderTab();

          this.lastKey = this.makeKey();
          resetFooterCoupon(rootEl);
          return;
        }

          statusEl.remove();
        priced.sort((a, b) => priceFor(a) - priceFor(b));

          updateFooter(root, priced);

          const currentStoreKey = storeKey(DRIVERS[site]?.store || site);
          const currentOffer =
            priced.find((p) => storeKey(p.store) === currentStoreKey) || null;
          const currentPrice = currentOffer ? priceFor(currentOffer) : null;

          const cheapest = priceFor(priced[0]);
          const mostExp = priceFor(priced[priced.length - 1]);
          const savingsCents =
            Number.isFinite(cheapest) && Number.isFinite(mostExp) ? Math.max(0, mostExp - cheapest) : 0;

          const cheaperElsewhere =
            Number.isFinite(currentPrice) &&
            priced.some(
              (p) =>
                storeKey(p.store) !== currentStoreKey &&
                Number.isFinite(priceFor(p)) &&
                priceFor(p) < currentPrice
            );

          const cBest = bestCouponOffer(priced);

          this.summary = {
            count: priced.length,
            hasSavings: cheaperElsewhere,          // IMPORTANT: now means "cheaper elsewhere"
            savingsCents: cheaperElsewhere ? (currentPrice - cheapest) : 0,
            bestPriceCents: Number.isFinite(cheapest) ? cheapest : null,
            hasCoupon: !!cBest,
          };

          if (this.collapsed) this.renderTab();
          const ICON = (k) => ICONS[k] || ICONS.default;

          priced.forEach((p) => {
            const storeLower = storeKey(p.store);
            const isCurrentSite = storeLower === currentStoreKey;

           let tagsHTML = "";
            if (
              this.summary?.hasSavings &&
              Number.isFinite(currentPrice) &&
              Number.isFinite(cheapest) &&
              priceFor(p) === cheapest &&
              cheapest < currentPrice
            ) {
              const diff = (currentPrice - cheapest) / 100;
              tagsHTML = `<span class="savings-tag">Save $${diff.toFixed(2)}</span>`;
            }
            const card = document.createElement("a");
            card.className = "result-card";
            if (isCurrentSite) card.classList.add("current-site");
            card.href = p.url || "#";
            card.target = "_blank";

            const offerPillHTML = offerTagPill(p.offer_tag);

            const base = p?.price_cents;
            const eff = priceFor(p);
            const cardPrice = Number.isFinite(base) ? base : eff;

            const priceHTML = `<span class="price">${Number.isFinite(cardPrice) ? centsToUSD(cardPrice) : "—"}</span>`;

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
                ${priceHTML}
                ${tagsHTML}
              </div>
            `;

            resultsEl.appendChild(card);
          });

          this.lastKey = this.makeKey();
        } finally {
          if (seq === this.populateSeq) this.isPopulating = false;
        }
      },

      async openSidebar() {
        await this.ensure();
        this.hardClosed = false;
        this.open = true;

        const tab = this.getPeekTab();
        if (tab) tab.style.display = "none";

        if (this.collapsed) this.showFromCollapsed();
        else this.root.style.transform = "translateX(0%)";

        await this.populate();
        this.startWatcher();
      },

      close() {
        this.open = false;
        this.collapsed = false;
        this.hardClosed = true;

        if (this.root) this.root.style.transform = "translateX(-100%)";

        const tab = this.getPeekTab();
        if (tab) tab.remove();

        safeSet({ [PEEK_KEY]: false });

        this.stopWatcher();
      },
      toggle() {
        this.open ? this.close() : this.openSidebar();
      },

     init() {
      chrome.runtime?.onMessage.addListener((m, _sender, sendResponse) => {
        if (m?.type === "PC_PING") {
          sendResponse?.({ ok: true });
          return;
        }
        if (m?.type === "TOGGLE_SIDEBAR") this.toggle();
      });

      globalThis.__PC_SINGLETON__ = this;

      // Boot on page load if pinned
      safeGet([PEEK_KEY]).then((st) => {
        if (!st?.[PEEK_KEY]) return;

        // Create the sidebar root + tab even if user does not click toolbar icon
        this.ensure()
          .then(() => {
            this.open = true;        // allow watcher/populate loop to run
            this.collapsed = true;   // keep it minimized
            if (this.root) this.root.style.transform = "translateX(-100%)";

            const tab = this.ensureTab();
            if (tab) tab.style.display = "flex";

            this.populate().catch(() => {});
            this.startWatcher();
          })
          .catch(() => {});
      });
    },

    };

    PS.init();
  }

  // src_content/index.js
  (() => {
    "use strict";
    if (globalThis.__PC_INIT_DONE__) return;
    globalThis.__PC_INIT_DONE__ = true;
    initPriceCheck();
  })();
})();