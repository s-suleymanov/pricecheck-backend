// server.js — fixed join logic (UPC OR pci) + normalized compare_by_store_sku output
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
  if (k.length === 14 && k.startsWith("0")) k = k.slice(1);
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
function normPcCode(v) {
  const t = String(v || "").trim();
  return t ? t : "";
}

// ---------- Health ----------
app.get("/health", (_req, res) =>
  res.json({ ok: true, version: "unified-asins-0.92" })
);

// ---------- UPC → ASIN ----------
app.get("/v1/resolve", async (req, res) => {
  const upcNorm = normUPC(req.query.upc);
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

// ---------- Compare by ASIN or UPC ----------
app.get("/v1/compare", async (req, res) => {
  const asin = toASIN(req.query.asin);
  const upcNorm = normUPC(req.query.upc);
  if (!asin && !upcNorm)
    return res.status(400).json({ results: [], error: "need asin or upc" });

  try {
    const sql = `
      WITH base AS (
        SELECT asin, upc, pci, brand, category, model_name, model_number,
               variant_label, current_price_cents, current_price_observed_at
        FROM public.asins
        WHERE (($1)::text IS NOT NULL AND upper(btrim(asin)) = upper(btrim(($1)::text)))
           OR (($2)::text IS NOT NULL AND public.norm_upc(upc) = public.norm_upc(($2)::text))
        ORDER BY current_price_observed_at DESC NULLS LAST, id DESC
        LIMIT 1
      ),
      listings_match AS (
        SELECT
          l.store,
          NULL::text AS asin,
          l.upc,
          l.current_price_cents AS price_cents,
          l.current_price_observed_at AS observed_at,
          l.url,
          NULL::text AS brand,
          NULL::text AS category,
          NULL::text AS model_name,
          NULL::text AS model_number,
          l.variant_label,
          l.pci,
          CASE
            WHEN b.upc IS NOT NULL AND btrim(b.upc) <> ''
             AND l.upc IS NOT NULL AND btrim(l.upc) <> ''
             AND public.norm_upc(l.upc) = public.norm_upc(b.upc) THEN 2
            WHEN b.pci IS NOT NULL AND btrim(b.pci) <> ''
             AND l.pci IS NOT NULL AND btrim(l.pci) <> ''
             AND btrim(l.pci) = btrim(b.pci) THEN 1
            ELSE 0
          END AS match_strength
        FROM public.listings l
        JOIN base b ON (
          (
            b.upc IS NOT NULL AND btrim(b.upc) <> ''
            AND l.upc IS NOT NULL AND btrim(l.upc) <> ''
            AND public.norm_upc(l.upc) = public.norm_upc(b.upc)
          )
          OR
          (
            b.pci IS NOT NULL AND btrim(b.pci) <> ''
            AND l.pci IS NOT NULL AND btrim(l.pci) <> ''
            AND btrim(l.pci) = btrim(b.pci)
          )
        )
      )
      SELECT
        'Amazon'::text AS store,
        b.asin,
        b.upc,
        b.current_price_cents AS price_cents,
        b.current_price_observed_at AS observed_at,
        ('https://www.amazon.com/dp/' || b.asin) AS url,
        b.brand,
        b.category,
        b.model_name,
        b.model_number,
        b.variant_label,
        b.pci,
        3 AS match_strength
      FROM base b
      WHERE b.current_price_cents IS NOT NULL

      UNION ALL

      SELECT
        store,
        asin,
        upc,
        price_cents,
        observed_at,
        url,
        brand,
        category,
        model_name,
        model_number,
        variant_label,
        pci,
        match_strength
      FROM listings_match

      ORDER BY match_strength DESC, price_cents ASC NULLS LAST, store ASC;
    `;

    let { rows } = await pool.query(sql, [asin || null, upcNorm || null]);

    if ((!rows || rows.length === 0) && upcNorm) {
      const fb = await pool.query(`
        SELECT
          l.store,
          NULL::text AS asin,
          l.upc,
          l.current_price_cents AS price_cents,
          l.current_price_observed_at AS observed_at,
          l.url,
          NULL::text AS brand,
          NULL::text AS category,
          NULL::text AS model_name,
          NULL::text AS model_number,
          l.variant_label,
          l.pci,
          2 AS match_strength
        FROM public.listings l
        WHERE l.upc IS NOT NULL AND btrim(l.upc) <> ''
          AND public.norm_upc(l.upc) = public.norm_upc($1::text)
        ORDER BY price_cents ASC NULLS LAST, store ASC
      `, [upcNorm]);

      rows = fb.rows;
    }

    const out = rows.map((r) => ({
      store: r.store,
      asin: r.asin || asin || null,
      upc: r.upc,
      pci: r.pci || null,
      price_cents: Number.isFinite(r.price_cents) ? r.price_cents : null,
      seen_at: r.observed_at || null,
      url: r.url || (r.asin ? `https://www.amazon.com/dp/${r.asin}` : null),
      brand: r.brand || null,
      category: r.category || null,
      variant_label: r.variant_label || null,
      currency: "USD",
      match_strength: r.match_strength ?? null,
    }));

    res.json({ results: out });
  } catch (e) {
    console.error("compare error:", e);
    res.status(500).json({ results: [] });
  }
});

// ---------- Compare by store + store_sku ----------
app.get("/v1/compare_by_store_sku", async (req, res) => {
  const store = normStore(req.query.store);
  const storeSku = String(req.query.store_sku || "").trim();

  if (!store || !storeSku) {
    return res
      .status(400)
      .json({ asin: null, results: [], error: "store and store_sku required" });
  }

  try {
    // Step 1: find UPC and pci from listings by store + store_sku
    const r1 = await pool.query(
      `SELECT upc, pci
         FROM public.listings
        WHERE lower(btrim(store)) = lower(btrim($1))
          AND public.norm_sku(store_sku) = public.norm_sku($2)
        ORDER BY current_price_observed_at DESC NULLS LAST, id DESC
        LIMIT 1`,
      [store, storeSku]
    );

    const upc = r1.rows[0]?.upc ? normUPC(r1.rows[0].upc) : null;
    const pci = r1.rows[0]?.pci ? normPcCode(r1.rows[0].pci) : null;

    if (!upc && !pci) return res.json({ asin: null, results: [] });

    // Step 2: Find Amazon ASIN (optional, for convenience)
    // Prefer UPC lookup when present; else use pci
    const r2 = await pool.query(
      upc
        ? `SELECT asin FROM public.asins WHERE public.norm_upc(upc) = public.norm_upc($1) LIMIT 1`
        : `SELECT asin FROM public.asins WHERE btrim(pci) = btrim($1) LIMIT 1`,
      [upc || pci]
    );
    const asin = r2.rows[0]?.asin || null;

    // Step 3: Compare using both keys (UPC OR pci)
    const sql = `
      WITH base AS (
        SELECT asin, upc, pci, brand, category, model_name, model_number,
               variant_label, current_price_cents, current_price_observed_at
        FROM public.asins
        WHERE (
          ($1::text IS NOT NULL AND public.norm_upc(upc) = public.norm_upc($1::text))
          OR
          ($2::text IS NOT NULL AND btrim(pci) = btrim($2::text))
        )
        ORDER BY current_price_observed_at DESC NULLS LAST, id DESC
        LIMIT 1
      ),
      listings_match AS (
        SELECT
          l.store,
          NULL::text AS asin,
          l.upc,
          l.current_price_cents AS price_cents,
          l.current_price_observed_at AS observed_at,
          l.url,
          NULL::text AS brand,
          NULL::text AS category,
          NULL::text AS model_name,
          NULL::text AS model_number,
          l.variant_label,
          l.pci,
          CASE
            WHEN b.upc IS NOT NULL AND btrim(b.upc) <> ''
             AND l.upc IS NOT NULL AND btrim(l.upc) <> ''
             AND public.norm_upc(l.upc) = public.norm_upc(b.upc) THEN 2
            WHEN b.pci IS NOT NULL AND btrim(b.pci) <> ''
             AND l.pci IS NOT NULL AND btrim(l.pci) <> ''
             AND btrim(l.pci) = btrim(b.pci) THEN 1
            ELSE 0
          END AS match_strength
        FROM public.listings l
        JOIN base b ON (
          (
            b.upc IS NOT NULL AND btrim(b.upc) <> ''
            AND l.upc IS NOT NULL AND btrim(l.upc) <> ''
            AND public.norm_upc(l.upc) = public.norm_upc(b.upc)
          )
          OR
          (
            b.pci IS NOT NULL AND btrim(b.pci) <> ''
            AND l.pci IS NOT NULL AND btrim(l.pci) <> ''
            AND btrim(l.pci) = btrim(b.pci)
          )
        )
      )
      SELECT
        'Amazon'::text AS store,
        b.asin,
        b.upc,
        b.current_price_cents AS price_cents,
        b.current_price_observed_at AS observed_at,
        ('https://www.amazon.com/dp/' || b.asin) AS url,
        b.brand,
        b.category,
        b.model_name,
        b.model_number,
        b.variant_label,
        b.pci,
        3 AS match_strength
      FROM base b
      WHERE b.current_price_cents IS NOT NULL

      UNION ALL

      SELECT
        store,
        asin,
        upc,
        price_cents,
        observed_at,
        url,
        brand,
        category,
        model_name,
        model_number,
        variant_label,
        pci,
        match_strength
      FROM listings_match

      ORDER BY match_strength DESC, price_cents ASC NULLS LAST, store ASC;
    `;

    let { rows } = await pool.query(sql, [upc || null, pci || null]);

    // Fallback: if base (asins) is missing, match listings directly by UPC/PCI
    if (!rows || rows.length === 0) {
      const sqlListingsOnly = `
        SELECT
          l.store,
          NULL::text AS asin,
          l.upc,
          l.current_price_cents AS price_cents,
          l.current_price_observed_at AS observed_at,
          l.url,
          NULL::text AS brand,
          NULL::text AS category,
          NULL::text AS model_name,
          NULL::text AS model_number,
          l.variant_label,
          l.pci,
          CASE
            WHEN $1::text IS NOT NULL AND l.upc IS NOT NULL AND btrim(l.upc) <> ''
            AND public.norm_upc(l.upc) = public.norm_upc($1::text) THEN 2
            WHEN $2::text IS NOT NULL AND l.pci IS NOT NULL AND btrim(l.pci) <> ''
            AND btrim(l.pci) = btrim($2::text) THEN 1
            ELSE 0
          END AS match_strength
        FROM public.listings l
        WHERE
          (
            $1::text IS NOT NULL AND l.upc IS NOT NULL AND btrim(l.upc) <> ''
            AND public.norm_upc(l.upc) = public.norm_upc($1::text)
          )
          OR
          (
            $2::text IS NOT NULL AND l.pci IS NOT NULL AND btrim(l.pci) <> ''
            AND btrim(l.pci) = btrim($2::text)
          )
        ORDER BY match_strength DESC, price_cents ASC NULLS LAST, store ASC;
      `;

      const fb = await pool.query(sqlListingsOnly, [upc || null, pci || null]);
      rows = fb.rows;
    }


    const out = rows.map((r) => ({
      store: r.store,
      asin: r.asin || asin || null,
      upc: r.upc,
      pci: r.pci || null,
      price_cents: Number.isFinite(r.price_cents) ? r.price_cents : null,
      seen_at: r.observed_at || null,
      url: r.url || (r.asin ? `https://www.amazon.com/dp/${r.asin}` : null),
      brand: r.brand || null,
      category: r.category || null,
      variant_label: r.variant_label || null,
      currency: "USD",
      match_strength: r.match_strength ?? null,
    }));

    res.json({ asin, results: out });
  } catch (e) {
    console.error("compare_by_store_sku error:", e);
    res.status(500).json({ asin: null, results: [] });
  }
});

// ---------- Observe ----------
app.post("/v1/observe", async (req, res) => {
  const {
    pci,
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
  const pc = pci ? normPcCode(pci) : null;
  const asinUp = asin ? toASIN(asin) : null;
  const upcNorm = normUPC(upc);
  const cents = Number.isFinite(price_cents) ? price_cents : null;

  if (!storeNorm || !cents) {
    return res.status(400).json({ ok: false, error: "store and price required" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (storeNorm === "amazon") {
      await client.query(
        `
        INSERT INTO public.asins (
          asin, upc, pci, current_price_cents, current_price_observed_at,
          brand, category, variant_label, model_name, model_number, created_at
        )
        VALUES (
          $1, $2, $3, $4, COALESCE($5::timestamptz, now()),
          $6, $7, $8, $9, $10, now()
        )
        ON CONFLICT (asin)
        DO UPDATE SET
          pci = COALESCE(EXCLUDED.pci, asins.pci),
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
          pc || null,
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
        INSERT INTO public.listings (
          store, upc, pci, store_sku, url, status,
          current_price_cents, current_price_observed_at, variant_label
        )
        VALUES ($1, $2, $3, $4, $5, 'active', $6, COALESCE($7::timestamptz, now()), $8)
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
          pc || null,
          store_sku || null,
          url || null,
          cents,
          observed_at || null,
          variant_label || null,
        ]
      );
    }

  await client.query(
  `INSERT INTO public.price_history (store, asin, upc, store_sku, pci, price_cents, observed_at, url, title)
   VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, now()), $8, $9)`,
  [storeNorm, asinUp, upcNorm || null, store_sku || null, pc || null, cents, observed_at, url, title]
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
app.listen(PORT, "0.0.0.0", () => console.log(`API listening on ${PORT}`));

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