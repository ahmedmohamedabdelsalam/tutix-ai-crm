const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
async function main() {
  const res = await pool.query(`SELECT id, name, industry, "isActive", packages, "aiPrompt", phone, "ownerPhone" FROM "Company" WHERE id = 'cmq4ok7hx000004kzfnsxp54o'`);
  console.log(JSON.stringify(res.rows[0], null, 2));
  await pool.end();
}
main().catch(console.error);
