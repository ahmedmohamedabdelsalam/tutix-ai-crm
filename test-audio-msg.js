// Test: webhook with type=audio should get fixed media reply, no AI call
const http = require('http');

const data = JSON.stringify({
  object: 'whatsapp_business_account',
  entry: [{
    id: '874015102408586',
    changes: [{
      value: {
        messaging_product: 'whatsapp',
        metadata: { display_phone_number: '15554565115', phone_number_id: '1191029790754985' },
        contacts: [{ profile: { name: 'Test' }, wa_id: '201091656041' }],
        messages: [{
          from: '201091656041',
          id: 'test_audio_' + Date.now(),
          timestamp: Math.floor(Date.now() / 1000).toString(),
          type: 'audio',
          audio: { id: 'fake_audio_id', mime_type: 'audio/ogg' }
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
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
};

const req = http.request(options, (res) => {
  let body = '';
  res.on('data', c => body += c);
  res.on('end', () => {
    console.log('HTTP status:', res.statusCode);
    console.log('Response body:', body);
  });
});
req.on('error', e => console.error('Error:', e.message));
req.write(data);
req.end();
