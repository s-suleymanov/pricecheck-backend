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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ---------- Database ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
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
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
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
app.get("/v1/compare", async (req, res) => {
  const asin = toASIN(req.query.asin);
  const upcNorm = normUPC(req.query.upc);
  const pci = normPci(req.query.pci);

  let upcKey = upcNorm || "";
  let pciKey = pci || "";

  if (asin && (!upcKey || !pciKey)) {
    // Pull keys from the Amazon listing row if we can
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

  if (!asin && !upcNorm && !pci) {
    return res.status(400).json({ results: [], error: "need asin or upc or pci" });
  }

  try {
    
    const sql = `
        WITH anchor AS (
          SELECT
            (case when $3::text <> '' then upper(btrim($3::text)) else null end) as pci_key,
            (case when $2::text <> '' then public.norm_upc($2::text) else null end) as upc_key,
            (case when $1::text <> '' then upper(btrim($1::text)) else null end) as asin_key
        ),
              meta AS (
        SELECT c.brand, c.category
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
          OR
          (
            a.asin_key IS NOT NULL
            AND c.asin IS NOT NULL AND btrim(c.asin) <> ''
            AND upper(btrim(c.asin)) = a.asin_key
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
            CASE
              WHEN a.pci_key IS NOT NULL
              AND l.pci IS NOT NULL AND btrim(l.pci) <> ''
              AND upper(btrim(l.pci)) = a.pci_key THEN 3
              WHEN a.upc_key IS NOT NULL
              AND l.upc IS NOT NULL AND btrim(l.upc) <> ''
              AND public.norm_upc(l.upc) = a.upc_key THEN 2
              WHEN a.asin_key IS NOT NULL
              AND lower(btrim(l.store)) = 'amazon'
              AND public.norm_sku(l.store_sku) = public.norm_sku(a.asin_key) THEN 1
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
            OR
            (
              a.asin_key IS NOT NULL
              AND lower(btrim(l.store)) = 'amazon'
              AND public.norm_sku(l.store_sku) = public.norm_sku(a.asin_key)
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

    const { rows } = await pool.query(sql, [asin || "", upcKey || "", pciKey || ""]);

    const out = rows.map((r) => ({
      store: r.store,
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
      currency: "USD",
      match_strength: r.match_strength ?? null,
    }));

    res.json({ results: out });
  } catch (e) {
    console.error("compare error:", e);
    res.status(500).json({ results: [] });
  }
});

// ---------- Compare by store + store_sku (GET) ----------
// /v1/compare_by_store_sku?store=bestbuy&store_sku=...
app.get("/v1/compare_by_store_sku", async (req, res) => {
  const store = String(req.query.store || "").trim();
  const storeSku = normSku(req.query.store_sku);

  if (!store || !storeSku) {
    return res.status(400).json({ results: [], error: "store and store_sku required" });
  }

  try {
    // Step 1: find an anchor listing row (get pci/upc and maybe amazon asin)
    const r1 = await pool.query(
      `
      SELECT store, store_sku, upc, pci
      FROM public.listings
      WHERE lower(btrim(store)) = lower(btrim($1))
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
        lower(btrim($3::text)) as anchor_store,
        public.norm_sku($4::text) as anchor_sku,
        (case when $2::text <> '' then upper(btrim($2::text)) else null end) as pci_key,
        (case when $1::text <> '' then public.norm_upc($1::text) else null end) as upc_key
    ),
    meta AS (
      SELECT c.brand, c.category
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
      CASE
        -- 3 = exact listing you are currently on
        WHEN lower(btrim(l.store)) = a.anchor_store
        AND public.norm_sku(l.store_sku) = a.anchor_sku THEN 3

        -- 2 = pci match
        WHEN a.pci_key IS NOT NULL
        AND l.pci IS NOT NULL AND btrim(l.pci) <> ''
        AND upper(btrim(l.pci)) = a.pci_key THEN 2

        -- 1 = upc match
        WHEN a.upc_key IS NOT NULL
        AND l.upc IS NOT NULL AND btrim(l.upc) <> ''
        AND public.norm_upc(l.upc) = a.upc_key THEN 1

        ELSE 0
      END AS match_strength
    FROM public.listings l
    CROSS JOIN anchor a
    LEFT JOIN meta m ON true
    WHERE
      -- always include the exact listing
      (lower(btrim(l.store)) = a.anchor_store AND public.norm_sku(l.store_sku) = a.anchor_sku)
      OR
      -- plus matches by pci/upc
      (a.pci_key IS NOT NULL AND l.pci IS NOT NULL AND btrim(l.pci) <> '' AND upper(btrim(l.pci)) = a.pci_key)
      OR
      (a.upc_key IS NOT NULL AND l.upc IS NOT NULL AND btrim(l.upc) <> '' AND public.norm_upc(l.upc) = a.upc_key)
    ORDER BY
      match_strength DESC,
      price_cents ASC NULLS LAST,
      observed_at DESC NULLS LAST,
      store ASC;
    `,
    [upc || "", pci || "", store, storeSku]
  );


    const out = r2.rows.map((r) => ({
      store: r.store,
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
      currency: "USD",
      match_strength: r.match_strength ?? null,
    }));

    res.json({ results: out, anchor: { store, store_sku: storeSku, upc: upc || null, pci: pci || null } });
  } catch (e) {
    console.error("compare_by_store_sku error:", e);
    res.status(500).json({ results: [] });
  }
});

// ---------- Observe (POST) ----------
// This writes/updates listings (unique store+store_sku) and appends price_history.
// Body should include: store, store_sku, price_cents, and optionally upc/pci/url/title/brand/category/offer_tag/observed_at
app.post("/v1/observe", async (req, res) => {
  const {
    store,
    store_sku,
    price_cents,
    upc,
    pci,
    url,
    title,
    brand,
    category,
    offer_tag,
    observed_at,
    status,
  } = req.body || {};

  const storeNorm = String(store || "").trim();
  const sku = normSku(store_sku);
  const cents = Number.isFinite(price_cents) ? price_cents : null;
  const upcNorm = upc ? normUPC(upc) : "";
  const pciNorm = pci ? normPci(pci) : "";

  if (!storeNorm || !sku || cents == null) {
    return res.status(400).json({ ok: false, error: "store, store_sku, price_cents required" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // listings upsert (unique is store+store_sku)
    await client.query(
      `
      INSERT INTO public.listings (
        store, store_sku, upc, pci, url, title, brand, category,
        offer_tag, status,
        current_price_cents, current_price_observed_at, created_at
      )
      VALUES (
        $1, $2, nullif($3,''), nullif($4,''),
        nullif($5,''), nullif($6,''), nullif($7,''), nullif($8,''),
        nullif($9,''), COALESCE(nullif($10,''), 'active'),
        $11, COALESCE($12::timestamptz, now()), now()
      )
      ON CONFLICT (store, store_sku)
      DO UPDATE SET
        upc = COALESCE(nullif(EXCLUDED.upc,''), listings.upc),
        pci = COALESCE(nullif(EXCLUDED.pci,''), listings.pci),
        url = COALESCE(nullif(EXCLUDED.url,''), listings.url),
        title = COALESCE(nullif(EXCLUDED.title,''), listings.title),
        brand = COALESCE(nullif(EXCLUDED.brand,''), listings.brand),
        category = COALESCE(nullif(EXCLUDED.category,''), listings.category),
        offer_tag = COALESCE(nullif(EXCLUDED.offer_tag,''), listings.offer_tag),
        status = COALESCE(nullif(EXCLUDED.status,''), listings.status),
        current_price_cents = EXCLUDED.current_price_cents,
        current_price_observed_at = EXCLUDED.current_price_observed_at;
      `,
      [
        storeNorm,
        sku,
        upcNorm,
        pciNorm,
        url || "",
        title || "",
        brand || "",
        category || "",
        offer_tag || "",
        status || "active",
        cents,
        observed_at || null,
      ]
    );

    // price_history append (optional but recommended)
    await client.query(
      `
      INSERT INTO public.price_history (store, store_sku, upc, pci, price_cents, observed_at, url, title)
      VALUES ($1, $2, nullif($3,''), nullif($4,''), $5, COALESCE($6::timestamptz, now()), nullif($7,''), nullif($8,''))
      `,
      [storeNorm, sku, upcNorm, pciNorm, cents, observed_at || null, url || "", title || ""]
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
  try { await pool.end(); } finally { process.exit(0); }
});
process.on("SIGTERM", async () => {
  try { await pool.end(); } finally { process.exit(0); }
});