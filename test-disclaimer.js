const http = require('http');

function post(phone, message) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ phone, message });
    const req = http.request({
      hostname: 'localhost', port: 3001,
      path: '/webhook/test', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve(JSON.parse(body).reply));
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

async function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function run() {
  // ─── SCENARIO 1: Hajj inquiry → request details → check disclaimer ───
  console.log('\n══════════════════════════════════════════════════');
  console.log('SCENARIO 1 — حج عام: هل يظهر إخلاء المسؤولية؟');
  console.log('══════════════════════════════════════════════════');

  const p1 = '201901000001';
  let r;

  r = await post(p1, 'السلام عليكم');
  console.log('> [تحية]\n<', r);
  await delay(1000);

  r = await post(p1, 'محمد');
  console.log('\n> محمد\n<', r);
  await delay(1000);

  r = await post(p1, 'عايز أسأل عن الحج');
  console.log('\n> عايز أسأل عن الحج\n<', r);
  await delay(1000);

  r = await post(p1, 'اثنين أفراد');
  console.log('\n> اثنين أفراد\n<', r);
  await delay(1000);

  r = await post(p1, 'اقتصادي تحسين خمس نجوم');
  console.log('\n> اقتصادي تحسين خمس نجوم\n<', r);

  const s1HasDisclaimer = r.includes('تقريب') || r.includes('رؤية الهلال') || r.includes('يُعلن') || r.includes('رسمياً');
  console.log('\n✅ PASS — إخلاء المسؤولية موجود:', s1HasDisclaimer ? 'نعم' : '❌ لا');

  // ─── SCENARIO 2: "متى يوم عرفة؟" → check disclaimer ───
  console.log('\n══════════════════════════════════════════════════');
  console.log('SCENARIO 2 — "متى بالظبط يوم عرفة؟"');
  console.log('══════════════════════════════════════════════════');

  const p2 = '201901000002';

  r = await post(p2, 'السلام عليكم');
  await delay(800);
  r = await post(p2, 'أحمد');
  await delay(800);
  r = await post(p2, 'عايز أعرف متى بالظبط يوم عرفة في موسم الحج الجاي');
  console.log('> متى بالظبط يوم عرفة؟\n<', r);

  const s2HasDisclaimer = r.includes('تقريب') || r.includes('رؤية الهلال') || r.includes('يُعلن') || r.includes('رسمياً');
  const s2HasDate = r.includes('١٥ مايو') || r.includes('عرفة') || r.includes('ذي الحجة');
  console.log('\n✅ PASS — التاريخ مذكور:', s2HasDate ? 'نعم' : '❌ لا');
  console.log('✅ PASS — إخلاء المسؤولية موجود:', s2HasDisclaimer ? 'نعم' : '❌ لا');

  // ─── SCENARIO 3: عمرة يوليو → لا يجب ظهور إخلاء المسؤولية ───
  console.log('\n══════════════════════════════════════════════════');
  console.log('SCENARIO 3 — عمرة يوليو: يجب عدم ظهور إخلاء المسؤولية');
  console.log('══════════════════════════════════════════════════');

  const p3 = '201901000003';

  r = await post(p3, 'السلام عليكم');
  await delay(800);
  r = await post(p3, 'سارة');
  await delay(800);
  r = await post(p3, 'عايزة أسأل عن عمرة يوليو');
  console.log('> عمرة يوليو\n<', r);
  await delay(800);
  r = await post(p3, 'اقتصادي');
  console.log('\n> اقتصادي\n<', r);

  const s3HasDisclaimer = r.includes('تقريب') || r.includes('رؤية الهلال') || r.includes('يُعلن رسمياً');
  const s3HasHijri = r.includes('محرم') || r.includes('صفر') || r.includes('١٤٤٨');
  console.log('\n✅ PASS — لا يوجد إخلاء مسؤولية للعمرة:', !s3HasDisclaimer ? 'صح (لا يوجد)' : '❌ ظهر بالخطأ');
  console.log('✅ PASS — التاريخ الهجري مذكور بدون قيد:', s3HasHijri ? 'نعم' : '(لم يُذكر)');

  // ─── SCENARIO 4: طبيعية الأسلوب ───
  console.log('\n══════════════════════════════════════════════════');
  console.log('SCENARIO 4 — طبيعية إخلاء المسؤولية (من سيناريو 1)');
  console.log('══════════════════════════════════════════════════');
  const p4 = '201901000004';
  r = await post(p4, 'السلام عليكم');
  await delay(800);
  r = await post(p4, 'خالد');
  await delay(800);
  r = await post(p4, 'الحج');
  await delay(800);
  r = await post(p4, 'اثنين');
  await delay(800);
  r = await post(p4, 'خمس نجوم');
  console.log('> خمس نجوم (حج)\n<', r);
  console.log('\n[قيّم بنفسك: هل الجملة التوضيحية طبيعية في الكلام أم تبدو كإشعار قانوني؟]');
}

run().catch(console.error);
