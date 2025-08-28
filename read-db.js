// read-db.js

const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, 'prices.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    return console.error('Could not connect to database:', err.message);
  }
  console.log('Connected to database at path:', dbPath);
});

const sql = `SELECT upc, title FROM products`; // We only need UPC and title for this test

db.all(sql, [], (err, rows) => {
  if (err) {
    return console.error('Error running query:', err.message);
  }
  
  console.log("\n--- DATA FOUND IN 'products' TABLE ---");
  if (rows.length === 0) {
    console.log("The 'products' table is completely empty.");
  } else {
    console.log(`Found ${rows.length} total rows.`);
    // Print every row
    rows.forEach((row) => {
      console.log(row);
    });
  }
  console.log("-------------------------------------\n");

  // Close the database connection
  db.close();
});