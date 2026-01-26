// server.js — listings-first API for the Chrome extension
const express = require("express");
const { Pool } = require("pg");

const app = express();
console.log("SERVER.JS LOADED: UPSERT_BUILD_2026_01_15");


app.use((req, _res, next) => {
  console.log("REQ", req.method, req.path, "q=", req.url?.split("?")[1] || "");
  next();
});

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
  if (k === "bestbuy" || k === "bestbuycom" || k === "bestbuyinc") return "bestbuy";
  if (k === "amazon") return "amazon";
  if (k === "target") return "target";
  if (k === "walmart") return "walmart";
  return k || "";
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

app.get("/v1/compare", async (req, res) => {
  if (!allowRate(req, 240, 10 * 60 * 1000)) {
    return res.status(429).json({ results: [], error: "rate_limited" });
  }
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
          url, title,
          coupon_text,
          coupon_type,
          coupon_value_cents,
          coupon_value_pct,
          coupon_requires_clip,
          coupon_code,
          coupon_expires_at,
          effective_price_cents,
          coupon_observed_at
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
        coupon_text: r.coupon_text || null,
        coupon_type: r.coupon_type || null,
        coupon_value_cents: Number.isFinite(r.coupon_value_cents) ? r.coupon_value_cents : null,
        coupon_value_pct: (r.coupon_value_pct == null ? null : Number(r.coupon_value_pct)),
        coupon_requires_clip: r.coupon_requires_clip === true,
        coupon_code: r.coupon_code || null,
        coupon_expires_at: r.coupon_expires_at || null,
        effective_price_cents: Number.isFinite(r.effective_price_cents) ? r.effective_price_cents : null,
        coupon_observed_at: r.coupon_observed_at || null,
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
        SELECT 
          c.brand,
          c.category, 
          COALESCE(c.dropship_warning, false) AS dropship_warning, 
          COALESCE(c.coverage_warning, false) AS coverage_warning,
          c.recall_url AS recall_url
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
          l.current_price_cents::int AS price_cents,
          l.current_price_observed_at AS observed_at,
          l.url,
          l.title,
          l.coupon_text,
          l.coupon_type,
          l.coupon_value_cents::int AS coupon_value_cents,
          l.coupon_value_pct::float8 AS coupon_value_pct,
          l.coupon_requires_clip,
          l.coupon_code,
          l.coupon_expires_at,
          l.effective_price_cents::int AS effective_price_cents,
          l.coupon_observed_at,
          m.brand,
          m.category,
          m.dropship_warning AS dropship_warning,
          m.coverage_warning AS coverage_warning,
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
      coupon_text: r.coupon_text || null,
      coupon_type: r.coupon_type || null,
      coupon_value_cents: Number.isFinite(r.coupon_value_cents) ? r.coupon_value_cents : null,
      coupon_value_pct: (r.coupon_value_pct == null ? null : Number(r.coupon_value_pct)),
      coupon_requires_clip: r.coupon_requires_clip === true,
      coupon_code: r.coupon_code || null,
      coupon_expires_at: r.coupon_expires_at || null,
      effective_price_cents: Number.isFinite(r.effective_price_cents) ? r.effective_price_cents : null,
      coupon_observed_at: r.coupon_observed_at || null,
      brand: r.brand || null,
      category: r.category || null,
      dropship_warning: !!r.dropship_warning,
      recall_url: r.recall_url || null,
      coverage_warning: !!r.coverage_warning,
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
  if (!allowRate(req, 240, 10 * 60 * 1000)) {
    return res.status(429).json({ results: [], error: "rate_limited" });
  }
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
        SELECT 
        c.brand, 
        c.category, 
        COALESCE(c.dropship_warning, false) AS dropship_warning,
        COALESCE(c.coverage_warning, false) AS coverage_warning, 
        c.recall_url AS recall_url
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
        l.current_price_cents::int AS price_cents,
        l.current_price_observed_at AS observed_at,
        l.url,
        l.title,
        l.coupon_text,
        l.coupon_type,
        l.coupon_value_cents::int AS coupon_value_cents,
        l.coupon_value_pct::float8 AS coupon_value_pct,
        l.coupon_requires_clip,
        l.coupon_code,
        l.coupon_expires_at,
        l.effective_price_cents::int AS effective_price_cents,
        l.coupon_observed_at,
        m.brand,
        m.category,
        m.dropship_warning AS dropship_warning,
        m.coverage_warning AS coverage_warning,
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
      coupon_text: r.coupon_text || null,
      coupon_type: r.coupon_type || null,
      coupon_value_cents: Number.isFinite(r.coupon_value_cents) ? r.coupon_value_cents : null,
      coupon_value_pct: (r.coupon_value_pct == null ? null : Number(r.coupon_value_pct)),
      coupon_requires_clip: r.coupon_requires_clip === true,
      coupon_code: r.coupon_code || null,
      coupon_expires_at: r.coupon_expires_at || null,
      effective_price_cents: Number.isFinite(r.effective_price_cents) ? r.effective_price_cents : null,
      coupon_observed_at: r.coupon_observed_at || null,
      brand: r.brand || null,
      category: r.category || null,
      dropship_warning: r.dropship_warning === true,
      recall_url: r.recall_url || null,
      coverage_warning: r.coverage_warning === true,
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
    if (!allowRate(req, 600, 10 * 60 * 1000)) {
      return res.status(429).json({ ok: false, error: "rate_limited" });
    }
    const p = req.body || {};
    const observedAt = p.observed_at ? new Date(p.observed_at) : new Date();
    const store = normStore(p.store);
    const storeSku = String(p.store_sku || "").trim();
    const priceCents = Number(p.price_cents);

    if (!store || !storeSku || !Number.isFinite(priceCents)) {
      return res.status(400).json({ ok: false, error: "missing store/store_sku/price_cents" });
    }

    // Coupon fields (optional)
    const coupon_text = typeof p.coupon_text === "string" ? p.coupon_text.trim() : null;
    const coupon_type = typeof p.coupon_type === "string" ? p.coupon_type.trim() : null;
    const coupon_value_cents =
      p.coupon_value_cents == null ? null : Number(p.coupon_value_cents);
    const coupon_value_pct =
      p.coupon_value_pct == null ? null : Number(p.coupon_value_pct);
    const coupon_requires_clip = p.coupon_requires_clip === true;
    const coupon_code = typeof p.coupon_code === "string" ? p.coupon_code.trim() : null;
    const coupon_expires_at = p.coupon_expires_at ? new Date(p.coupon_expires_at) : null;
    const effective_price_cents =
      p.effective_price_cents == null ? null : Number(p.effective_price_cents);
    const hasEffectiveCoupon = Number.isFinite(effective_price_cents);
    const coupon_observed_at = p.coupon_observed_at ? new Date(p.coupon_observed_at) : null;

    
    // A) Insert history row (now with coupon columns)
    await pool.query(
      `
      INSERT INTO public.price_history (
        store, store_sku, price_cents, observed_at,
        url, title, upc, pci,
        coupon_text, coupon_value_cents, coupon_value_pct, effective_price_cents
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      `,
      [
        store,
        storeSku,
        priceCents,
        observedAt,
        p.url ? String(p.url) : null,
        p.title ? String(p.title) : null,
        p.upc ? String(p.upc) : null,
        p.pci ? String(p.pci) : null,

        hasEffectiveCoupon ? coupon_text : null,
        hasEffectiveCoupon && Number.isFinite(coupon_value_cents) ? coupon_value_cents : null,
        hasEffectiveCoupon && Number.isFinite(coupon_value_pct) ? coupon_value_pct : null,
        hasEffectiveCoupon ? effective_price_cents : null,
      ]
    );

        // B) Upsert listing row (create if missing, update if newer)
    const upListing = await pool.query(
      `
      INSERT INTO public.listings (
        store,
        store_sku,
        current_price_cents,
        current_price_observed_at,
        url,
        title,
        upc,
        pci,
        status
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active')
      ON CONFLICT (lower(btrim(store)), norm_sku(store_sku))
      WHERE (store_sku IS NOT NULL AND btrim(store_sku) <> '')
      DO UPDATE SET
        current_price_cents = CASE
          WHEN public.listings.current_price_observed_at IS NULL
            OR EXCLUDED.current_price_observed_at >= public.listings.current_price_observed_at
          THEN EXCLUDED.current_price_cents
          ELSE public.listings.current_price_cents
        END,
        current_price_observed_at = CASE
          WHEN public.listings.current_price_observed_at IS NULL
            OR EXCLUDED.current_price_observed_at >= public.listings.current_price_observed_at
          THEN EXCLUDED.current_price_observed_at
          ELSE public.listings.current_price_observed_at
        END,
        url = COALESCE(NULLIF(EXCLUDED.url, ''), public.listings.url),
        title = COALESCE(NULLIF(EXCLUDED.title, ''), public.listings.title),
        upc = COALESCE(NULLIF(EXCLUDED.upc, ''), public.listings.upc),
        pci = COALESCE(NULLIF(EXCLUDED.pci, ''), public.listings.pci),
        status = COALESCE(NULLIF(EXCLUDED.status, ''), public.listings.status)
        RETURNING id, store, store_sku, current_price_cents, current_price_observed_at, (xmax = 0) as inserted
      `,
      [
        store,
        storeSku,
        priceCents,
        observedAt,
        p.url ? String(p.url) : null,
        p.title ? String(p.title) : null,
        p.upc ? String(p.upc) : null,
        p.pci ? String(p.pci) : null,
      ]
    );

    // C) Update coupon fields in listings when we have any coupon signal
    // Rule: only overwrite when coupon_observed_at is newer, otherwise keep existing.
    const hasAnyCouponSignal = Number.isFinite(effective_price_cents);

    let upCoupon = { rowCount: 0 };

    if (hasAnyCouponSignal) {
      const couponAt = coupon_observed_at || observedAt;

      upCoupon = await pool.query(
        `
        UPDATE public.listings
           SET coupon_text = $1,
               coupon_type = $2,
               coupon_value_cents = $3,
               coupon_value_pct = $4,
               coupon_requires_clip = $5,
               coupon_code = $6,
               coupon_expires_at = $7,
               effective_price_cents = $8,
               coupon_observed_at = $9
         WHERE lower(btrim(store)) = lower(btrim($10))
           AND norm_sku(store_sku) = norm_sku($11)
           AND (coupon_observed_at IS NULL OR $9 >= coupon_observed_at)
        `,
        [
          coupon_text,
          coupon_type,
          Number.isFinite(coupon_value_cents) ? coupon_value_cents : null,
          Number.isFinite(coupon_value_pct) ? coupon_value_pct : null,
          coupon_requires_clip,
          coupon_code,
          coupon_expires_at,
          Number.isFinite(effective_price_cents) ? effective_price_cents : null,
          couponAt,
          store,
          storeSku,
        ]
      );
    }

   return res.json({
    ok: true,
    listingRowCount: upListing?.rowCount ?? 0,
    listingRow: upListing?.rows?.[0] ?? null,
    couponRowCount: upCoupon?.rowCount ?? 0,
  });
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