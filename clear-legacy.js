require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const { rowCount } = await pool.query(
    `DELETE FROM "PermanentCustomer" WHERE source = 'legacy'`
  );
  console.log('Deleted:', rowCount);
  await pool.end();
}
main().catch(e => { console.error(e); pool.end(); });
