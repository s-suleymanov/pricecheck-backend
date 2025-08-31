// server.js - UPC Comparison API (PostgreSQL)

const express = require('express');
const { Pool } = require('pg');

// --- Basic Setup ---
const app = express();
const PORT = process.env.PORT || 4000;

// --- Middleware ---
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

// --- PostgreSQL Database Connection ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

console.log("✅ SUCCESS: Server is configured to connect to PostgreSQL.");

// --- API Endpoints ---
app.get('/v1/compare', async (req, res) => {
  const upc = (req.query.upc || '').trim();
  if (!upc) {
    return res.json({ results: [] });
  }

  // Use TRIM() to make the query robust against whitespace
  const sql = `SELECT * FROM products WHERE TRIM(upc) = TRIM($1) LIMIT 1`;
  const params = [upc];

  try {
    const { rows } = await pool.query(sql, params);
    const row = rows[0];

    if (!row) {
      return res.json({ results: [] });
    }

    const item = {
      title: row.title,
      price_cents: row.price_cents,
      url: row.link,
      currency: "USD",
      store: row.store || "Unknown Store"
    };

    res.json({ results: [item] });
  } catch (err) {
    console.error("Database query error:", err.message);
    return res.status(500).json({ results: [] });
  }
});

// --- Start Server ---
app.listen(PORT, () => {
  console.log(`API server is up and running on port ${PORT}`);
});