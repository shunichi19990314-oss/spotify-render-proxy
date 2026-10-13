const fs = require('fs');
const self = process.pid;
for (const d of fs.readdirSync('/proc')) {
  if (!/^\d+$/.test(d)) continue;
  const pid = Number(d);
  if (pid === self || pid === 1) continue;
  let cw = '';
  try { cw = fs.readlinkSync(`/proc/${d}/cwd`); } catch { continue; }
  if (!cw.includes('spotify-render-proxy')) continue;
  let cl = '';
  try { cl = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').replace(/\0/g, ' '); } catch { continue; }
  if (!/^node /.test(cl)) continue;
  if (/kill\.js|probe\.js/.test(cl)) continue;
  try { process.kill(pid, 'SIGKILL'); console.log('killed', pid, cl.trim()); } catch {}
}
