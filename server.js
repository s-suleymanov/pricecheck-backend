// server.js - ASIN-first compare API (latest per store from price_feed)

const express = require('express');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 4000;

// CORS for the extension
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Postgres
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Health
app.get('/health', (_req, res) => res.json({ ok: true, version: 'v6' }));

// GET /v1/compare?asin=B0XXXXXX
app.get('/v1/compare', async (req, res) => {
  const asin = String(req.query.asin || '').trim().toUpperCase();
  if (!asin || !/^[A-Z0-9]{10}$/.test(asin)) {
    return res.json({ results: [] });
  }

  try {
    // Latest price per store for this ASIN
    // DISTINCT ON picks the most recent row per store
    const { rows } = await pool.query(
      `
      WITH latest AS (
        SELECT DISTINCT ON (store)
          store,
          asin,
          url,
          COALESCE(title, '')        AS title,
          price_cents,
          observed_at
        FROM public.price_feed
        WHERE asin = $1
        ORDER BY store, observed_at DESC
      )
      SELECT store, asin, url, title, price_cents, observed_at
      FROM latest
      ORDER BY price_cents ASC NULLS LAST, store ASC
      `,
      [asin]
    );

    // Normalize to the extension's result shape
    const results = rows.map(r => ({
      store: r.store,
      product_name: r.title,
      price_cents: r.price_cents,
      url: r.url,
      currency: 'USD',
      asin: r.asin,
      seen_at: r.observed_at
    }));

    return res.json({ results });
  } catch (err) {
    console.error('Database query error:', err);
    return res.status(500).json({ results: [] });
  }
});

// Start
app.listen(PORT, '0.0.0.0', () => {
  console.log(`API server running on port ${PORT}`);
});

// Graceful shutdown
process.on('SIGINT', async () => { try { await pool.end(); } finally { process.exit(0); } });
process.on('SIGTERM', async () => { try { await pool.end(); } finally { process.exit(0); } });
  