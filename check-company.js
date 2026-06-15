require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const id = process.env.DEFAULT_COMPANY_ID;

pool.query(
  `SELECT id, name, "waPhoneId", "isActive",
          CASE WHEN "waToken" IS NULL OR "waToken" = '' THEN 'EMPTY' ELSE 'SET:' || LEFT("waToken", 16) || '...' END AS token_status
   FROM "Company" WHERE id = $1`,
  [id]
).then(r => {
  if (!r.rows.length) { console.log('Company NOT FOUND for id:', id); }
  else { console.log(JSON.stringify(r.rows[0], null, 2)); }
  pool.end();
}).catch(e => { console.error(e.message); pool.end(); });
