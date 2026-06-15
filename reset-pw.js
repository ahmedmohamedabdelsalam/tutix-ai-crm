const { Pool } = require('pg');
const bcrypt = require('C:/Users/Computec/tutix-dashboard/node_modules/bcryptjs');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
async function main() {
  const hash = await bcrypt.hash('Test1234!', 10);
  await pool.query(`UPDATE "User" SET password = $1 WHERE email = 'mr.sherif@alex-travel.com'`, [hash]);
  console.log('Password reset to Test1234!');
  await pool.end();
}
main().catch(console.error);
