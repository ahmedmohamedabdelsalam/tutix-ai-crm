const https = require('https');

const token = 'EAAVWRomxztgBRrlsIUXFe3G7TdZB9THCM5DTNWMXxoZA4rXZBQhMY5pMXm1jXDfB6ZAxditCuEloi3jvpLuXOjIy9Q6vtpXamXK4WxZBSNKgbrkkNFdwnHw743nrA3rRMWhVePXkrf4ezPqbeFAtRawMkKEA3W6YarLNiZCbZCMFheMQcLr4n6IQAsrlE8XdAZDZD';
const phoneId = '1191029790754985';
const toPhone = '201091656041';

const data = JSON.stringify({
  messaging_product: 'whatsapp',
  to: toPhone,
  type: 'text',
  text: { body: 'اختبار من TUTIX AI CRM - الواتساب شغال!' }
});

const options = {
  hostname: 'graph.facebook.com',
  path: '/v18.0/' + phoneId + '/messages',
  method: 'POST',
  headers: {
    'Authorization': 'Bearer ' + token,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data)
  }
};

const req = https.request(options, (res) => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    console.log('Status:', res.statusCode);
    console.log('Response:', body);
  });
});

req.on('error', e => console.error('Error:', e));
req.write(data);
req.end();
