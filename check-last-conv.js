require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

pool.query(`
  SELECT c.id, c.status, c.phone, c."updatedAt",
    json_agg(
      json_build_object('role', m.role, 'content', LEFT(m.content, 120), 'createdAt', m."createdAt")
      ORDER BY m."createdAt" DESC
    ) AS messages
  FROM "Conversation" c
  JOIN "Message" m ON m."conversationId" = c.id
  WHERE c."companyId" = $1
  GROUP BY c.id
  ORDER BY c."updatedAt" DESC
  LIMIT 1
`, [process.env.DEFAULT_COMPANY_ID])
.then(r => {
  if (!r.rows.length) { console.log('No conversations found'); }
  else { console.log(JSON.stringify(r.rows[0], null, 2)); }
  pool.end();
})
.catch(e => { console.error(e.message); pool.end(); });
