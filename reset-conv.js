require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const phone = process.argv[2] || '201091656041';

pool.query(
  `UPDATE "Conversation"
   SET status = 'CLOSED', "agentMode" = 'AI'
   WHERE phone = $1 AND "companyId" = $2 AND status != 'CLOSED'
   RETURNING id, phone, status, "agentMode"`,
  [phone, process.env.DEFAULT_COMPANY_ID]
).then(r => {
  if (!r.rows.length) { console.log('No open conversations found for', phone); }
  else { console.log('Closed:', JSON.stringify(r.rows, null, 2)); }
  pool.end();
}).catch(e => { console.error(e.message); pool.end(); });
