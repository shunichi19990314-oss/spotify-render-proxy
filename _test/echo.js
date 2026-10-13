// 検証用ローカルサーバ群 (本番では使わない)
const http = require('http'), https = require('https'), net = require('net'), fs = require('fs');

http.createServer((req, res) => {
  const b = 'ECHO ' + req.method + ' ' + req.url + ' host=' + req.headers.host + '\n';
  res.writeHead(200, { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(b) });
  res.end(b);
}).listen(19090, '127.0.0.1', () => console.log('http echo  : 19090'));

net.createServer((s) => {
  s.on('data', (d) => s.write(Buffer.concat([Buffer.from('PONG:'), d])));
  s.on('error', () => {});
}).listen(19091, '127.0.0.1', () => console.log('tcp  echo  : 19091'));

try {
  const opt = { key: fs.readFileSync('/tmp/key.pem'), cert: fs.readFileSync('/tmp/cert.pem') };
  https.createServer(opt, (req, res) => {
    const b = 'TLS-ECHO ' + req.method + ' ' + req.url + ' host=' + req.headers.host + '\n';
    res.writeHead(200, { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(b) });
    res.end(b);
  }).listen(19443, '127.0.0.1', () => console.log('https echo : 19443'));
} catch (e) { console.log('https echo skipped:', e.message); }
