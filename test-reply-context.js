// Simulates a WhatsApp webhook POST with a "context" (reply) field.
// Confirms the handler doesn't skip or break on the extra field.
const http = require('http');

const data = JSON.stringify({
  object: 'whatsapp_business_account',
  entry: [{
    id: '874015102408586',
    changes: [{
      value: {
        messaging_product: 'whatsapp',
        metadata: {
          display_phone_number: '15554565115',
          phone_number_id: '1191029790754985'
        },
        contacts: [{ profile: { name: 'Test' }, wa_id: '201091656041' }],
        messages: [{
          from: '201091656041',
          id: 'test_reply_' + Date.now(),
          context: { from: '15554565115', id: 'wamid.FAKE123' },
          timestamp: Math.floor(Date.now() / 1000).toString(),
          text: { body: 'تمام عايز البرنامج التاني' },
          type: 'text'
        }]
      },
      field: 'messages'
    }]
  }]
});

const options = {
  hostname: 'localhost',
  port: 3001,
  path: '/webhook',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
  },
};

const req = http.request(options, (res) => {
  let body = '';
  res.on('data', c => body += c);
  res.on('end', () => {
    console.log('HTTP status:', res.statusCode);
    console.log('Response body:', body);
    console.log('\n(AI reply and logs visible in server.log — check with:)');
    console.log('  Get-Content server.log -Tail 20');
  });
});
req.on('error', e => console.error('Error:', e.message));
req.write(data);
req.end();
