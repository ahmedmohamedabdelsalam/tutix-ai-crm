require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS count FROM "PermanentCustomer" WHERE source = 'legacy'`
  );
  console.log('Current legacy records:', rows[0].count);
  await pool.end();
}
main().catch(e => { console.error(e); pool.end(); });
