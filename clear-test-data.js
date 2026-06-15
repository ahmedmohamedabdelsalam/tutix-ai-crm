require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companyId = process.env.DEFAULT_COMPANY_ID;

async function main() {
  if (!companyId) { console.error('DEFAULT_COMPANY_ID not set'); process.exit(1); }
  const { rows: msgs } = await pool.query(
    'DELETE FROM "Message" WHERE "conversationId" IN (SELECT id FROM "Conversation" WHERE "companyId" = $1) RETURNING id',
    [companyId]
  );
  const { rows: convs } = await pool.query(
    'DELETE FROM "Conversation" WHERE "companyId" = $1 RETURNING id', [companyId]
  );
  const { rows: leads } = await pool.query(
    'DELETE FROM "Lead" WHERE "companyId" = $1 RETURNING id', [companyId]
  );
  console.log(`Cleared: ${msgs.length} messages, ${convs.length} conversations, ${leads.length} leads`);
  await pool.end();
}
main().catch(e => { console.error(e.message); process.exit(1); });
