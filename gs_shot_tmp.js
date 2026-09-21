// One-off screenshot harness: drives three REAL browser tabs (host + two
// players) through the actual UI (real clicks/typing, not injected state)
// so the screenshots reflect exactly what a person sees.
const puppeteer = require('/tmp/node_modules/puppeteer');

const URL = 'http://localhost:3000/gameshow.html';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function newTab(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 700 });
  await page.goto(URL, { waitUntil: 'networkidle0' });
  await sleep(400);
  return page;
}

async function main() {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const hostPage = await newTab(browser);
  const aPage = await newTab(browser);

  async function confirmAvatar(page) {
    const btn = await page.$('#gsConfirmAvatarBtn');
    if (btn) { await btn.click(); await sleep(300); }
  }

  // ---- SHOT 1: landing / pending games list ----
  // Host creates the room first so there's something pending for the 2nd tab.
  await hostPage.click('#gsCreateRoomBtn');
  await sleep(400);
  await confirmAvatar(hostPage);
  await sleep(300);
  await aPage.reload({ waitUntil: 'networkidle0' });
  await sleep(600);
  await aPage.screenshot({ path: '/tmp/gsbuild/shot1_pending.png' });

  // A joins that room via the pending list's Join button.
  const joinBtn = await aPage.$('[data-join-pending]');
  if (joinBtn) { await joinBtn.click(); await sleep(400); }
  await confirmAvatar(aPage);

  const bPage = await newTab(browser);
  const roomCode = await hostPage.$eval('.gs-screen-roomcode', el => el.textContent.trim()).catch(() => null);
  if (roomCode) {
    await bPage.type('#gsJoinCodeInput', roomCode);
    await bPage.click('#gsJoinRoomBtn');
    await sleep(400);
    await confirmAvatar(bPage);
  }

  // Host becomes host, A and B join teamA/teamB slot 0, both ready up.
  await hostPage.click('#gsOpenHostBoxBtn');
  await sleep(200);
  await hostPage.type('#gsHostPasswordInput', 'VANISVAN');
  await hostPage.click('#gsBecomeHostBtn');
  await sleep(400);

  await aPage.click('[data-join-team="teamA"][data-join-slot="0"]');
  await sleep(300);
  await bPage.click('[data-join-team="teamB"][data-join-slot="0"]');
  await sleep(300);
  await aPage.click('#gsReadyToggleBtn');
  await sleep(200);
  await bPage.click('#gsReadyToggleBtn');
  await sleep(400);

  await hostPage.click('#gsStartNamingBtn');
  await sleep(500);

  // ---- SHOT 2: naming screen (Team A player's view) ----
  await aPage.type(`#gsNameInput_teamA`, "Rean-o-beano");
  await sleep(200);
  await aPage.click('.gs-submit-name-btn[data-team="teamA"]');
  await sleep(400);
  await aPage.click('.gs-vote-btn[data-team="teamA"][data-idx="0"]');
  await sleep(400);
  await aPage.screenshot({ path: '/tmp/gsbuild/shot2_naming.png' });

  await bPage.type(`#gsNameInput_teamB`, "Ultra Violence");
  await sleep(200);
  await bPage.click('.gs-submit-name-btn[data-team="teamB"]');
  await sleep(400);
  await bPage.click('.gs-vote-btn[data-team="teamB"][data-idx="0"]');
  await sleep(400);

  await hostPage.click('#gsFinishNamingBtn');
  await sleep(400);
  await aPage.click('#gsReadyToggleBtn');
  await sleep(200);
  await bPage.click('#gsReadyToggleBtn');
  await sleep(400);
  await hostPage.click('#gsStartGameBtn');
  await sleep(600);

  // ---- SHOT 3: scoreboard during play ----
  await hostPage.screenshot({ path: '/tmp/gsbuild/shot3_scoreboard.png' });
  // Also grab a tight crop around just the scoreboard row for a close look
  // at the hint/phone icon ordering fix.
  const scoreboardEl = await hostPage.$('.gs-scoreboard');
  if (scoreboardEl) await scoreboardEl.screenshot({ path: '/tmp/gsbuild/shot3b_scoreboard_crop.png' });

  await browser.close();
  console.log('SHOTS DONE');
  process.exit(0);
}
main().catch(e => { console.error('SHOT ERROR:', e); process.exit(1); });
