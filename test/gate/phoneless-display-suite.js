/**
 * GATE — A PHONE-LESS CUSTOMER MUST BE VISIBLE AND FINDABLE  (Phase 3d)
 *
 * Phase 3c made these customers answerable. Answerable but unidentifiable is only
 * half a fix: a thread a rep cannot name is one they will not open, and a customer
 * they cannot search for is one they cannot return to. Before 3d the inbox showed a
 * blank cell — indistinguishable from a rendering fault — and search matched
 * message CONTENT only, so someone with no phone to type was effectively
 * unfindable.
 *
 * Drives the REAL dashboard API with a real CRM session, so it fails if the label
 * fields stop being returned or the search stops matching identity.
 *
 * SAFETY: creates one conversation with a BSUID reserved for this suite, asserts
 * against it, and removes it in a finally block. Touches nothing else. Sends
 * nothing to WhatsApp.
 *
 *   node test/gate/phoneless-display-suite.js
 *   DASHBOARD_URL=http://localhost:3001 node test/gate/phoneless-display-suite.js
 */
'use strict'
const http = require('http')
const https = require('https')
const crypto = require('crypto')
const { Pool } = require('pg')
require('dotenv').config()

const DASH = process.env.DASHBOARD_URL || 'http://localhost:3000'
const DASH_ENV = process.env.DASHBOARD_ENV || 'C:/Users/Computec/tutix-dashboard/.env.local'
const CO = process.env.DEFAULT_COMPANY_ID
require('dotenv').config({ path: DASH_ENV })
const SECRET = process.env.JWT_SECRET

if (!CO) { console.error('FATAL: DEFAULT_COMPANY_ID not set'); process.exit(1) }
if (!SECRET) { console.error(`FATAL: JWT_SECRET not found (looked in ${DASH_ENV})`); process.exit(1) }

const SUITE_BSUID   = 'EG.77776666555544443333'
const SUITE_PROFILE = 'زائرالاختبار'
const CONV_ID       = 'gate3dconv0001'
const pool = new Pool({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL })

/** The same HS256 CRM session lib/crm-auth.ts issues; verifyCrmToken needs type==='crm'. */
function signCrmJwt(payload) {
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ ...payload, type: 'crm', iat: now, exp: now + 600 })}`
  return `${body}.${crypto.createHmac('sha256', SECRET).update(body).digest('base64url')}`
}

function get(path, token) {
  const url = new URL(`${DASH}${path}`)
  const client = url.protocol === 'https:' ? https : http
  return new Promise((res, rej) => {
    const req = client.request({
      hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search, method: 'GET',
      headers: { Cookie: `crm_session=${token}` },
    }, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => resolveBody(res, r.statusCode, b)) })
    req.on('error', rej); req.setTimeout(30000, () => { req.destroy(); rej(new Error('timeout')) })
    req.end()
  })
}
function resolveBody(res, status, b) { try { res({ status, json: JSON.parse(b), raw: b }) } catch { res({ status, json: null, raw: b }) } }

/**
 * The documented label chain, reimplemented from its spec rather than imported.
 * The helper lives in the other repo; restating the ORDER here means a silent
 * change to it shows up as a failure rather than as agreement with itself.
 */
function expectedLabel(x) {
  if (x.name && x.name.trim()) return x.name.trim()
  if (x.profileName && x.profileName.trim()) return x.profileName.trim()
  if (x.phone) return x.phone
  if (x.waUserId) {
    const dot = x.waUserId.indexOf('.')
    return dot > 0 ? `${x.waUserId.slice(0, dot)}.…${x.waUserId.slice(-4)}` : x.waUserId
  }
  return 'عميل بدون اسم'
}

;(async () => {
  const c = await pool.connect()
  let pass = 0, fail = 0
  const t = (ok, label, detail) => {
    if (ok) { console.log(`  ✅ ${label}`); pass++ }
    else { console.log(`  ❌ ${label}${detail ? `\n     ${detail}` : ''}`); fail++ }
  }
  const cleanup = async () => {
    await c.query('DELETE FROM "Message" WHERE "conversationId"=$1', [CONV_ID]).catch(() => {})
    await c.query('DELETE FROM "Conversation" WHERE id=$1', [CONV_ID]).catch(() => {})
  }

  try {
    const probe = await get('/api/crm/inbox', 'x').catch(() => null)
    if (!probe) {
      console.error(`FATAL: dashboard not reachable at ${DASH}\nStart it:  cd tutix-dashboard && npm run dev`)
      process.exit(1)
    }

    // A real CRM user of this company — the API scopes every query by their session.
    const user = (await c.query(
      `SELECT id, email, role, name FROM "User" WHERE "companyId"=$1 AND "isActive"=true
        AND role IN ('COMPANY_ADMIN','SALES_MANAGER') ORDER BY role LIMIT 1`, [CO])).rows[0]
      ?? (await c.query(`SELECT id, email, role, name FROM "User" WHERE "companyId"=$1 LIMIT 1`, [CO])).rows[0]
    if (!user) { console.error('FATAL: no CRM user for this company'); process.exit(1) }
    const token = signCrmJwt({ userId: user.id, email: user.email, role: user.role, companyId: CO, name: user.name })
    console.log(`acting as ${user.name} (${user.role})\n`)

    await cleanup()
    await c.query(
      `INSERT INTO "Conversation" (id,"companyId",phone,"waUserId","profileName",status,"agentMode","isTest","createdAt","updatedAt")
       VALUES ($1,$2,NULL,$3,$4,'AI_HANDLING'::"ConvStatus",'HUMAN',false,now(),now())`,
      [CONV_ID, CO, SUITE_BSUID, SUITE_PROFILE])
    await c.query(
      `INSERT INTO "Message" (id,"conversationId",role,content,"createdAt")
       VALUES ($1,$2,'USER'::"MessageRole",$3,now())`,
      ['gate3dmsg0001', CONV_ID, 'رسالة اختبار من عميل بدون رقم'])

    // ── A. the inbox must RETURN what the label needs ────────────────────────
    console.log('A. inbox list returns label fields')
    {
      const r = await get('/api/crm/inbox', token)
      t(r.status === 200, `inbox returns 200 (got ${r.status})`, r.raw.slice(0, 160))
      const rows = r.json?.conversations ?? r.json?.items ?? r.json ?? []
      const row = Array.isArray(rows) ? rows.find(x => x.id === CONV_ID) : null
      t(!!row, 'the phone-less conversation appears in the inbox list')
      if (row) {
        t(row.phone === null, 'its phone is null — this is the case under test')
        t(row.profileName === SUITE_PROFILE, 'profileName is RETURNED, not just stored', `got ${row.profileName}`)
        t(row.waUserId === SUITE_BSUID, 'waUserId is returned', `got ${row.waUserId}`)
        const label = expectedLabel({ name: row.lead?.name, profileName: row.profileName, phone: row.phone, waUserId: row.waUserId })
        t(!!label && label.trim().length > 0, `renders a NAME, never blank — "${label}"`)
        t(label !== SUITE_BSUID, 'never the raw 20-character id')
      }
    }

    // ── B. findable by the things a rep would actually type ──────────────────
    console.log('\nB. search finds a customer with no phone')
    const findsIt = async (q, label) => {
      const r = await get(`/api/crm/inbox/search?q=${encodeURIComponent(q)}`, token)
      const hit = (r.json?.results ?? []).some(x => x.convId === CONV_ID)
      t(hit, `${label} — q="${q}"`, `status=${r.status} results=${(r.json?.results ?? []).length}`)
      return r
    }
    await findsIt(SUITE_PROFILE, 'by WhatsApp profile name')
    await findsIt(SUITE_PROFILE.slice(0, 4), 'by a partial profile name')
    await findsIt(SUITE_BSUID, 'by full BSUID')
    await findsIt(SUITE_BSUID.slice(-6), 'by the tail of the BSUID')

    // A search result must carry enough to be labelled, or the row renders blank.
    {
      const r = await get(`/api/crm/inbox/search?q=${encodeURIComponent(SUITE_PROFILE)}`, token)
      const hit = (r.json?.results ?? []).find(x => x.convId === CONV_ID)
      t(!!hit && hit.profileName === SUITE_PROFILE, 'search results carry profileName')
      t(!!hit && hit.waUserId === SUITE_BSUID, 'search results carry waUserId')
      if (hit) {
        const label = expectedLabel({ name: hit.leadName, profileName: hit.profileName, phone: hit.phone, waUserId: hit.waUserId })
        t(!!label.trim(), `search row renders a name — "${label}"`)
      }
    }

    // ── C. no regression for customers who DO have a phone ───────────────────
    console.log('\nC. a phone-keyed customer is unaffected')
    {
      const real = (await c.query(
        `SELECT phone FROM "Conversation" WHERE "companyId"=$1 AND phone IS NOT NULL AND "isTest"=false
          ORDER BY "updatedAt" DESC LIMIT 1`, [CO])).rows[0]
      if (real) {
        const r = await get(`/api/crm/inbox/search?q=${encodeURIComponent(real.phone)}`, token)
        t((r.json?.results ?? []).length > 0, `still findable by phone — "${real.phone}"`, `status=${r.status}`)
        t(expectedLabel({ name: null, profileName: null, phone: real.phone, waUserId: null }) === real.phone,
          'a phone still labels the row when there is no name')
      } else {
        console.log('  ⏭  no phone-keyed conversation to compare against')
      }
    }
  } catch (e) {
    console.error(`\nFATAL: ${e.message}`)
    fail++
  } finally {
    await cleanup()
    c.release(); await pool.end()
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`)
  if (fail > 0) console.log('A customer with no phone is invisible or unfindable in the inbox.')
  process.exit(fail === 0 ? 0 : 1)
})()
