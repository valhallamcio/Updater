// Panel power action helper (ticket: AERO sable safety patch deploy, 2026-08-07).
// Usage: SRV=<8-char panel id> node _power.js restart|start|stop|kill
require('dotenv').config();
const { pterosocket } = require('pterosocket');
const HOST = require('./config/config.json').pterodactyl.pterodactylHostName.replace(/\/$/, '');
const KEY = process.env.PTERODACTYL_APIKEY;
const ID = process.env.SRV;
const action = process.argv[2];
if (!ID || !['restart','start','stop','kill'].includes(action)) { console.log('usage: SRV=<id> node _power.js <restart|start|stop|kill>'); process.exit(1); }
const socket = new pterosocket(HOST, KEY, ID);
socket.on('start', () => { console.log('connected, sending', action); socket.writePower(action); setTimeout(() => { socket.close(); process.exit(0); }, 2500); });
socket.on('error', (e) => { console.error('socket error', e.message || e); process.exit(1); });
socket.connect();
