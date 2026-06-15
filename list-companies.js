require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

pool.query(`
  SELECT id, name, "waPhoneId", "isActive",
    CASE WHEN "waToken" IS NULL OR "waToken" = ''
      THEN 'EMPTY'
      ELSE 'SET:' || LEFT("waToken", 20) || '...'
    END AS token_status
  FROM "Company" ORDER BY "createdAt"
`).then(r => {
  console.log(JSON.stringify(r.rows, null, 2));
  pool.end();
}).catch(e => { console.error(e.message); pool.end(); });
