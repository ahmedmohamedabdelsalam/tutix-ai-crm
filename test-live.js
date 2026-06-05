const https = require('https');

const data = JSON.stringify({
  phone: '201234567890',
  message: 'عايز أعمل عمرة'
});

const options = {
  hostname: 'tutix-ai-crm-production.up.railway.app',
  port: 443,
  path: '/webhook/test',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data)
  }
};

const req = https.request(options, (res) => {
  let body = '';
  res.on('data', (chunk) => body += chunk);
  res.on('end', () => {
    console.log('Status:', res.statusCode);
    console.log('Response:', body);
  });
});

req.on('error', (e) => console.error('Error:', e));
req.write(data);
req.end();
