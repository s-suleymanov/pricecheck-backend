import { clean, toCents } from "./env.js";

function getAmazonPriceCents() {
  const toCents2 = (s) => {
    const n = parseFloat(String(s || "").replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) ? Math.round(n * 100) : null;
  };

  {
    const v = document.querySelector("#attach-base-product-price")?.getAttribute("value");
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
    const ctx = ctxEl ? (ctxEl.innerText || ctxEl.textContent || "") : "";
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
    const nodes = r.querySelectorAll(".a-price .a-offscreen, span.a-price.a-text-price span.a-offscreen");
    for (const el of nodes) {
      const raw = (el.textContent || "").trim();
      if (!raw || !raw.includes("$")) continue;
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

  return candidates.length ? Math.min(...candidates) : null;
}

export const DRIVERS = {
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
      const fromUrl = location.pathname.match(/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?]|$)/i)?.[1];
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
    getStoreSKU() { return null; },
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
    getASIN() { return null; },
    getStoreSKU() {
      const href = String(location.href);
      let m = href.match(/\/-\/A-(\d{8})(?:\b|\/|\?|#)/i);
      if (m) return m[1];
      const qp = new URL(href).searchParams.get("tcin");
      if (qp && /^\d{8}$/.test(qp)) return qp;
      for (const s of document.querySelectorAll("script")) {
        const txt = s.textContent || "";
        const tcin = txt.match(/"tcin"\s*:\s*"(\d{8})"/i);
        if (tcin) return tcin[1];
      }
      return null;
    },
  },

  walmart: {
    store: "Walmart",
    getTitle() { return clean(document.querySelector("h1")?.innerText || document.title); },
    getPriceCents() {
      const el =
        document.querySelector('[itemprop="price"]') ||
        document.querySelector('[data-automation-id="product-price"]');
      const raw = el?.getAttribute?.("content") || el?.textContent || "";
      return toCents(raw);
    },
    getASIN() { return null; },
    getStoreSKU() {
      const path = String(location.pathname || "");
      let m = path.match(/\/ip\/(?:[^/]+\/)?([0-9]{6,20})(?:$|[/?#])/i);
      if (m) return m[1];
      try {
        const qp = new URL(location.href).searchParams.get("itemId");
        if (qp && /^[0-9]{6,20}$/.test(qp)) return qp;
      } catch {}
      for (const s of document.querySelectorAll("script")) {
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
    getASIN() { return null; },
    getStoreSKU() {
      const meta = document.querySelector('meta[itemprop="sku"]')?.content;
      if (meta && /^\d{4,10}$/.test(meta)) return meta;
      for (const s of document.querySelectorAll("script")) {
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
