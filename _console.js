// One-off console runner (any server: SRV=<panelId>) via pterosocket (captures output). Read-only unless commands sent.
require('dotenv').config();
const fs = require('fs');
const { pterosocket } = require('pterosocket');
const HOST = require('./config/config.json').pterodactyl.pterodactylHostName.replace(/\/$/, '');
const KEY = process.env.PTERODACTYL_APIKEY;
const { sendCommand } = require('./modules/pterodactyl');
const ID = process.env.SRV || 'd1c9051f';

// commands: from --file <path> (one per line, skip # and blank) or remaining argv
let cmds = [];
const fi = process.argv.indexOf('--file');
if (fi !== -1) {
  cmds = fs.readFileSync(process.argv[fi + 1], 'utf8').split('\n')
           .map(l => l.trim()).filter(l => l && !l.startsWith('#'));
} else {
  cmds = process.argv.slice(2);
}
if (!cmds.length) { console.log('no commands'); process.exit(1); }

const strip = s => s.replace(/[][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
const socket = new pterosocket(HOST, KEY, ID);
let lastOut = Date.now();

socket.once('start', async () => {
  for (const c of cmds) {
    await sendCommand(ID, c.replace(/^\//, ''));   // console wants no leading slash
    await new Promise(r => setTimeout(r, 450));
  }
  lastOut = Date.now();
});
socket.on('console_output', (out) => {
  lastOut = Date.now();
  out = strip(out).trimEnd();
  // surface only interesting lines
  if (process.env.ALLOUT || /Gave |No player|Unknown|error|Cannot|too long|that name|data of type|players online|There are/i.test(out)) {
    const m = out.replace(/^\[\d\d:\d\d:\d\d\] \[[^\]]+\]: /, '');
    console.log('OUT:', m.slice(0, 200));
  }
});
socket.once('error', e => { console.log('SOCKERR', e.message); });

// exit once output settles (>3.5s since last line) and we've sent everything
const t = setInterval(() => {
  if (Date.now() - lastOut > 3500) { clearInterval(t); try { socket.close(); } catch {} process.exit(0); }
}, 800);
setTimeout(() => { try { socket.close(); } catch {} process.exit(0); }, 60000);
