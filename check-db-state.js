require('dotenv').config()
const { Pool } = require('pg')
const pool = new Pool({ connectionString: process.env.DATABASE_URL })

async function main() {
  const companies = await pool.query('SELECT id, name FROM "Company" ORDER BY "createdAt"')
  console.log('\n=== COMPANIES ===')
  for (const c of companies.rows) console.log(` [${c.id}] ${c.name}`)

  const users = await pool.query(`
    SELECT u.id, u.name, u.email, u.role, u."companyId", u."isActive", c.name AS company_name
    FROM "User" u LEFT JOIN "Company" c ON c.id = u."companyId"
    ORDER BY u."createdAt"
  `)
  console.log('\n=== USERS ===')
  for (const u of users.rows) {
    console.log(` [${u.role}] ${u.name} | ${u.email} | ${u.company_name} | active:${u.isActive}`)
  }

  const [pc, lead, conv] = await Promise.all([
    pool.query('SELECT COUNT(*) FROM "PermanentCustomer"'),
    pool.query('SELECT COUNT(*) FROM "Lead"'),
    pool.query('SELECT COUNT(*) FROM "Conversation"'),
  ])
  console.log('\n=== COUNTS ===')
  console.log(` PermanentCustomers: ${pc.rows[0].count}`)
  console.log(` Leads: ${lead.rows[0].count}`)
  console.log(` Conversations: ${conv.rows[0].count}`)

  await pool.end()
}
main().catch(e => { console.error(e.message); pool.end() })
