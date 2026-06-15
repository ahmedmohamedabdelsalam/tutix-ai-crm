const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
async function main() {
  const res = await pool.query(`SELECT id, name, email, role, password FROM "User" WHERE email = 'mr.sherif@alex-travel.com'`);
  console.log('hash:', res.rows[0].password ? res.rows[0].password.substring(0, 20) + '...' : 'null');
  await pool.end();
}
main().catch(console.error);
