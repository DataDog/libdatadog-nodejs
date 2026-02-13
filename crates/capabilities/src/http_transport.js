const http = require('http');
const https = require('https');

module.exports.httpRequest = function (method, url, headersJson, body) {
  const headers = JSON.parse(headersJson || '{}');
  headers['Content-Length'] = body.length;
  const parsed = new URL(url);
  const transport = parsed.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            body: new Uint8Array(Buffer.concat(chunks)),
          });
        });
      }
    );
    req.on('error', reject);
    req.write(Buffer.from(body));
    req.end();
  });
};
