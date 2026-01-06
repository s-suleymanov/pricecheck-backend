// server.js — listings-first API for the Chrome extension
const express = require("express");
const { Pool } = require("pg");

const app = express();

// ---------- Middleware ----------
app.use(express.json({ limit: "256kb" }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, X-PC-Client");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ---------- Database ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
});

const ALLOWED_STORES = new Set(["amazon", "target", "walmart", "bestbuy", "bestbuycom", "bestbuyinc"]);
function storeOk(s) {
  const k = normStore(s);
  if (k === "bestbuy") return true;
  if (k === "bestbuycom") return true;
  if (k === "bestbuyinc") return true;
  return ALLOWED_STORES.has(k);
}

// simple in-memory rate limiter per key
const RL = new Map(); // key -> { count, resetAt }
function rateLimitKey(req) {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
  const client = String(req.headers["x-pc-client"] || "").slice(0, 80);
  return client ? `c:${client}` : `ip:${ip}`;
}

function allowRate(req, limit = 120, windowMs = 10 * 60 * 1000) {
  const key = rateLimitKey(req);
  const now = Date.now();
  const cur = RL.get(key);

  if (!cur || now > cur.resetAt) {
    RL.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }

  cur.count += 1;
  RL.set(key, cur);
  return cur.count <= limit;
}

// ---------- Normalizers ----------
function normUPC(val) {
  if (!val) return "";
  let k = String(val).replace(/[^0-9]/g, "");
  if (k.length === 14 && k.startsWith("0")) k = k.slice(1);
  if (k.length === 13 && k.startsWith("0")) k = k.slice(1);
  return k;
}
function normStore(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}
function storeDisplay(s) {
  const k = normStore(s);
  if (k === "amazon") return "Amazon";
  if (k === "target") return "Target";
  if (k === "walmart") return "Walmart";
  if (k === "bestbuy" || k === "bestbuycom" || k === "bestbuyinc") return "Best Buy";
  return s ? String(s).trim() : "";
}
function normSku(s) {
  return String(s || "").trim();
}
function toASIN(s) {
  s = String(s || "").trim().toUpperCase();
  return /^[A-Z0-9]{10}$/.test(s) ? s : "";
}
function normPci(v) {
  const t = String(v || "").trim();
  return t ? t : "";
}

// ---------- Health ----------
app.get("/health", (_req, res) => res.json({ ok: true, version: "listings-only-1.0" }));

// ---------- Compare by ASIN / UPC / PCI (GET) ----------
// /v1/compare?asin=B0.... OR /v1/compare?upc=... OR /v1/compare?pci=...
// IMPORTANT: ASIN is input-only. We never match listings by ASIN except to resolve PCI/UPC.
// All cross-store matching is PCI/UPC only.
app.get("/v1/compare", async (req, res) => {
  const asin = toASIN(req.query.asin);
  const upcNorm = normUPC(req.query.upc);
  const pci = normPci(req.query.pci);

  let upcKey = upcNorm || "";
  let pciKey = pci || "";

  // If ASIN is provided, resolve PCI/UPC from the Amazon listing row
  if (asin && (!upcKey || !pciKey)) {
    const r = await pool.query(
      `
      select upc, pci
      from public.listings
      where lower(btrim(store)) = 'amazon'
        and public.norm_sku(store_sku) = public.norm_sku($1)
      order by current_price_observed_at desc nulls last, created_at desc
      limit 1
      `,
      [asin]
    );

    if (r.rowCount) {
      if (!upcKey) upcKey = normUPC(r.rows[0].upc);
      if (!pciKey) pciKey = normPci(r.rows[0].pci);
    }
  }

  // If user provided nothing, fail
  if (!asin && !upcNorm && !pci) {
    return res.status(400).json({ results: [], error: "need asin or upc or pci" });
  }

  // If ASIN was provided but we could not resolve PCI/UPC,
  // optionally return the Amazon listing row only (so Amazon pages still show something).
  // If you prefer to return empty instead, remove this block.
  if (asin && !upcKey && !pciKey) {
    try {
      const rOnly = await pool.query(
        `
        select
          store, store_sku, upc, pci, offer_tag,
          current_price_cents as price_cents,
          current_price_observed_at as observed_at,
          url, title
        from public.listings
        where lower(btrim(store)) = 'amazon'
          and public.norm_sku(store_sku) = public.norm_sku($1)
        order by current_price_observed_at desc nulls last, created_at desc
        limit 1
        `,
        [asin]
      );

      const outOnly = rOnly.rows.map((r) => ({
        store: storeDisplay(r.store),
        store_sku: r.store_sku || null,
        asin: r.store_sku ? toASIN(r.store_sku) : null,
        upc: r.upc || null,
        pci: r.pci || null,
        offer_tag: r.offer_tag || null,
        price_cents: Number.isFinite(r.price_cents) ? r.price_cents : null,
        seen_at: r.observed_at || null,
        url: r.url || (r.store_sku ? `https://www.amazon.com/dp/${toASIN(r.store_sku)}` : null),
        title: r.title || null,
        brand: null,
        category: null,
        currency: "USD",
        match_strength: 3,
      }));

      return res.json({ results: outOnly });
    } catch (e) {
      console.error("compare(asin-only) error:", e);
      return res.status(500).json({ results: [] });
    }
  }

  try {
    const sql = `
      WITH anchor AS (
        SELECT
          (case when $2::text <> '' then upper(btrim($2::text)) else null end) as pci_key,
          (case when $1::text <> '' then public.norm_upc($1::text) else null end) as upc_key
      ),
      meta AS (
        SELECT c.brand, c.category, COALESCE(c.dropship_warning, false) AS dropship_warning, c.recall_url AS recall_url
        FROM public.catalog c
        CROSS JOIN anchor a
        WHERE
          (
            a.pci_key IS NOT NULL
            AND c.pci IS NOT NULL AND btrim(c.pci) <> ''
            AND upper(btrim(c.pci)) = a.pci_key
          )
          OR
          (
            a.upc_key IS NOT NULL
            AND c.upc IS NOT NULL AND btrim(c.upc) <> ''
            AND public.norm_upc(c.upc) = a.upc_key
          )
        ORDER BY c.created_at DESC
        LIMIT 1
      ),
      matched AS (
        SELECT
          l.store,
          l.store_sku,
          l.upc,
          l.pci,
          l.offer_tag,
          l.current_price_cents AS price_cents,
          l.current_price_observed_at AS observed_at,
          l.url,
          l.title,
          m.brand,
          m.category,
          m.dropship_warning AS dropship_warning,
          m.recall_url AS recall_url,
          CASE
            WHEN a.pci_key IS NOT NULL
              AND l.pci IS NOT NULL AND btrim(l.pci) <> ''
              AND upper(btrim(l.pci)) = a.pci_key THEN 2
            WHEN a.upc_key IS NOT NULL
              AND l.upc IS NOT NULL AND btrim(l.upc) <> ''
              AND public.norm_upc(l.upc) = a.upc_key THEN 1
            ELSE 0
          END AS match_strength
        FROM public.listings l
        CROSS JOIN anchor a
        LEFT JOIN meta m ON true
        WHERE
          (
            a.pci_key IS NOT NULL
            AND l.pci IS NOT NULL AND btrim(l.pci) <> ''
            AND upper(btrim(l.pci)) = a.pci_key
          )
          OR
          (
            a.upc_key IS NOT NULL
            AND l.upc IS NOT NULL AND btrim(l.upc) <> ''
            AND public.norm_upc(l.upc) = a.upc_key
          )
      )
      SELECT *
      FROM matched
      ORDER BY
        match_strength DESC,
        price_cents ASC NULLS LAST,
        observed_at DESC NULLS LAST,
        store ASC;
    `;

    const { rows } = await pool.query(sql, [upcKey || "", pciKey || ""]);

    const out = rows.map((r) => ({
      store: storeDisplay(r.store),
      store_sku: r.store_sku || null,
      asin: normStore(r.store) === "amazon" ? (r.store_sku ? toASIN(r.store_sku) : null) : null,
      upc: r.upc || null,
      pci: r.pci || null,
      offer_tag: r.offer_tag || null,
      price_cents: Number.isFinite(r.price_cents) ? r.price_cents : null,
      seen_at: r.observed_at || null,
      url:
        r.url ||
        (normStore(r.store) === "amazon" && r.store_sku ? `https://www.amazon.com/dp/${toASIN(r.store_sku)}` : null),
      title: r.title || null,
      brand: r.brand || null,
      category: r.category || null,
      dropship_warning: !!r.dropship_warning,
      recall_url: r.recall_url || null,
      currency: "USD",
      match_strength: r.match_strength ?? null,
    }));

    res.json({ results: out });
  } catch (e) {
    console.error("compare error:", e);
    res.status(500).json({ results: [] });
  }
});

app.get("/v1/compare_by_store_sku", async (req, res) => {
  const store = normStore(req.query.store);
  const storeSku = normSku(req.query.store_sku);

  if (!store || !storeSku) {
    return res.status(400).json({ results: [], error: "store and store_sku required" });
  }

  try {
    const r1 = await pool.query(
      `
      SELECT store, store_sku, upc, pci
      FROM public.listings
      WHERE lower(regexp_replace(btrim(store), '[^a-z0-9]', '', 'g')) = $1
        AND public.norm_sku(store_sku) = public.norm_sku($2)
      ORDER BY current_price_observed_at DESC NULLS LAST, created_at DESC
      LIMIT 1
      `,
      [store, storeSku]
    );

    if (!r1.rowCount) return res.json({ results: [] });

    const upc = r1.rows[0]?.upc ? normUPC(r1.rows[0].upc) : "";
    const pci = r1.rows[0]?.pci ? normPci(r1.rows[0].pci) : "";

    const r2 = await pool.query(
      `
      WITH anchor AS (
        SELECT
          $3::text as anchor_store,              -- already normalized
          public.norm_sku($4::text) as anchor_sku,
          (case when $2::text <> '' then upper(btrim($2::text)) else null end) as pci_key,
          (case when $1::text <> '' then public.norm_upc($1::text) else null end) as upc_key
      ),
      meta AS (
        SELECT c.brand, c.category, COALESCE(c.dropship_warning, false) AS dropship_warning, c.recall_url AS recall_url
        FROM public.catalog c
        CROSS JOIN anchor a
        WHERE
          (a.pci_key IS NOT NULL AND c.pci IS NOT NULL AND btrim(c.pci) <> '' AND upper(btrim(c.pci)) = a.pci_key)
          OR
          (a.upc_key IS NOT NULL AND c.upc IS NOT NULL AND btrim(c.upc) <> '' AND public.norm_upc(c.upc) = a.upc_key)
        ORDER BY c.created_at DESC
        LIMIT 1
      )
      SELECT
        l.store,
        l.store_sku,
        l.upc,
        l.pci,
        l.offer_tag,
        l.current_price_cents AS price_cents,
        l.current_price_observed_at AS observed_at,
        l.url,
        l.title,
        m.brand,
        m.category,
        m.dropship_warning AS dropship_warning,
        m.recall_url AS recall_url,
        CASE
          WHEN lower(regexp_replace(btrim(l.store), '[^a-z0-9]', '', 'g')) = a.anchor_store
           AND public.norm_sku(l.store_sku) = a.anchor_sku THEN 3
          WHEN a.pci_key IS NOT NULL
           AND l.pci IS NOT NULL AND btrim(l.pci) <> ''
           AND upper(btrim(l.pci)) = a.pci_key THEN 2
          WHEN a.upc_key IS NOT NULL
           AND l.upc IS NOT NULL AND btrim(l.upc) <> ''
           AND public.norm_upc(l.upc) = a.upc_key THEN 1
          ELSE 0
        END AS match_strength
      FROM public.listings l
      CROSS JOIN anchor a
      LEFT JOIN meta m ON true
      WHERE
        (lower(regexp_replace(btrim(l.store), '[^a-z0-9]', '', 'g')) = a.anchor_store AND public.norm_sku(l.store_sku) = a.anchor_sku)
        OR
        (a.pci_key IS NOT NULL AND l.pci IS NOT NULL AND btrim(l.pci) <> '' AND upper(btrim(l.pci)) = a.pci_key)
        OR
        (a.upc_key IS NOT NULL AND l.upc IS NOT NULL AND btrim(l.upc) <> '' AND public.norm_upc(l.upc) = a.upc_key)
      ORDER BY
        match_strength DESC,
        price_cents ASC NULLS LAST,
        observed_at DESC NULLS LAST,
        l.store ASC;
      `,
      [upc || "", pci || "", store, storeSku]
    );

    const out = r2.rows.map((r) => ({
      store: storeDisplay(r.store),
      store_sku: r.store_sku || null,
      asin: normStore(r.store) === "amazon" ? (r.store_sku ? toASIN(r.store_sku) : null) : null,
      upc: r.upc || null,
      pci: r.pci || null,
      offer_tag: r.offer_tag || null,
      price_cents: Number.isFinite(r.price_cents) ? r.price_cents : null,
      seen_at: r.observed_at || null,
      url: r.url || (normStore(r.store) === "amazon" && r.store_sku ? `https://www.amazon.com/dp/${toASIN(r.store_sku)}` : null),
      title: r.title || null,
      brand: r.brand || null,
      category: r.category || null,
      dropship_warning: r.dropship_warning === true,
      recall_url: r.recall_url || null,
      currency: "USD",
      match_strength: r.match_strength ?? null,
    }));

    return res.json({
      results: out,
      anchor: { store: storeDisplay(store), store_sku: storeSku, upc: upc || null, pci: pci || null },
    });
  } catch (e) {
    console.error("compare_by_store_sku error:", e);
    return res.status(500).json({ results: [] });
  }
});

app.post("/v1/observe", async (req, res) => { 
  try {
    const p = req.body || {};
    const observedAt = p.observed_at ? new Date(p.observed_at) : new Date();
    const store = normStore(p.store);
    const storeSku = String(p.store_sku || "").trim();
    const priceCents = Number(p.price_cents);

    if (!store || !storeSku || !Number.isFinite(priceCents)) {
      return res.status(400).json({ ok: false, error: "missing store/store_sku/price_cents" });
    }

    // A) Insert history (dedupe allowed if you have a constraint)
    await pool.query(
      `
      INSERT INTO public.price_history (store, store_sku, price_cents, observed_at)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT DO NOTHING
      `,
      [store, storeSku, priceCents, observedAt]
    );

    // B) Update listings current price (only the 2 fields)
    const up = await pool.query(
      `
      UPDATE public.listings
         SET current_price_cents = $1,
             current_price_observed_at = $2
       WHERE lower(btrim(store)) = lower(btrim($3))
         AND norm_sku(store_sku) = norm_sku($4)
         AND (current_price_observed_at IS NULL OR $2 >= current_price_observed_at)
      `,
      [priceCents, observedAt, store, storeSku]
    );

    return res.json({ ok: true, listingUpdated: up.rowCount > 0 });
  } catch (e) {
    console.error("observe error:", e);
    return res.status(500).json({ ok: false });
  }
});

// ---------- Start ----------
const PORT = process.env.PORT || 4000;
app.listen(PORT, "0.0.0.0", () => console.log(`API listening on ${PORT}`));

process.on("SIGINT", async () => {
  try { await pool.end(); } finally { process.exit(0); }
});
process.on("SIGTERM", async () => {
  try { await pool.end(); } finally { process.exit(0); }
});