export const ROOT_ID = "pricecheck-sidebar-root";

export const hasChrome = () => typeof chrome !== "undefined" && chrome?.runtime?.id;

export const safeSend = (msg) =>
  new Promise((res) => {
    try { chrome.runtime.sendMessage(msg, (r) => res(r)); }
    catch { res(null); }
  });

export const safeSet = async (kv) => {
  try { if (hasChrome()) await chrome.storage.local.set(kv); }
  catch {}
};

export const clean = (s = "") =>
  String(s).replace(/[\u200E\u200F\u202A-\u202E]/g, "").replace(/\s+/g, " ").trim();

export const siteOf = (h = location.hostname) => {
  if (h.includes("amazon.")) return "amazon";
  if (h.includes("target.")) return "target";
  if (h.includes("walmart.")) return "walmart";
  if (h.includes("bestbuy.")) return "bestbuy";
  return "unknown";
};

export const toCents = (txt = "") => {
  const n = parseFloat(String(txt).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

export const storeKey = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

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
  gotrax: "GoTrax",
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

export const storeLabel = (s) => {
  const k = storeKey(s);
  if (k === "bestbuycom" || k === "bestbuyinc") return "Best Buy";
  if (STORE_LABELS[k]) return STORE_LABELS[k];
  const raw = String(s || "").trim();
  if (!raw) return "Unknown";
  return raw.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
};

export const escHtml = (s) =>
  String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

export const nonEmpty = (s) => !!String(s || "").trim();
