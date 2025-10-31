// server.js (Unified ASINS table)
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

// ---------- Health Check ----------
app.get("/health", (_req, res) =>
  res.json({ ok: true, version: "unified-asins" })
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

// ---------- Compare by UPC ----------
app.get("/v1/compare", async (req, res) => {
  const asin = toASIN(req.query.asin);
  const upcNorm = normUPC(req.query.upc);
  if (!asin && !upcNorm)
    return res.status(400).json({ results: [], error: "need asin or upc" });

  try {
    // Step 1: find by ASIN or UPC
    const q1 = await pool.query(
      `SELECT asin, store, upc, url, variant_label,
              current_price_cents AS price_cents,
              current_price_observed_at AS observed_at,
              brand, model_name, model_number, category
         FROM public.asins
        WHERE ($1 IS NOT NULL AND upper(btrim(asin)) = upper(btrim($1)))
           OR ($2 IS NOT NULL AND public.norm_upc(upc) = public.norm_upc($2))
        ORDER BY current_price_cents ASC NULLS LAST, store ASC`,
      [asin || null, upcNorm || null]
    );

    const out = q1.rows.map((r) => ({
      store: r.store || "Amazon",
      asin: r.asin || null,
      upc: r.upc || null,
      price_cents: r.price_cents,
      seen_at: r.observed_at,
      url: r.url || (r.asin ? `https://www.amazon.com/dp/${r.asin}` : null),
      brand: r.brand || null,
      model_name: r.model_name || null,
      model_number: r.model_number || null,
      category: r.category || null,
      variant_label: r.variant_label || null,
      currency: "USD",
    }));

    res.json({ results: out });
  } catch (e) {
    console.error("compare error:", e);
    res.status(500).json({ results: [] });
  }
});

// ---------- Observe ----------
app.post("/v1/observe", async (req, res) => {
  const {
    store,
    asin,
    upc,
    price_cents,
    url,
    title,
    variant_label,
    brand,
    category,
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

    // ---------- UPSERT INTO ASINS ----------
    await client.query(
      `
      INSERT INTO public.asins (
        store, asin, upc, url, variant_label,
        current_price_cents, current_price_observed_at,
        brand, category, model_name, model_number, created_at
      )
      VALUES (
        $1, $2, $3, $4, $5,
        $6, COALESCE($7::timestamptz, now()),
        $8, $9, $10, $11, now()
      )
      ON CONFLICT (asin)
      DO UPDATE SET
        upc = COALESCE(EXCLUDED.upc, public.asins.upc),
        url = COALESCE(EXCLUDED.url, public.asins.url),
        variant_label = COALESCE(EXCLUDED.variant_label, public.asins.variant_label),
        brand = COALESCE(EXCLUDED.brand, public.asins.brand),
        category = COALESCE(EXCLUDED.category, public.asins.category),
        model_name = COALESCE(EXCLUDED.model_name, public.asins.model_name),
        model_number = COALESCE(EXCLUDED.model_number, public.asins.model_number),
        current_price_cents = EXCLUDED.current_price_cents,
        current_price_observed_at = EXCLUDED.current_price_observed_at
    `,
      [
        storeNorm,
        asinUp,
        upcNorm || null,
        url || null,
        variant_label || null,
        cents,
        observed_at || null,
        brand || null,
        category || null,
        model_name || null,
        model_number || null,
      ]
    );

    // ---------- PRICE HISTORY ----------
    await client.query(
      `INSERT INTO public.price_history (store, asin, upc, price_cents, observed_at, url, title)
       VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, now()), $6, $7)`,
      [
        storeNorm,
        asinUp || null,
        upcNorm || null,
        cents,
        observed_at || null,
        url || null,
        title || null,
      ]
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

// ---------- Start Server ----------
const PORT = process.env.PORT || 4000;
app.listen(PORT, "0.0.0.0", () =>
  console.log(`PriceCheck unified API listening on ${PORT}`)
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
