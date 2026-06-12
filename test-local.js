const http = require('http');

const data = JSON.stringify({
  phone: '201111111112',
  message: 'خليني افكر وارد عليك'
});

const options = {
  hostname: 'localhost',
  port: 3001,
  path: '/webhook/test',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data)
  }
};

const req = http.request(options, (res) => {
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
