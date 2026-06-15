require('dotenv').config()
const { Pool } = require('pg')
const pool = new Pool({ connectionString: process.env.DATABASE_URL })

// Pre-computed bcrypt hashes (cost=10)
const HASHES = {
  ahmed:  '$2b$10$xXWZ.oBm0CUis6JE6dGL4.hzfyiZ6qcV37sQ6uWet5fQL.hTdYxci', // Ahmed@2026
  sherif: '$2b$10$mWKglkydNpPW17hyt3zMD.FtZ.HqByIqp8o7jgZ.5r9iorKklC00W', // Sherif@2026
}

async function main() {
  // ── PART 2: Set emailDomain for companies ─────────────────────
  console.log('\n=== Setting email domains ===')

  const alexId = 'cmq4ok7hx000004kzfnsxp54o'
  const tutixId = 'cmq0973ie0000t8l0n43q3vpj'

  await pool.query(`UPDATE "Company" SET "emailDomain" = $1 WHERE id = $2`, ['alex-travel.com', alexId])
  console.log(' ✓ إسكندرية الدولية → alex-travel.com')

  await pool.query(`UPDATE "Company" SET "emailDomain" = $1 WHERE id = $2`, ['tutix.com', tutixId])
  console.log(' ✓ شركة تيوتيكس → tutix.com')

  // ── PART 4.1: Rename admin@alex-travel.com → ahmed@alex-travel.com ──
  console.log('\n=== Renaming admin@alex-travel.com → ahmed@alex-travel.com ===')
  const ahmedPw = HASHES.ahmed
  const rename = await pool.query(
    `UPDATE "User" SET email = $1, name = $2, password = $3 WHERE email = $4 RETURNING id, name, email, role`,
    ['ahmed@alex-travel.com', 'أحمد', ahmedPw, 'admin@alex-travel.com']
  )
  if (rename.rowCount) console.log(` ✓ Renamed: ${JSON.stringify(rename.rows[0])}`)
  else console.log(' ⚠ admin@alex-travel.com not found — already renamed or missing')

  // ── PART 4.2: Create Mr. Sherif ──────────────────────────────────
  console.log('\n=== Creating mr.sherif@alex-travel.com ===')
  const sherifPw = HASHES.sherif
  // Check if already exists
  const existing = await pool.query(`SELECT id FROM "User" WHERE email = $1`, ['mr.sherif@alex-travel.com'])
  if (existing.rowCount === 0) {
    const cuid = () => {
      const ts = Date.now().toString(36)
      const rand = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10)
      return 'c' + ts + rand
    }
    const newId = cuid()
    await pool.query(
      `INSERT INTO "User" (id, "companyId", name, email, password, role, "isActive", "createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
      [newId, alexId, 'Mr. Sherif', 'mr.sherif@alex-travel.com', sherifPw, 'COMPANY_ADMIN', true]
    )
    console.log(' ✓ Created mr.sherif@alex-travel.com (COMPANY_ADMIN)')
  } else {
    console.log(' ⚠ mr.sherif@alex-travel.com already exists, updating password')
    await pool.query(`UPDATE "User" SET name = 'Mr. Sherif', password = $1, role = 'COMPANY_ADMIN' WHERE email = $2`, [sherifPw, 'mr.sherif@alex-travel.com'])
  }

  // ── PART 4.3: List users to delete ───────────────────────────────
  console.log('\n=== Users to DELETE (showing before delete) ===')
  const toDelete = await pool.query(`
    SELECT u.email, u.name, u.role, c.name AS company
    FROM "User" u LEFT JOIN "Company" c ON c.id = u."companyId"
    WHERE u.email IN ('agent@tutix.com','manager@tutix.com','admin@company.com','ahmedabdelsalam.300200@gmail.com')
    ORDER BY u.email
  `)
  for (const u of toDelete.rows) console.log(`  DELETE: [${u.role}] ${u.name} | ${u.email} | ${u.company}`)

  if (toDelete.rowCount === 0) {
    console.log('  (none found — already deleted)')
  } else {
    await pool.query(`
      DELETE FROM "User"
      WHERE email IN ('agent@tutix.com','manager@tutix.com','admin@company.com','ahmedabdelsalam.300200@gmail.com')
    `)
    console.log(` ✓ Deleted ${toDelete.rowCount} test user(s)`)
  }

  // ── PART 4.4: Clear test conversations/leads/messages/tasks/callLogs ──
  console.log('\n=== Clearing test data (conversations, leads, tasks, calls) ===')
  const msgDel = await pool.query(`DELETE FROM "Message"`)
  console.log(` ✓ Messages deleted: ${msgDel.rowCount}`)
  const convDel = await pool.query(`DELETE FROM "Conversation"`)
  console.log(` ✓ Conversations deleted: ${convDel.rowCount}`)
  const callDel = await pool.query(`DELETE FROM "CallLog"`)
  console.log(` ✓ CallLogs deleted: ${callDel.rowCount}`)
  const taskDel = await pool.query(`DELETE FROM "Task"`)
  console.log(` ✓ Tasks deleted: ${taskDel.rowCount}`)
  const leadDel = await pool.query(`DELETE FROM "Lead"`)
  console.log(` ✓ Leads deleted: ${leadDel.rowCount}`)

  // ── Final state ───────────────────────────────────────────────────
  console.log('\n=== Final user state ===')
  const finalUsers = await pool.query(`
    SELECT u.name, u.email, u.role, c.name AS company
    FROM "User" u LEFT JOIN "Company" c ON c.id = u."companyId"
    WHERE u.role != 'PLATFORM_ADMIN'
    ORDER BY c.name, u."createdAt"
  `)
  for (const u of finalUsers.rows) console.log(` [${u.role}] ${u.name} | ${u.email} | ${u.company}`)

  const pcCount = await pool.query(`SELECT COUNT(*) FROM "PermanentCustomer"`)
  const leadCount = await pool.query(`SELECT COUNT(*) FROM "Lead"`)
  const convCount = await pool.query(`SELECT COUNT(*) FROM "Conversation"`)
  console.log(`\n PermanentCustomers: ${pcCount.rows[0].count} (unchanged)`)
  console.log(` Leads: ${leadCount.rows[0].count}`)
  console.log(` Conversations: ${convCount.rows[0].count}`)

  await pool.end()
}
main().catch(e => { console.error(e.message); pool.end() })
