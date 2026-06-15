const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
async function main() {
  const res = await pool.query(`SELECT id, name, email, role, "companyId", "isActive" FROM "User" LIMIT 10`);
  console.log(JSON.stringify(res.rows, null, 2));
  await pool.end();
}
main().catch(console.error);
