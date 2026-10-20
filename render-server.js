// render-server.js — يشغّل pump-tracker.js ويفتح صفحة حالة (Render يتطلب منفذاً مفتوحاً)
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');

function startTracker() {
  const child = spawn('node', ['pump-tracker.js'], { stdio: 'inherit' });
  child.on('exit', (code) => {
    console.log('tracker exited with code', code, '- restarting in 5s');
    setTimeout(startTracker, 5000);
  });
}
startTracker();

const tail = (f, n) => {
  try { return fs.readFileSync(f, 'utf8').trim().split('\n').slice(-n).join('\n'); } catch (_) { return '(لا شيء بعد)'; }
};

http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(
    'tracker running\n' + new Date().toISOString() +
    '\n\n== آخر الإشارات ==\n' + tail('signals.jsonl', 20) +
    '\n\n== آخر النتائج ==\n' + tail('results.jsonl', 30) + '\n'
  );
}).listen(process.env.PORT || 3000, () => console.log('status page up'));
