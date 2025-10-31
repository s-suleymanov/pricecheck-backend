// server.js — fixed to use listings for store data
const express = require("express");
const { Pool } = require("pg");

const app = express();

// ---------- Middleware ----------
app.use(express.json({ limit: "256kb" }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ---------- Database ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ---------- Normalizers ----------
function normUPC(val) {
  if (!val) return "";
  let k = String(val).replace(/[^0-9]/g, "");
  if (k.length === 13 && k.startsWith("0")) k = k.slice(1);
  return k;
}
function normStore(s) {
  return String(s || "").trim().toLowerCase();
}
function toASIN(s) {
  s = String(s || "").trim().toUpperCase();
  return /^[A-Z0-9]{10}$/.test(s) ? s : "";
}

// ---------- Health ----------
app.get("/health", (_req, res) =>
  res.json({ ok: true, version: "unified-asins-0.91" })
);

// ---------- UPC → ASIN ----------
app.get("/v1/resolve", async (req, res) => {
  const upcNorm = normUPC(req.query.store_key);
  if (!upcNorm) return res.json({ asin: null });
  try {
    const { rows } = await pool.query(
      `SELECT upper(btrim(asin)) AS asin
         FROM public.asins
        WHERE public.norm_upc(upc) = public.norm_upc($1)
        LIMIT 1`,
      [upcNorm]
    );
    res.json({ asin: rows[0]?.asin || null });
  } catch (e) {
    console.error("resolve error:", e);
    res.json({ asin: null });
  }
});

// ---------- Compare (Amazon + listings) ----------
app.get("/v1/compare", async (req, res) => {
  const asin = toASIN(req.query.asin);
  const upcNorm = normUPC(req.query.upc);
  if (!asin && !upcNorm)
    return res.status(400).json({ results: [], error: "need asin or upc" });

  try {
    const sql = `
      WITH base AS (
        SELECT asin, upc, brand, category, model_name, model_number,
               variant_label, current_price_cents, current_price_observed_at
        FROM public.asins
        WHERE (($1)::text IS NOT NULL AND upper(btrim(asin)) = upper(btrim(($1)::text)))
           OR (($2)::text IS NOT NULL AND public.norm_upc(upc) = public.norm_upc(($2)::text))
        LIMIT 1
      )
      SELECT
        'Amazon'::text AS store,
        b.asin, b.upc, b.current_price_cents AS price_cents,
        b.current_price_observed_at AS observed_at,
        NULL::text AS url,
        b.brand, b.category, b.model_name, b.model_number, b.variant_label
      FROM base b
      WHERE b.current_price_cents IS NOT NULL

      UNION ALL

      SELECT
        l.store, NULL::text AS asin, l.upc, l.current_price_cents, l.current_price_observed_at,
        l.url, NULL::text, NULL::text, NULL::text, NULL::text, l.variant_label
      FROM public.listings l
      JOIN base b ON public.norm_upc(l.upc) = public.norm_upc(b.upc)
      ORDER BY price_cents ASC NULLS LAST, store ASC;
    `;

    const { rows } = await pool.query(sql, [asin || null, upcNorm || null]);
    const out = rows.map((r) => ({
      store: r.store,
      asin: r.asin || asin || null,
      upc: r.upc,
      price_cents: r.price_cents,
      seen_at: r.observed_at,
      url: r.url || (r.asin ? `https://www.amazon.com/dp/${r.asin}` : null),
      brand: r.brand,
      category: r.category,
      variant_label: r.variant_label,
      currency: "USD",
    }));

    res.json({ results: out });
  } catch (e) {
    console.error("compare error:", e);
    res.status(500).json({ results: [] });
  }
});

// ---------- Compare by store_sku (Target/Walmart/BestBuy → Amazon) ----------
app.get("/v1/compare_by_store_sku", async (req, res) => {
  const store = normStore(req.query.store);
  const storeSku = String(req.query.store_sku || "").trim();

  if (!store || !storeSku)
    return res.status(400).json({ asin: null, results: [], error: "store and store_sku required" });

  try {
    // Step 1: find UPC from listings by store + store_sku
    const r1 = await pool.query(
      `SELECT upc
         FROM public.listings
        WHERE lower(btrim(store)) = lower(btrim($1))
          AND public.norm_sku(store_sku) = public.norm_sku($2)
        ORDER BY current_price_observed_at DESC NULLS LAST, id DESC
        LIMIT 1`,
      [store, storeSku]
    );

    const upc = r1.rows[0]?.upc ? normUPC(r1.rows[0].upc) : null;
    if (!upc) return res.json({ asin: null, results: [] });

    // Step 2: Find Amazon ASIN (if exists)
    const r2 = await pool.query(
      `SELECT asin
         FROM public.asins
        WHERE public.norm_upc(upc) = public.norm_upc($1)
        LIMIT 1`,
      [upc]
    );

    const asin = r2.rows[0]?.asin || null;

    // Step 3: Reuse main compare logic by UPC
    const sql = `
      WITH base AS (
        SELECT asin, upc, brand, category, model_name, model_number,
               variant_label, current_price_cents, current_price_observed_at
        FROM public.asins
        WHERE public.norm_upc(upc) = public.norm_upc(($1)::text)
        LIMIT 1
      )
      SELECT
      'Amazon'::text AS store,
      b.asin, b.upc, b.current_price_cents AS price_cents,
      b.current_price_observed_at AS observed_at,
      ('https://www.amazon.com/dp/' || b.asin) AS url,
        b.brand, b.category, b.model_name, b.model_number, b.variant_label
      FROM base b
      WHERE b.current_price_cents IS NOT NULL

      UNION ALL

      SELECT
        l.store, NULL::text AS asin, l.upc, l.current_price_cents, l.current_price_observed_at,
        l.url, NULL::text, NULL::text, NULL::text, NULL::text, l.variant_label
      FROM public.listings l
      JOIN base b ON public.norm_upc(l.upc) = public.norm_upc(b.upc)
      ORDER BY price_cents ASC NULLS LAST, store ASC;
    `;

    const { rows } = await pool.query(sql, [upc]);
    res.json({ asin, results: rows });
  } catch (e) {
    console.error("compare_by_store_sku error:", e);
    res.status(500).json({ asin: null, results: [] });
  }
});


// ---------- Observe ----------
app.post("/v1/observe", async (req, res) => {
  const {
    store,
    asin,
    upc,
    store_sku,
    price_cents,
    url,
    title,
    brand,
    category,
    variant_label,
    model_name,
    model_number,
    observed_at,
  } = req.body || {};

  const storeNorm = normStore(store);
  const asinUp = asin ? toASIN(asin) : null;
  const upcNorm = normUPC(upc);
  const cents = Number.isFinite(price_cents) ? price_cents : null;

  if (!storeNorm || !cents)
    return res.status(400).json({ ok: false, error: "store and price required" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (storeNorm === "amazon") {
      await client.query(
        `
        INSERT INTO public.asins (
          asin, upc, current_price_cents, current_price_observed_at,
          brand, category, variant_label, model_name, model_number, created_at
        )
        VALUES (
          $1, $2, $3, COALESCE($4::timestamptz, now()),
          $5, $6, $7, $8, $9, now()
        )
        ON CONFLICT (asin)
        DO UPDATE SET
          upc = COALESCE(EXCLUDED.upc, asins.upc),
          current_price_cents = EXCLUDED.current_price_cents,
          current_price_observed_at = EXCLUDED.current_price_observed_at,
          brand = COALESCE(EXCLUDED.brand, asins.brand),
          category = COALESCE(EXCLUDED.category, asins.category),
          variant_label = COALESCE(EXCLUDED.variant_label, asins.variant_label),
          model_name = COALESCE(EXCLUDED.model_name, asins.model_name),
          model_number = COALESCE(EXCLUDED.model_number, asins.model_number);
        `,
        [
          asinUp,
          upcNorm || null,
          cents,
          observed_at || null,
          brand || null,
          category || null,
          variant_label || null,
          model_name || null,
          model_number || null,
        ]
      );
    } else {
      await client.query(
        `
        INSERT INTO public.listings (store, upc, store_sku, url, status,
          current_price_cents, current_price_observed_at, variant_label)
        VALUES ($1, $2, $3, $4, 'active', $5, COALESCE($6::timestamptz, now()), $7)
        ON CONFLICT (store, upc)
        DO UPDATE SET
          store_sku = COALESCE(EXCLUDED.store_sku, listings.store_sku),
          url = COALESCE(EXCLUDED.url, listings.url),
          current_price_cents = EXCLUDED.current_price_cents,
          current_price_observed_at = EXCLUDED.current_price_observed_at,
          variant_label = COALESCE(EXCLUDED.variant_label, listings.variant_label),
          status = 'active';
        `,
        [
          storeNorm,
          upcNorm || null,
          store_sku || null,
          url || null,
          cents,
          observed_at || null,
          variant_label || null,
        ]
      );
    }

    await client.query(
      `INSERT INTO public.price_history (store, asin, upc, price_cents, observed_at, url, title)
       VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, now()), $6, $7)`,
      [storeNorm, asinUp, upcNorm, cents, observed_at, url, title]
    );

    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("observe error:", e);
    res.status(400).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
});

// ---------- Start ----------
const PORT = process.env.PORT || 4000;
app.listen(PORT, "0.0.0.0", () =>
  console.log(`API listening on ${PORT}`)
);

process.on("SIGINT", async () => {
  try {
    await pool.end();
  } finally {
    process.exit(0);
  }
});
process.on("SIGTERM", async () => {
  try {
    await pool.end();
  } finally {
    process.exit(0);
  }
});
