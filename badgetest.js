// The number on the home screen icon must go away when you reopen the portal.
//
// An app on the home screen is not reloaded when you reopen it - the phone hands the page back
// exactly as it was - so nothing in the start-up code runs and nothing clears the badge. This test
// stands in for that: it signs in, puts a number on the icon as a push would, then puts the page
// away and brings it back, and checks the number was cleared and the live feed came back up.
const S = __dirname;
const os = require('os');
process.env.DATA_DIR = os.tmpdir() + '/sb-badge-' + process.pid + '-' + Date.now();
process.env.SETUP_SECRET = 'a-long-secret-phrase';
delete process.env.DRIVE_SCRIPT_URL;
const { server, ready } = require('./server');
const { chromium } = require('playwright');
const notes = [];

(async () => {
  await ready; await new Promise((r) => server.listen(0, r));
  const base = 'http://127.0.0.1:' + server.address().port;

  const br = await chromium.launch();
  const ctx = await br.newContext({ viewport: { width: 390, height: 844 } });

  // Stand in for the phone's icon: record every set and clear, since headless Chromium has no
  // home screen of its own. This has to be in place before the portal's own scripts run.
  await ctx.addInitScript(() => {
    window.__badge = [];
    navigator.setAppBadge = function (n) { window.__badge.push('set ' + n); return Promise.resolve(); };
    navigator.clearAppBadge = function () { window.__badge.push('clear'); return Promise.resolve(); };
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => notes.push('script error: ' + e.message));

  await page.goto(base); await page.waitForTimeout(600);
  await page.click('text=Setting the portal up');
  await page.waitForTimeout(250);
  await page.fill('#ad_secret', 'a-long-secret-phrase');
  await page.fill('#ad_name', 'SV');
  await page.fill('#ad_phone', '9876543210');
  await page.fill('#ad_pin', '1234');
  await page.fill('#ad_pin2', '1234');
  await page.click('text=Set up the portal');
  await page.waitForTimeout(900);
  if (!/Hi, SV/.test(await page.evaluate(() => document.body.innerText))) {
    notes.push('could not get into the portal to test the badge');
  }

  // ---- a push lands while the portal is away ----
  await page.evaluate(() => {
    window.__badge = [];
    navigator.setAppBadge(1);                       // what the service worker does
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(200);
  let seen = await page.evaluate(() => window.__badge.slice());
  if (seen.filter((x) => x === 'clear').length) notes.push('the number was cleared while the portal was put away');

  // ---- and now it is reopened, with no reload, exactly as a phone does it ----
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(900);
  seen = await page.evaluate(() => window.__badge.slice());
  if (!seen.includes('clear')) notes.push('reopening the portal left the number on the icon: ' + JSON.stringify(seen));

  // the live feed does not survive being put away, so coming back must bring it up again
  const live = await page.evaluate(() => !!(window.feed || (typeof feed !== 'undefined' && feed)) && feed.readyState !== 2);
  if (!live) notes.push('the live feed was not back up after reopening, so a table would sit frozen');

  // ---- tapping the icon from cold still clears it ----
  await page.evaluate(() => { window.__badge = []; navigator.setAppBadge(3); });
  await page.reload(); await page.waitForTimeout(1000);
  seen = await page.evaluate(() => window.__badge.slice());
  if (!seen.includes('clear')) notes.push('opening the portal afresh left the number on the icon: ' + JSON.stringify(seen));

  await br.close(); server.close();
  console.log(notes.length ? 'BADGE NOTES:\n- ' + notes.join('\n- ')
    : 'the icon number clears: on reopening without a reload, and on a cold start - and the live feed comes back with it');
  process.exit(notes.length ? 3 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
