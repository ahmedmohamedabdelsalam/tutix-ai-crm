require('dotenv').config();
const https = require('https');
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const companyId = process.env.DEFAULT_COMPANY_ID;
pool.query(
  `SELECT name, "waToken", "waPhoneId" FROM "Company" WHERE id = $1`,
  [companyId]
).then(r => {
  if (!r.rows.length) { console.log('No company found'); return pool.end(); }
  const company = r.rows[0];
  console.log('Using company:', company.name);
  const token = company.waToken;

  // ── Check 1: WABA verification status ──────────────────────────
  const wabaOptions = {
    hostname: 'graph.facebook.com',
    path: '/v18.0/874015102408586?fields=name,id,business_verification_status,message_template_namespace',
    method: 'GET',
    headers: { 'Authorization': 'Bearer ' + token }
  };

  // ── Check 2: Phone number messaging limit ───────────────────────
  const phoneOptions = {
    hostname: 'graph.facebook.com',
    path: '/v18.0/' + company.waPhoneId + '?fields=whatsapp_business_manager_messaging_limit,quality_rating,verified_name',
    method: 'GET',
    headers: { 'Authorization': 'Bearer ' + token }
  };

  const wabaReq = new Promise((resolve, reject) => {
    const req = https.request(wabaOptions, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });

  const phoneReq = new Promise((resolve, reject) => {
    const req = https.request(phoneOptions, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });

  return Promise.all([wabaReq, phoneReq]).then(([waba, phone]) => {
    console.log('\n=== WABA Verification Status ===');
    console.log('HTTP:', waba.status);
    console.log(JSON.stringify(JSON.parse(waba.body), null, 2));

    console.log('\n=== Phone Messaging Limit ===');
    console.log('HTTP:', phone.status);
    console.log(JSON.stringify(JSON.parse(phone.body), null, 2));

    return pool.end();
  });
}).catch(e => { console.error(e.message); pool.end(); });
