#!/usr/bin/env node
require('dotenv').config();
const { sendCommand } = require('./modules/pterodactyl');
const ID = process.env.SRV || '5aa603c5';
const cmds = process.argv.slice(2);
(async () => {
  for (const c of cmds) {
    const r = await sendCommand(ID, c.replace(/^\//, ''));
    console.log('sent', c.slice(0, 80), r && r.status ? r.status : typeof r);
    await new Promise(r => setTimeout(r, 250));
  }
})().catch(e => { console.error(e); process.exit(1); });
