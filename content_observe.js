(() => {
  if (globalThis.__PC_OBSERVE_LOADED__) return;
  globalThis.__PC_OBSERVE_LOADED__ = true;

  function clean(s = "") {
    return String(s || "")
      .replace(/[\u200E\u200F\u202A-\u202E]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function siteOf(h = location.hostname) {
    if (h.includes("amazon.")) return "amazon";
    if (h.includes("target.")) return "target";
    if (h.includes("walmart.")) return "walmart";
    if (h.includes("bestbuy.")) return "bestbuy";
    return "unknown";
  }

  function toCents(txt = "") {
    const n = parseFloat(String(txt).replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) ? Math.round(n * 100) : null;
  }

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
      const nodes = r.querySelectorAll(".a-price .a-offscreen, span.a-price.a-text-price span.a-offscreen");
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

  const DRIVERS = {
    amazon: {
      store: "amazon",
      getTitle() {
        return clean(
          document.getElementById("productTitle")?.innerText ||
          document.querySelector("#title span")?.innerText ||
          document.title
        );
      },
      getPriceCents: getAmazonPriceCents,
      getStoreSku() {
        const fromUrl = location.pathname.match(/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?]|$)/i)?.[1];
        const fromAttr = document.querySelector("[data-asin]")?.getAttribute("data-asin");
        const asin = (fromUrl || fromAttr || "").toUpperCase();
        return /^[A-Z0-9]{10}$/.test(asin) ? asin : null;
      },
      getCoupon() {
        return getAmazonCouponSnap();
      }
    },

    target: {
      store: "target",
      getTitle() {
        return clean(
          document.querySelector('h1[data-test="product-title"]')?.innerText ||
          document.querySelector('meta[property="og:title"]')?.content ||
          document.title
        );
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
          if (Number.isFinite(cents)) return cents;
        }
        return null;
      },
      getStoreSku() {
        const href = String(location.href || "");
        try {
          const u = new URL(href);
          const pre = (u.searchParams.get("preselect") || "").trim();
          if (/^\d{8}$/.test(pre)) return pre;
          const qp = (u.searchParams.get("tcin") || "").trim();
          if (/^\d{8}$/.test(qp)) return qp;
        } catch {}

        const m = href.match(/\/-\/A-(\d{8})(?:\b|\/|\?|#)/i);
        if (m) return m[1];

        for (const s of document.querySelectorAll("script")) {
          const txt = s.textContent || "";
          const tcin = txt.match(/"tcin"\s*:\s*"(\d{8})"/i);
          if (tcin) return tcin[1];
        }
        return null;
      },
      getCoupon() {
        return null;
      }
    },

    walmart: {
      store: "walmart",
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
      getStoreSku() {
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
      getCoupon() {
        return null;
      }
    },

    bestbuy: {
      store: "bestbuy",
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
          for (const n of root.querySelectorAll("span")) {
            const t = (n.textContent || "").trim();
            if (!t.includes("$")) continue;
            const c = toCents(t);
            if (Number.isFinite(c) && c > 0) return c;
          }
        }
        return null;
      },
      getStoreSku() {
        const extractSku = (raw = "") => {
          const s = String(raw || "");
          return (
            s.match(/[?&]skuId=(\d{4,10})(?:&|$)/i)?.[1] ||
            s.match(/\/(\d{4,10})\.p(?:\?|$)/i)?.[1] ||
            s.match(/\bSKU\s*[:#]?\s*(\d{4,10})\b/i)?.[1] ||
            null
          );
        };

        const urlCandidates = [
          location.href,
          document.querySelector('link[rel="canonical"]')?.href,
          document.querySelector('meta[property="og:url"]')?.content,
        ];

        for (const raw of urlCandidates) {
          const sku = extractSku(raw || "");
          if (sku) return sku;
        }

        const textRoots = [
          document.querySelector(".sku-product-data"),
          document.querySelector(".sku-title"),
          document.querySelector('[data-testid="pricing-price"]'),
          document.querySelector("main"),
          document.body,
        ].filter(Boolean);

        for (const root of textRoots) {
          const sku = extractSku(clean(root.innerText || root.textContent || ""));
          if (sku) return sku;
        }

        const ld = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
        for (const s of ld) {
          const txt = s.textContent || "";

          const quick = txt.match(/"sku"\s*:\s*"(\d{4,10})"/i);
          if (quick) return quick[1];

          if (!txt.includes("Product") || !txt.includes("sku")) continue;

          try {
            const data = JSON.parse(txt);
            const walk = (node) => {
              if (!node) return null;

              if (Array.isArray(node)) {
                for (const it of node) {
                  const r = walk(it);
                  if (r) return r;
                }
                return null;
              }

              if (typeof node === "object") {
                const t = node["@type"];
                const isProduct =
                  (typeof t === "string" && t.toLowerCase() === "product") ||
                  (Array.isArray(t) && t.map(String).some((x) => x.toLowerCase() === "product"));

                const sku = String(node.sku || "").trim();
                if (isProduct && /^\d{4,10}$/.test(sku)) return sku;

                if (node["@graph"]) return walk(node["@graph"]);

                for (const k of Object.keys(node)) {
                  const r = walk(node[k]);
                  if (r) return r;
                }
              }

              return null;
            };

            const found = walk(data);
            if (found) return found;
          } catch {}
        }

        const meta = document.querySelector('meta[itemprop="sku"]')?.content || "";
        const metaSku = extractSku(meta);
        if (metaSku) return metaSku;

        return null;
      },
      getCoupon() {
        return null;
      }
    }
  };

const PC_OPEN_AFTER_RELOAD_KEY = "__pc_open_sidebar_after_reload__";
const PC_FLOAT_ID = "pc-floating-trigger";
const PC_LOGO_URL = chrome.runtime.getURL("icons/logo.png");

function hasLiveRuntime() {
  return !!(globalThis.chrome && chrome.runtime && chrome.runtime.id);
}

let __pcFloatingLastCheckedKey = "";
let __pcFloatingLastMatched = null;
let __pcFloatingCheckInFlight = null;

function getFloatingTriggerKey() {
  const site = siteOf();
  const D = DRIVERS[site];
  const storeSku = D?.getStoreSku ? D.getStoreSku() : null;
  return site && storeSku ? `${site}:${storeSku}` : "";
}

function applyFloatingTriggerState(btn, matched) {
  const icon = btn.querySelector("img, span");

  btn.style.opacity = matched ? "1" : "0.72";
  btn.style.transform = "scale(1)";
  btn.title = matched ? "Open PriceCheck" : "No cross-store match yet";

  if (matched) {
    btn.style.boxShadow = "0 8px 22px rgba(0,0,0,0.22)";
    if (icon) icon.style.opacity = "1";
  } else {
    btn.style.boxShadow = "0 0 0 2px rgba(255,255,255,0.82), 0 6px 18px rgba(0,0,0,0.14)";
    if (icon) icon.style.opacity = "0.58";
  }
}

let __pcFloatingStateInFlight = false;

async function updateFloatingTriggerState() {
  const btn = document.getElementById(PC_FLOAT_ID);
  if (!btn) return;

  const key = getFloatingTriggerKey();
  if (!key) {
    applyFloatingTriggerState(btn, false);
    __pcFloatingLastCheckedKey = "";
    __pcFloatingLastMatched = null;
    return;
  }

  if (__pcFloatingLastCheckedKey === key && __pcFloatingLastMatched != null) {
    applyFloatingTriggerState(btn, __pcFloatingLastMatched);
    return;
  }

  if (__pcFloatingStateInFlight) return;
  __pcFloatingStateInFlight = true;

  try {
    const resp = await sendRuntimeMessage({ type: "PC_CHECK_MATCH_FOR_TAB" });
    const matched = !!(resp?.ok && resp.matched);

    __pcFloatingLastCheckedKey = key;
    __pcFloatingLastMatched = matched;

    const liveBtn = document.getElementById(PC_FLOAT_ID);
    if (!liveBtn) return;

    applyFloatingTriggerState(liveBtn, matched);
  } finally {
    __pcFloatingStateInFlight = false;
  }
}

async function sendRuntimeMessage(msg) {
  if (!hasLiveRuntime()) {
    return { ok: false, error: "extension_context_invalidated" };
  }

  try {
    return await chrome.runtime.sendMessage(msg);
  } catch (e) {
    const err = String(e || "");
    console.log("[pc:floating] sendMessage failed", err);

    if (/Extension context invalidated/i.test(err) || /Receiving end does not exist/i.test(err)) {
      return { ok: false, error: "extension_context_invalidated" };
    }

    return { ok: false, error: err };
  }
}

function shouldShowFloatingTrigger() {
  const site = siteOf();
  if (!["amazon", "target", "walmart", "bestbuy"].includes(site)) return false;

  const D = DRIVERS[site];
  if (!D) return false;

  const storeSku = D.getStoreSku ? D.getStoreSku() : null;
  return !!storeSku;
}

function removeFloatingTrigger() {
  document.getElementById(PC_FLOAT_ID)?.remove();
}

function mountFloatingTrigger() {
  if (!shouldShowFloatingTrigger()) {
    removeFloatingTrigger();
    return;
  }

  const existing = document.getElementById(PC_FLOAT_ID);
  if (existing) return;

  const btn = document.createElement("button");
  btn.id = PC_FLOAT_ID;
  btn.type = "button";
  btn.setAttribute("aria-label", "Open PriceCheck");
  btn.title = "Open PriceCheck";

  const floatingBottom = siteOf() === "bestbuy" ? 140 : 30;

  btn.style.cssText = [
    "position:fixed",
    "right:30px",
    `bottom:${floatingBottom}px`,
    "width:34px",
    "height:34px",
    "padding:0",
    "border:none",
    "border-radius:10px",
    "background:transparent",
    "overflow:visible",
    "box-shadow:none",
    "display:flex",
    "align-items:center",
    "justify-content:center",
    "cursor:pointer",
    "z-index:2147483647",
    "line-height:1",
    "transition:transform 120ms ease, opacity 120ms ease, box-shadow 120ms ease"
  ].join(";");

    const iconWrap = document.createElement("span");
  iconWrap.setAttribute("aria-hidden", "true");
  iconWrap.style.cssText = [
    "display:flex",
    "align-items:center",
    "justify-content:center",
    "width:34px",
    "height:34px",
    "border-radius:10px",
    "overflow:hidden",
    "pointer-events:none"
  ].join(";");

  const icon = document.createElement("img");
  icon.setAttribute("aria-hidden", "true");
  icon.alt = "";
  icon.src = PC_LOGO_URL;
  icon.style.cssText = [
    "display:block",
    "width:34px",
    "height:34px",
    "object-fit:contain",
    "pointer-events:none",
    "transition:opacity 120ms ease"
  ].join(";");

  iconWrap.appendChild(icon);
  btn.appendChild(iconWrap);

    btn.addEventListener("mouseenter", () => {
    btn.style.transform = "scale(1.06)";
  });

  btn.addEventListener("mouseleave", () => {
    btn.style.transform = "scale(1)";
    applyFloatingTriggerState(btn, __pcFloatingLastMatched === true);
  });

  btn.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();

    btn.style.opacity = "0.7";

    const resp = await sendRuntimeMessage({ type: "PC_OPEN_SIDEPANEL_FOR_TAB" });

    if (resp?.ok) {
      setTimeout(() => {
        btn.style.opacity = "1";
      }, 120);
      return;
    }

    console.log("[pc:floating] open sidepanel failed", resp);

    if (resp?.error === "extension_context_invalidated") {
      try {
        sessionStorage.setItem(PC_OPEN_AFTER_RELOAD_KEY, "1");
      } catch {}
      location.reload();
      return;
    }

    setTimeout(() => {
      btn.style.opacity = "1";
    }, 120);
  });

   (document.body || document.documentElement).appendChild(btn);

  const key = getFloatingTriggerKey();
  if (key && key === __pcFloatingLastCheckedKey && __pcFloatingLastMatched != null) {
    applyFloatingTriggerState(btn, __pcFloatingLastMatched);
  } else {
    applyFloatingTriggerState(btn, false);
    updateFloatingTriggerState().catch(() => {});
  }
}

let __pcFloatingMountTimer = null;

function scheduleFloatingTriggerMount() {
  if (__pcFloatingMountTimer) clearTimeout(__pcFloatingMountTimer);

  __pcFloatingMountTimer = setTimeout(() => {
    __pcFloatingMountTimer = null;
    mountFloatingTrigger();
  }, 120);
}

function bootFloatingTrigger() {
  if (!["amazon", "target", "walmart", "bestbuy"].includes(siteOf())) return;

  scheduleFloatingTriggerMount();

setTimeout(() => {
updateFloatingTriggerState().catch(() => {});
}, 900);

  try {
    if (sessionStorage.getItem(PC_OPEN_AFTER_RELOAD_KEY) === "1") {
      sessionStorage.removeItem(PC_OPEN_AFTER_RELOAD_KEY);
      setTimeout(() => {
        sendRuntimeMessage({ type: "PC_OPEN_SIDEPANEL_FOR_TAB" }).catch(() => {});
      }, 400);
    }
  } catch {}

  const root = document.documentElement || document.body;
  if (!root) return;

  const observer = new MutationObserver(() => {
    scheduleFloatingTriggerMount();
  });

  observer.observe(root, {
    childList: true,
    subtree: true
  });
}

bootFloatingTrigger();

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "PC_SCRAPE_OBSERVE") return;

    try {
      const site = siteOf();
      const D = DRIVERS[site];
      if (!D) {
        sendResponse({ ok: false, error: "unsupported_site" });
        return;
      }

      const store_sku = D.getStoreSku ? D.getStoreSku() : null;
      const price_cents = D.getPriceCents ? D.getPriceCents() : null;
      const title = D.getTitle ? D.getTitle() : "";

      if (!store_sku) {
        sendResponse({
          ok: false,
          error: "missing_store_sku",
          site,
          store_sku: null,
          price_cents: Number.isFinite(price_cents) ? price_cents : null
        });
        return;
      }

      const payload = {
        store: D.store,
        store_sku,
        price_cents: Number.isFinite(price_cents) ? price_cents : null,
        title,
        url: location.href,
        observed_at: new Date().toISOString()
      };

      const coupon = D.getCoupon ? D.getCoupon() : null;
        if (Number.isFinite(price_cents) && coupon) {
        Object.assign(payload, coupon);
        }

      sendResponse({
        ok: true,
        payload,
        can_observe_price: Number.isFinite(price_cents)
      });
    } catch (e) {
      sendResponse({
        ok: false,
        error: String(e?.message || e || "scrape_failed")
      });
    }

    return true;
  });
})();