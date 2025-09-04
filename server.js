// server.js - UPC Comparison API

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

// Postgres pool
// Set DATABASE_URL in Render dashboard
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Many Render Postgres instances require SSL
  ssl: { rejectUnauthorized: false }
});

// Health
app.get('/health', (req, res) => res.json({ ok: true, version: 'v1' }));

// GET /v1/compare?upc=012345678901
app.get('/v1/compare', async (req, res) => {
  const upc = String(req.query.upc || '').trim();
  if (!upc) return res.json({ results: [] });

  try {
    const { rows } = await pool.query(
      `
      SELECT upc, title, price_cents, url, store
      FROM products
      WHERE upc = $1
      ORDER BY price_cents ASC NULLS LAST
      LIMIT 1
      `,
      [upc]
    );

    if (rows.length === 0) return res.json({ results: [] });

    const r = rows[0] || {};
    // Always include both naming styles
    const item = {
      upc: r.upc || upc,
      title: r.title || '',
      product_name: r.title || '',
      url: r.url || '',
      link: r.url || '',
      price_cents: r.price_cents ?? null,
      store: r.store || 'Unknown Store',
      currency: 'USD'
    };

    return res.json({ results: [item] });
  } catch (err) {
    console.error('Database query error:', err);
    return res.status(500).json({ results: [] });
  }
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`API server running on port ${PORT}`);
});

// Graceful shutdown
process.on('SIGINT', async () => { try { await pool.end(); } finally { process.exit(0); } });
process.on('SIGTERM', async () => { try { await pool.end(); } finally { process.exit(0); } });
