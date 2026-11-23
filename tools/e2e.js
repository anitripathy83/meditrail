// End-to-end test of the real website: a local chain (Ganache, same chain ID as Base Sepolia),
// headless Chrome and a tiny stand-in for MetaMask. Runs the full demo story, including refusals,
// and saves screenshots to shots/.
//
// Run: npm install && npm run compile && npm run e2e   (set CHROME_PATH if Chrome is elsewhere)
const ganache = require('ganache'); const http = require('http'); const fs = require('fs'); const path = require('path');
const { chromium } = require('playwright-core'); const { ethers } = require('ethers');

const WEB = path.join(__dirname, '../web');
const SHOTS = path.join(__dirname, '../shots');
const URL = 'http://127.0.0.1:8080/';
fs.mkdirSync(SHOTS, { recursive: true });

let failures = 0;
function expect(label, text, needle) {
  const ok = text.includes(needle);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${text}`);
}

(async () => {
  const server = ganache.server({ chain: { chainId: 84532 }, logging: { quiet: true }, wallet: { totalAccounts: 8 } });
  await server.listen(8545);
  const rpc = new ethers.JsonRpcProvider('http://127.0.0.1:8545');
  const [admin, maker, dist, pharm, , stranger] = await rpc.send('eth_accounts', []);
  const build = require('../build.json');
  const c = await new ethers.ContractFactory(build.abi, build.bytecode, await rpc.getSigner(admin)).deploy();
  await c.waitForDeployment();
  const addr = await c.getAddress();
  const year = Math.floor(Date.now() / 1000) + 365 * 86400;
  await (await c.setMember(maker, 1, 'Gulf Pharma Labs (demo)', year)).wait();
  await (await c.setMember(dist, 2, 'Desert Logistics (demo)', year)).wait();

  // Static server; the page gets the local contract through ?contract= and a local config.
  const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html' };
  const web = http.createServer((q, s) => {
    const p = q.url.split('?')[0].split('#')[0];
    try {
      const body = p === '/config.js'
        ? `export const CONFIG = { contractAddress: "${addr}", chainId: 84532, chainIdHex: "0x14a34", chainName: "Local test", rpcUrl: "http://127.0.0.1:8545", explorer: "https://sepolia.basescan.org" };`
        : fs.readFileSync(path.join(WEB, p === '/' ? 'index.html' : p));
      s.writeHead(200, { 'content-type': types[path.extname(p)] || 'text/html' }); s.end(body);
    } catch { s.writeHead(404); s.end(); }
  }).listen(8080);

  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const errors = [];
  async function page(as, viewport = { width: 1100, height: 1400 }) {
    const ctx = await browser.newContext({ viewport });
    const pg = await ctx.newPage();
    pg.on('pageerror', (e) => errors.push(e.message));
    pg.on('console', (m) => m.type() === 'error' && !/favicon/.test(m.text()) && errors.push(m.text()));
    if (as) await pg.addInitScript((from) => {
      window.ethereum = { on() {}, async request({ method, params }) {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [from];
        if (method === 'wallet_switchEthereumChain') return null;
        if (method === 'eth_sendTransaction') params = [{ ...params[0], from }];
        const r = await fetch('http://127.0.0.1:8545', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }).then((x) => x.json());
        if (r.error) { const e = new Error(r.error.message); e.code = r.error.code; e.data = r.error.data; throw e; }
        return r.result;
      } };
    }, as);
    await pg.goto(URL);
    return pg;
  }
  const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
  async function result(pg, sel) {
    await pg.waitForFunction((s) => { const el = document.querySelector(s); return el && el.querySelector('.msg') && !el.querySelector('.msg.wait'); }, sel, { timeout: 20000 });
    return clean(await pg.textContent(sel));
  }
  async function act(pg, button, sel) {
    await pg.$eval(sel, (el) => (el.innerHTML = ''));
    await pg.click(button);
    return result(pg, sel);
  }
  async function asCompany(pg, tab = 'company') {
    await pg.click(`.tab[data-view=${tab}]`);
    if (await pg.$(`#view-${tab} [data-connect]`)) await pg.click(`#view-${tab} [data-connect]`);
    await pg.waitForSelector(`#view-${tab} .wallet-box .pill`);
  }
  async function check(pg, id) {
    await pg.click('.tab[data-view=check]');
    await pg.$eval('#check-result', (el) => (el.innerHTML = ''));
    await pg.fill('#check-id', id); await pg.click('#check-form button');
    await pg.waitForSelector('#check-result .verdict, #check-result .msg.err', { timeout: 20000 });
    await pg.waitForTimeout(300);
    if (!(await pg.$('#check-result .verdict'))) return clean(await pg.textContent('#check-result'));
    return clean(await pg.textContent('#check-result .verdict'));
  }

  // ---- 1. Regulator: a non-admin is refused; the admin approves the pharmacy and the sensor
  const pd = await page(dist);                       // distributor, also plays the carrier relaying sensor readings
  await pd.click('.tab[data-view=sensor]');
  const sensorAddr = clean(await pd.textContent('#sensor-addr'));
  await asCompany(pd, 'admin');
  await pd.fill('#member-wallet', pharm); await pd.fill('#member-name', 'Fake Pharmacy');
  await pd.selectOption('#member-role', '3');   expect('non-admin approves a pharmacy (refused)', await act(pd, '#member-form button', '#member-msg'), 'Only the regulator can approve companies');

  const pa = await page(admin);
  await asCompany(pa, 'admin');
  await pa.fill('#member-wallet', pharm); await pa.fill('#member-name', 'Al Noor Pharmacy (demo)');
  await pa.selectOption('#member-role', '3');   expect('regulator approves pharmacy', await act(pa, '#member-form button', '#member-msg'), 'approved as Pharmacy');
  await pa.fill('#member-wallet', sensorAddr); await pa.fill('#member-name', 'Cold box sensor #1 (demo)');
  await pa.selectOption('#member-role', '4');   expect('regulator approves sensor', await act(pa, '#member-form button', '#member-msg'), 'approved as Sensor');

  // ---- 2. Manufacturer registers three boxes with a certificate
  const cert = { name: 'certificate-B-2611.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 demo lab certificate for batch B-2611, insulin glargine, passed') };
  const pm = await page(maker);
  await asCompany(pm);
  await pm.waitForFunction(() => document.querySelector('#reg-sensor option')?.value?.startsWith('0x'));
  for (const [id, batch] of [['ins-0001', 'B-2611'], ['INS-0002', 'B-2611'], ['INS-0003', 'B-2700']]) {
    await pm.fill('#reg-id', id); await pm.fill('#reg-batch', batch);
    await pm.setInputFiles('#reg-cert', cert);
        expect(`register ${id}`, await act(pm, '#reg-form button[type=submit]', '#reg-msg'), 'registered');
  }
  await pm.waitForSelector('#reg-qr img');
  await pm.fill('#reg-id', 'INS-0001');   expect('register a duplicate (refused)', await act(pm, '#reg-form button[type=submit]', '#reg-msg'), 'This box ID already exists');

  // ---- 3. Out-of-order handover is refused; then the right one, with a seal code
  async function offer(pg, id, toName) {
    await pg.fill('#offer-id', id);
    const value = await pg.$eval('#offer-to', (s, n) => [...s.options].find((o) => o.textContent.includes(n))?.value, toName);
    await pg.selectOption('#offer-to', value);
    await pg.$eval('#offer-seal', (el) => (el.innerHTML = ''));
    const msg = await act(pg, '#offer-form button', '#offer-msg');
    const code = (await pg.$('#seal-code')) ? clean(await pg.textContent('#seal-code')) : null;
    return { msg, code };
  }
  let r = await offer(pm, 'INS-0001', 'Al Noor Pharmacy');
  expect('manufacturer offers straight to pharmacy (refused)', r.msg, 'Out of order: a box must go to a distributor next');
  r = await offer(pm, 'INS-0001', 'Desert Logistics');
  expect('manufacturer offers to distributor', r.msg, 'offered to Desert Logistics');
  const seal1 = r.code;
  console.log('      seal code shown:', seal1);
  await pm.screenshot({ path: path.join(SHOTS, 'company-seal.png'), fullPage: true });

  // ---- 4. Wrong wallet and wrong code are refused; right code accepted
  const pp = await page(pharm);
  await asCompany(pp);
  async function accept(pg, id, code) {
    await pg.fill('#accept-id', id); await pg.fill('#accept-code', code);
    return act(pg, '#accept-form button[type=submit]', '#accept-msg');
  }
  expect('pharmacy accepts a box offered to the distributor (refused)', await accept(pp, 'INS-0001', seal1), 'This box was not offered to you');
  await asCompany(pd);
  expect('distributor types a wrong seal code (refused)', await accept(pd, 'INS-0001', 'AAAA-BBBB'), 'Seal code does not match');
  await pd.screenshot({ path: path.join(SHOTS, 'refusal-seal.png'), fullPage: true });
  expect('distributor accepts with the right code', await accept(pd, 'INS-0001', seal1.toLowerCase()), 'You received INS-0001');

  // ---- 5. Sensor-signed readings
  async function reading(pg, id, t) {
    await pg.click('.tab[data-view=sensor]');
    await pg.fill('#sensor-box', id); await pg.fill('#sensor-temp', String(t));
    return act(pg, '#sensor-form button[type=submit]', '#sensor-msg');
  }
  expect('sensor reading 4.6 C', await reading(pd, 'INS-0001', 4.6), 'Reading 4.6 °C recorded');
  expect('sensor reading 6.1 C', await reading(pd, 'INS-0001', 6.1), 'Inside the safe range');
  expect('sensor reading 3.3 C', await reading(pd, 'INS-0001', 3.3), 'recorded');

  // ---- 6. Distributor -> pharmacy, then sell, then sell again
  await pd.click('.tab[data-view=company]');
  r = await offer(pd, 'INS-0001', 'Al Noor Pharmacy');
  expect('distributor offers to pharmacy', r.msg, 'offered to Al Noor Pharmacy');
  expect('pharmacy accepts', await accept(pp, 'INS-0001', r.code), 'You received INS-0001');

  const pub = await page(null, { width: 390, height: 1600 });
  expect('public check before sale', await check(pub, 'ins-0001'), 'Genuine and safe');
  await pub.setInputFiles('#cert-file', cert);
  expect('certificate: original', await result(pub, '#cert-msg'), "Matches the manufacturer's original");
  await pub.screenshot({ path: path.join(SHOTS, 'check-genuine-phone.png'), fullPage: true });
  await pub.$eval('#cert-msg', (el) => (el.innerHTML = ''));
  await pub.setInputFiles('#cert-file', { ...cert, buffer: Buffer.from('%PDF-1.4 demo lab certificate for batch B-2611, insulin glargine, FAILED') });
  expect('certificate: edited copy', await result(pub, '#cert-msg'), 'Does not match');

  await pp.fill('#sell-id', 'INS-0001');   expect('pharmacy sells', await act(pp, '#sell-form button', '#sell-msg'), 'INS-0001 sold');
    expect('pharmacy sells the same code again (refused)', await act(pp, '#sell-form button', '#sell-msg'), 'This box was already sold');
  expect('public check after sale', await check(pub, 'INS-0001'), 'Already sold once');
  await pub.screenshot({ path: path.join(SHOTS, 'check-sold-phone.png'), fullPage: true });

  // ---- 7. Heat breach locks INS-0002
  r = await offer(pm, 'INS-0002', 'Desert Logistics');
  await pd.click('.tab[data-view=company]');
  expect('distributor accepts INS-0002', await accept(pd, 'INS-0002', r.code), 'You received INS-0002');
  expect('sensor reading 11.2 C', await reading(pd, 'INS-0002', 11.2), 'the box is now blocked');
  await pd.click('.tab[data-view=company]');
  r = await offer(pd, 'INS-0002', 'Al Noor Pharmacy');
  expect('hand over a heat-damaged box (refused)', r.msg, 'This box had a temperature breach and is blocked');
  expect('public check of heat-damaged box', await check(pub, 'INS-0002'), 'Do not use: temperature breach');
  await pub.screenshot({ path: path.join(SHOTS, 'check-breach-phone.png'), fullPage: true });

  // ---- 8. Forged reading: a stranger's key cannot sign for the box
  const forged = new ethers.Wallet(ethers.Wallet.createRandom().privateKey);
  const t0 = Math.floor(Date.now() / 1000) + 5;
  const inner = await c.readingHash('INS-0002', 40, t0);
  try { await c.submitReading.staticCall('INS-0002', 40, t0, await forged.signMessage(ethers.getBytes(inner))); expect('forged reading', 'accepted', 'refused'); }
  catch (e) { expect('forged sensor reading (refused)', e.reason || e.message, "Reading not signed by this box's sensor"); }

  // ---- 9. Batch recall by the manufacturer
  await pm.click('details.card summary');
  await pm.fill('#recall-batch', 'b-2700'); await pm.fill('#recall-reason', 'Failed lab retest (demo)');
    expect('manufacturer recalls batch B-2700', await act(pm, '#recall-form button', '#recall-msg'), 'Batch B-2700 recalled');
  expect('public check of recalled box', await check(pub, 'INS-0003'), 'Recalled: do not use');
  expect('public check of fake code', await check(pub, 'FAKE-0000'), 'Unknown code');

  // ---- 10. Correction and screenshots of the lists
  await pd.click('.tab[data-view=company]');
  await pd.click('details.card summary');
  await pd.fill('#corr-id', 'INS-0001'); await pd.fill('#corr-note', 'Truck was DXB-21, not DXB-12 (demo)');
    expect('distributor adds a correction', await act(pd, '#corr-form button', '#corr-msg'), 'Correction added');
  await pd.screenshot({ path: path.join(SHOTS, 'company.png'), fullPage: true });
  await pa.click('.tab[data-view=admin]'); await pa.waitForSelector('#box-list table'); await pa.waitForTimeout(500);
  await pa.screenshot({ path: path.join(SHOTS, 'regulator.png'), fullPage: true });
  const desk = await page(null);
  await check(desk, 'INS-0001'); await desk.waitForTimeout(500);
  await desk.screenshot({ path: path.join(SHOTS, 'check-desktop.png'), fullPage: true });

  console.log(`\n${failures ? `${failures} FAILED` : 'All steps passed'} · page errors: ${errors.length ? errors.join(' | ') : 'none'}`);
  await browser.close(); web.close(); await server.close();
  process.exit(failures || errors.length ? 1 : 0);
})().catch((e) => { console.error('E2E FAILED', e); process.exit(1); });
