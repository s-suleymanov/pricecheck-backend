// import-csv.js - Your local tool to UPDATE the database from your CSV file.

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const csv = require('csv-parser');

// --- Configuration ---
const dbPath = path.resolve(__dirname, 'prices.db');
const csvFilePath = path.resolve(__dirname, 'target-search-works.csv');
const tableName = 'products';

// --- Database Connection ---
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) return console.error("Error opening your database file:", err.message);
  console.log("Connected to your local SQLite database...");
});

// Creates the 'products' table if it doesn't already exist.
const createTableSql = `
CREATE TABLE IF NOT EXISTS ${tableName} (
  upc TEXT PRIMARY KEY,
  title TEXT,
  price_cents INTEGER,
  link TEXT,
  store TEXT
);`;

db.serialize(() => {
  db.run(createTableSql, (err) => {
    if (err) return console.error("Error creating table:", err.message);
    
    console.log("Reading CSV to update your database...");
    
    // --- THIS IS THE KEY CHANGE ---
    // This SQL command will now UPDATE existing products.
    const sql = `
      INSERT INTO ${tableName} (upc, title, price_cents, link, store) 
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(upc) 
      DO UPDATE SET
        title = excluded.title,
        price_cents = excluded.price_cents,
        link = excluded.link;
    `;
    // ----------------------------

    const stmt = db.prepare(sql);
    let rowCount = 0;

    fs.createReadStream(csvFilePath)
      .pipe(csv())
      .on('data', (row) => {
        const upc = row.upc_row;
        const title = row.title_h1;
        const link = row.url;
        const store = "Target";

        const price_cents = row.price ? Math.round(parseFloat(row.price) * 100) : null;

        if (upc) {
          // The order of variables here MUST match the VALUES(?, ?, ?, ?, ?)
          stmt.run(upc, title, price_cents, link, store);
          rowCount++;
        }
      })
      .on('end', () => {
        stmt.finalize((err) => {
          if (err) {
            console.error('Error during database update:', err.message);
          } else {
            console.log(`\n✅ --- DATABASE UPDATE COMPLETE ---`);
            console.log(`${rowCount} rows from your CSV were processed.`);
          }
          db.close();
        });
      });
  });
});