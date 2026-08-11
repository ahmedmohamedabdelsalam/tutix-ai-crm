/**
 * GATE — THE TICK MUST NEVER CLAIM MORE THAN WE KNOW  (step 5b)
 *
 * The happy path is not what this guards. Three honest cases are, and each one is a
 * way the display can lie confidently:
 *
 *   A. NO STATUS RENDERS NO TICK. Every message sent before status capture shipped
 *      has no status and never will. A grey tick meaning "not delivered yet" on a
 *      month-old message is a false statement about a conversation a rep may act on.
 *      Absence has to look like absence — and a negative rule inside a render
 *      function is exactly the kind that rots unnoticed, which is why the decision
 *      lives in a pure function this suite compiles and calls directly.
 *
 *   B. THE UI ADVANCES EXACTLY AS THE DATA DOES. Two independent orderings — one in
 *      the CRM's status-webhook.ts, one in the dashboard's delivery-tick.ts — will
 *      drift apart unless something compares them. Restated here as a third
 *      statement so agreement is proven rather than assumed.
 *
 *   C. A FAILED MESSAGE SHOWS ITS REASON, IN ARABIC. That is a customer who never
 *      received the message; a bare red mark with a Meta error code is a bug report,
 *      not something a salesperson can act on.
 *
 * Compiles the REAL dashboard module with tsc and requires the output, so it asserts
 * the artifact rather than a copy of it. Touches no database rows and sends nothing.
 *
 *   node test/gate/delivery-tick-suite.js
 */
'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const DASH = process.env.DASHBOARD_DIR || 'C:/Users/Computec/tutix-dashboard'
const OUT  = fs.mkdtempSync(path.join(os.tmpdir(), 'tickgate-'))

let pass = 0, fail = 0
const t = (ok, label, detail) => {
  if (ok) { console.log(`  ✅ ${label}`); pass++ }
  else { console.log(`  ❌ ${label}${detail ? `\n     ${detail}` : ''}`); fail++ }
}

/** The CRM's ordering, restated. Must match dashboard tickAdvances exactly. */
const CRM_RANK = { sent: 1, failed: 2, delivered: 3, read: 4 }
const crmAdvances = (cur, next) => (CRM_RANK[next] ?? 0) > (CRM_RANK[cur] ?? 0)

;(async () => {
  let T
  try {
    // Compile the real files — not a copy, not a restatement of the component.
    console.log('compiling lib/delivery-tick.ts + lib/meta-errors.ts …')
    execFileSync('npx', ['tsc',
      path.join(DASH, 'lib/delivery-tick.ts'),
      path.join(DASH, 'lib/meta-errors.ts'),
      '--outDir', OUT, '--module', 'commonjs', '--target', 'es2020',
      '--skipLibCheck', '--esModuleInterop',
    ], { stdio: 'pipe', shell: true })
    T = require(path.join(OUT, 'delivery-tick.js'))
    console.log('compiled ✓\n')
  } catch (e) {
    console.error('FATAL: could not compile the dashboard module')
    console.error(String(e.stdout || e.message))
    process.exit(1)
  }

  // ── A. no status renders nothing ──────────────────────────────────────────
  console.log('A. absence looks like absence')
  for (const v of [null, undefined, '']) {
    const spec = T.tickFor(v)
    t(spec.kind === 'none', `status=${JSON.stringify(v)} → kind 'none' (got '${spec.kind}')`)
    t(spec.label === '' && spec.tooltip === '', `status=${JSON.stringify(v)} → nothing to draw at all`)
  }
  t(T.tickFor('some_future_meta_status').kind === 'none',
    'an UNKNOWN status draws nothing rather than inventing a mark')

  // ── B. the ordering matches the CRM's, exactly ────────────────────────────
  console.log('\nB. the UI advances exactly as the data does')
  {
    const vals = [null, 'sent', 'failed', 'delivered', 'read']
    let mismatches = []
    for (const cur of vals) for (const next of vals) {
      if (T.tickAdvances(cur, next) !== crmAdvances(cur, next)) mismatches.push(`${cur}→${next}`)
    }
    t(mismatches.length === 0, 'display ordering agrees with the CRM data ordering in all 25 pairs',
      mismatches.join(', '))
    t(!T.tickAdvances('read', 'delivered'), 'read → delivered never advances in the UI')
    t(!T.tickAdvances('read', 'failed'), 'read → failed never advances in the UI')
    t(T.tickAdvances('sent', 'failed'), 'sent → failed does advance')
    t(!T.tickAdvances('sent', 'nonsense'), 'an unknown status never advances the UI')
  }

  // ── C. a failure explains itself, in Arabic ───────────────────────────────
  console.log('\nC. a failed message shows its reason, in Arabic')
  {
    const spec = T.tickFor('failed', '(#131047) Re-engagement message — more than 24 hours have passed')
    t(spec.kind === 'failed', 'failed maps to the failed mark')
    t(spec.label.length > 0, 'the reason is VISIBLE, not tooltip-only')
    t(/[\u0600-\u06FF]/.test(spec.label), `the reason is Arabic — "${spec.label.slice(0, 60)}"`)
    t(!spec.label.includes('131047'), 'the raw Meta code is not shown to the rep')

    const bare = T.tickFor('failed', null)
    t(bare.kind === 'failed' && /[\u0600-\u06FF]/.test(bare.label),
      `a failure with NO stored reason still says something Arabic — "${bare.label.slice(0, 50)}"`)
    t(bare.label.length > 0, 'never a red mark with no explanation')
  }

  // ── D. the two grey ticks must not read as "ignored" ──────────────────────
  // The single most likely misreading of the whole feature, and the reason a rep
  // would stop chasing a live lead.
  console.log('\nD. two grey ticks cannot be read as "the customer ignored me"')
  {
    const d = T.tickFor('delivered')
    t(d.kind === 'delivered', 'delivered maps to the double mark')
    t(d.tooltip.includes('تم القراءة'), 'the tooltip names the read-receipts setting')
    t(d.tooltip.includes('تجاهل'), 'and says explicitly it does NOT mean they ignored it')
    t(T.tickFor('read').tooltip.length > 0, 'read has its own tooltip')
    t(T.tickFor('sent').tooltip.length > 0, 'sent has its own tooltip')
  }

  fs.rmSync(OUT, { recursive: true, force: true })
  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`)
  if (fail > 0) console.log('The delivery tick can claim something we do not know.')
  process.exit(fail === 0 ? 0 : 1)
})()
