const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { chromium } = require('playwright');

const ADMIN_URL = process.env.ADMIN_URL || 'https://admin.questionhut.com';
const USERNAME = process.env.ADMIN_USERNAME;
const PASSWORD = process.env.ADMIN_PASSWORD;

const app = express();
app.use(express.json({ limit: '5mb' }));

let browserPromise = null;
let pagePromise = null;
let queue = Promise.resolve();

function withLock(fn) {
  const result = queue.then(fn, fn);
  queue = result.then(() => {}, () => {});
  return result;
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
  }
  return browserPromise;
}

async function getPage() {
  if (!pagePromise) {
    pagePromise = (async () => {
      const browser = await getBrowser();
      const context = await browser.newContext({
        viewport: { width: 1600, height: 1000 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
        acceptDownloads: true,
      });
      const page = await context.newPage();
      page.on('console', (msg) => console.log('[page console]', msg.type(), msg.text()));
      page.on('requestfailed', (req) => console.log('[request failed]', req.url(), req.failure()?.errorText));
      page.on('response', (res) => {
        if (res.status() >= 400) console.log('[response error]', res.status(), res.url());
      });
      return page;
    })();
  }
  return pagePromise;
}

async function fillFirstMatch(page, selectors, value) {
  for (const sel of selectors) {
    const locator = page.locator(sel).first();
    try {
      if (await locator.isVisible({ timeout: 2000 })) {
        await locator.fill(value);
        return true;
      }
    } catch (_) {}
  }
  return false;
}

async function clickFirstMatch(page, selectors) {
  for (const sel of selectors) {
    const locator = page.locator(sel).first();
    try {
      if (await locator.isVisible({ timeout: 2000 })) {
        await locator.click();
        return true;
      }
    } catch (_) {}
  }
  return false;
}

let sessionEstablished = false;
let sessionEstablishedAt = 0;

// Keycloak's SSO session outlives our idea of "logged in", but not by much, and a
// session that expires mid-run costs a whole post. Refresh well before that.
const SESSION_MAX_AGE_MS = 25 * 60 * 1000;

const KEYCLOAK_BUTTON = 'button:has-text("Login with Keycloak"), a:has-text("Login with Keycloak")';

async function login(page) {
  // A stale Keycloak SSO cookie makes Keycloak skip its login form and bounce
  // straight back, so the username field never appears; start from a clean slate.
  await page.context().clearCookies();
  await page.goto(`${ADMIN_URL}/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }).catch(() => {});
  // The SPA booted with the old token still in storage, so reload to make it
  // render the real login screen rather than a half-authenticated dashboard.
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

  // On a cold container the button can take several seconds to paint, and a live
  // SSO session skips it entirely. Wait for whichever happens first instead of
  // assuming the button is already there.
  await Promise.race([
    page.waitForSelector(KEYCLOAK_BUTTON, { state: 'visible', timeout: 25000 }),
    page.waitForURL(/keycloak\.questionhut\.com/, { timeout: 25000 }),
  ]).catch(() => {});

  if (!page.url().includes('keycloak.questionhut.com')) {
    let clicked = await clickFirstMatch(page, [KEYCLOAK_BUTTON, 'text=Login with Keycloak']);
    if (!clicked) {
      // One reload covers a half-rendered SPA; only then is it a real failure.
      console.log('[login] Keycloak button missing, reloading once');
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await page.waitForSelector(KEYCLOAK_BUTTON, { state: 'visible', timeout: 20000 }).catch(() => {});
      clicked = await clickFirstMatch(page, [KEYCLOAK_BUTTON, 'text=Login with Keycloak']);
    }
    if (!clicked && !page.url().includes('keycloak.questionhut.com')) {
      throw new Error(`Could not find "Login with Keycloak" button (url: ${page.url()})`);
    }
  }

  await page.waitForURL(/keycloak\.questionhut\.com/, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1000);

  const onKeycloak = () => page.url().includes('keycloak.questionhut.com');
  if (onKeycloak()) {
    const filledUser = await fillFirstMatch(page, ['#username', 'input[name="username"]', 'input[type="email"]', 'input[type="text"]'], USERNAME);
    if (filledUser) {
      const filledPass = await fillFirstMatch(page, ['#password', 'input[name="password"]', 'input[type="password"]'], PASSWORD);
      if (!filledPass) throw new Error('Could not find password field on Keycloak login page');

      const submitted = await clickFirstMatch(page, ['#kc-login', 'button[type="submit"]', 'input[type="submit"]']);
      if (!submitted) throw new Error('Could not find login submit button on Keycloak login page');
    } else if (onKeycloak()) {
      throw new Error('Could not find username field on Keycloak login page');
    }
    // else: Keycloak auto-redirected back mid-check (live SSO session) — already authenticated.
  }

  await page.waitForURL(new RegExp(ADMIN_URL.replace(/https?:\/\//, '').replace(/\./g, '\\.')), { timeout: 20000 });

  const gotToken = await page.waitForFunction(
    () => !!localStorage.getItem('access_token'),
    { timeout: 20000 }
  ).catch(() => null);
  if (!gotToken) {
    throw new Error('Timed out waiting for access_token to appear in localStorage after Keycloak redirect — token exchange may have failed');
  }
  await page.waitForTimeout(500);

  console.log('[login] token acquired, localStorage keys:', await page.evaluate(() => Object.keys(localStorage)).catch(() => 'eval-failed'));
}

async function ensureLoggedIn(page, { force = false } = {}) {
  const stale = Date.now() - sessionEstablishedAt > SESSION_MAX_AGE_MS;
  if (force || !sessionEstablished || stale) {
    if (stale && sessionEstablished) console.log('[auth] session past max age, refreshing proactively');
    // login() clears cookies + localStorage first, so every one of these is a
    // genuinely clean sign-in rather than a reuse of the stale SSO cookie.
    await login(page);
    sessionEstablished = true;
    sessionEstablishedAt = Date.now();
  }
}

function isAuthPage(url) {
  return url.includes('/login') || url.includes('keycloak.questionhut.com');
}

const MAX_CARD_ATTEMPTS = 3;

// CC-BY instrumental bed for the YouTube card videos, kept separate from the
// reel pack so the two channels can have different moods.
const DESI_MUSIC_DIR = process.env.DESI_MUSIC_DIR || '/app/music-desi';
// Music is the only audio in these clips, so it sits near YouTube's -14 LUFS
// playback target rather than ducked under a voiceover.
const MUSIC_LUFS = Number(process.env.YT_MUSIC_LUFS || -16);

const CARD_TYPE_LABELS = { mcq: 'MCQ', info: 'Info', ppt: 'PPT' };
const OUTPUT_SIZE_LABELS = {
  '1:1': '1:1 Post',
  '4:5': '4:5 Feed',
  story: 'Story',
  link: 'Link Preview',
  ppt: 'PPT Slide',
};

async function fillMcq(page, fields) {
  await clickFirstMatch(page, ['button:text-is("Single")']);
  await page.waitForTimeout(300);
  await fillFirstMatch(page, ['label:text-is("Question Text") + * textarea', 'textarea'], fields.question || '');
  const options = fields.options || [];
  const optionLabels = ['ক) Option', 'খ) Option', 'গ) Option', 'ঘ) Option'];
  for (let i = 0; i < 4; i++) {
    await fillFirstMatch(page, [`label:has-text("${optionLabels[i]}") ~ input`, `label:has-text("${optionLabels[i]}") + input`], options[i] || '');
  }
  if (fields.footer) {
    await fillFirstMatch(page, ['label:has-text("Footer") ~ input', 'label:has-text("Footer") + input'], fields.footer);
  }
}

async function fillInfo(page, fields) {
  await fillFirstMatch(page, ['label:has-text("Card Title") ~ input', 'label:has-text("Card Title") + input'], fields.title || '');
  await fillFirstMatch(page, ['label:has-text("Info Content") ~ textarea', 'label:has-text("Info Content") + textarea'], fields.content || '');
  if (fields.footer) {
    await fillFirstMatch(page, ['label:has-text("Footer Note") ~ input', 'label:has-text("Footer Note") + input'], fields.footer);
  }
}

async function fillPpt(page, fields) {
  await fillFirstMatch(page, ['label:has-text("Slide Title") ~ input', 'label:has-text("Slide Title") + input'], fields.title || '');
  await fillFirstMatch(page, ['label:has-text("Subtitle") ~ input', 'label:has-text("Subtitle") + input'], fields.subtitle || '');
  const bullets = Array.isArray(fields.bullets) ? fields.bullets.join('\n') : (fields.bullets || '');
  await fillFirstMatch(page, ['label:has-text("Bullet Points") ~ textarea', 'label:has-text("Bullet Points") + textarea'], bullets);
  if (fields.source) {
    await fillFirstMatch(page, ['label:has-text("Source") ~ input', 'label:has-text("Source") + input'], fields.source);
  }
}

const CARD_TYPE_BUTTONS = Object.values(CARD_TYPE_LABELS)
  .map((l) => `button:text-is("${l}")`)
  .join(', ');

async function openCardCreator(page) {
  await page.goto(`${ADMIN_URL}/content-create`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1200);
  console.log('[generateCard] navigated, url:', page.url());
  if (isAuthPage(page.url())) {
    throw new Error(`Bounced to auth page after opening content-create (${page.url()})`);
  }
  // Waiting on the "Card Creator" heading races the bounce: the SPA paints its
  // shell, including that heading, and only then redirects to /login. The Card
  // Type buttons render only once auth actually held, so wait for those instead.
  await page.waitForSelector(CARD_TYPE_BUTTONS, { state: 'visible', timeout: 20000 });
  if (isAuthPage(page.url())) {
    throw new Error(`Bounced to auth page while loading card creator (${page.url()})`);
  }
}

async function generateCardOnce(page, { cardType, outputSize, fields }) {
  await openCardCreator(page);
  await page.waitForTimeout(500);

  const typeLabel = CARD_TYPE_LABELS[cardType];
  if (!typeLabel) throw new Error(`Unknown cardType: ${cardType}`);
  const clickedType = await clickFirstMatch(page, [`button:text-is("${typeLabel}")`]);
  if (!clickedType) throw new Error(`Could not find Card Type button for "${typeLabel}" (url: ${page.url()})`);
  await page.waitForTimeout(400);

  if (cardType === 'mcq') await fillMcq(page, fields);
  else if (cardType === 'info') await fillInfo(page, fields);
  else if (cardType === 'ppt') await fillPpt(page, fields);

  if (outputSize && OUTPUT_SIZE_LABELS[outputSize]) {
    await clickFirstMatch(page, [`button:has-text("${OUTPUT_SIZE_LABELS[outputSize]}")`]);
    await page.waitForTimeout(300);
  }

  await page.waitForTimeout(800);

  const downloadPromise = page.waitForEvent('download', { timeout: 20000 });
  const clickedDownload = await clickFirstMatch(page, ['button:has-text("Download")']);
  if (!clickedDownload) throw new Error('Could not find Download button');
  const download = await downloadPromise;
  const downloadPath = await download.path();
  if (!downloadPath) throw new Error('Download did not produce a local file path');
  return fs.readFileSync(downloadPath);
}

async function generateCard(args) {
  return withLock(async () => {
    const page = await getPage();
    let lastErr;
    for (let attempt = 1; attempt <= MAX_CARD_ATTEMPTS; attempt++) {
      try {
        // attempt > 1 forces a full clean sign-in: cookies and localStorage are
        // cleared inside login(), so a wedged or expired session cannot survive
        // into the retry.
        await ensureLoggedIn(page, { force: attempt > 1 });
        return await generateCardOnce(page, args);
      } catch (err) {
        lastErr = err;
        let url = '';
        try { url = page.url(); } catch (_) {}
        console.log(`[generateCard] attempt ${attempt}/${MAX_CARD_ATTEMPTS} failed: ${err.message} (url: ${url})`);
        sessionEstablished = false;
        if (attempt < MAX_CARD_ATTEMPTS) await page.waitForTimeout(1500);
      }
    }
    throw lastErr;
  });
}

app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/generate-card', async (req, res) => {
  const { cardType, outputSize, ...fields } = req.body || {};
  if (!cardType) return res.status(400).json({ error: 'cardType is required (mcq|info|ppt)' });
  try {
    const pngBuffer = await generateCard({ cardType, outputSize, fields });
    res.setHeader('Content-Type', 'image/png');
    res.send(pngBuffer);
  } catch (err) {
    let debugUrl = null;
    try {
      const page = await pagePromise;
      if (page) {
        debugUrl = page.url();
        await page.screenshot({ path: '/tmp/debug.png' }).catch(() => {});
      }
    } catch (_) {}
    res.status(500).json({ error: err.message, debugUrl });
  }
});

app.get('/debug-screenshot', (req, res) => res.sendFile('/tmp/debug.png'));

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Standalone Islamic dua card — rendered here rather than via the Questionhut
// admin panel, which stamps its own branding on every card.
function duaCardHtml({ title, arabic, translit, meaning, source, brand }) {
  // Long Arabic lines need a smaller face to stay on two lines at 1080px.
  const arabicSize = arabic.length > 90 ? 46 : arabic.length > 55 ? 56 : 68;
  const meaningSize = meaning.length > 160 ? 30 : 34;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { width:1080px; height:1080px; font-family:'Noto Sans Bengali','Lohit Bengali',sans-serif;
         background:radial-gradient(ellipse at 50% 28%, #1b6b4f 0%, #0e4a36 45%, #06301f 100%);
         color:#f7f3e8; display:flex; align-items:center; justify-content:center; }
  .frame { width:1000px; height:1000px; border:3px solid #d4af62; border-radius:22px; position:relative;
           padding:56px 60px; display:flex; flex-direction:column; align-items:center; }
  .frame:before { content:''; position:absolute; inset:12px; border:1px solid rgba(212,175,98,.42); border-radius:14px; }
  .corner { position:absolute; width:54px; height:54px; border:2px solid #d4af62; opacity:.75; }
  .c1 { top:26px; left:26px; border-right:0; border-bottom:0; border-radius:12px 0 0 0; }
  .c2 { top:26px; right:26px; border-left:0; border-bottom:0; border-radius:0 12px 0 0; }
  .c3 { bottom:26px; left:26px; border-right:0; border-top:0; border-radius:0 0 0 12px; }
  .c4 { bottom:26px; right:26px; border-left:0; border-top:0; border-radius:0 0 12px 0; }
  .brand { font-size:22px; letter-spacing:2px; color:#d4af62; font-weight:700; margin-bottom:6px; }
  .star { color:#d4af62; font-size:26px; letter-spacing:12px; margin-bottom:16px; }
  .title { font-size:44px; font-weight:700; color:#ffd98a; text-align:center; line-height:1.35; margin-bottom:26px; }
  .rule { width:220px; height:2px; background:linear-gradient(90deg,transparent,#d4af62,transparent); margin-bottom:30px; }
  .arabic { font-family:'Amiri','Noto Naskh Arabic',serif; direction:rtl; font-size:${arabicSize}px; line-height:1.95;
            text-align:center; color:#ffffff; margin-bottom:34px; text-shadow:0 2px 14px rgba(0,0,0,.35); }
  .translit { font-size:30px; font-style:italic; color:#cfe8db; text-align:center; line-height:1.6; margin-bottom:26px; }
  .meaning-box { background:rgba(255,255,255,.07); border:1px solid rgba(212,175,98,.35); border-radius:16px;
                 padding:26px 30px; width:100%; }
  .meaning-label { font-size:22px; color:#d4af62; font-weight:700; margin-bottom:10px; }
  .meaning { font-size:${meaningSize}px; line-height:1.65; color:#f4efe2; }
  .spacer { flex:1; }
  .source { font-size:25px; color:#0e4a36; background:#d4af62; border-radius:999px; padding:12px 34px; font-weight:700; }
  </style></head><body>
  <div class="frame">
    <div class="corner c1"></div><div class="corner c2"></div><div class="corner c3"></div><div class="corner c4"></div>
    <div class="brand">${esc(brand)}</div>
    <div class="star">✦ ✦ ✦</div>
    <div class="title">${esc(title)}</div>
    <div class="rule"></div>
    <div class="arabic">${esc(arabic)}</div>
    <div class="translit">${esc(translit)}</div>
    <div class="meaning-box">
      <div class="meaning-label">অর্থ</div>
      <div class="meaning">${esc(meaning)}</div>
    </div>
    <div class="spacer"></div>
    <div class="source">📖 ${esc(source)}</div>
  </div></body></html>`;
}

app.post('/dua-card', async (req, res) => {
  const { title, arabic, translit, meaning, source, brand } = req.body || {};
  if (!arabic || !meaning) return res.status(400).json({ error: 'arabic and meaning are required' });
  try {
    const png = await withLock(async () => {
      const browser = await getBrowser();
      const page = await browser.newPage({ viewport: { width: 1080, height: 1080 }, deviceScaleFactor: 1 });
      try {
        await page.setContent(
          duaCardHtml({
            title: title || 'দোয়া',
            arabic,
            translit: translit || '',
            meaning,
            source: source || '',
            brand: brand || 'কোন বিপদে কোন দোয়া',
          }),
          { waitUntil: 'load' }
        );
        await page.waitForTimeout(400);
        return await page.screenshot({ type: 'png' });
      } finally {
        await page.close().catch(() => {});
      }
    });
    res.setHeader('Content-Type', 'image/png');
    res.send(png);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PNG in (raw body) -> MP4 out: slow zoom "Ken Burns" clip for YouTube, scored
// with a CC-BY instrumental bed. The chosen track is echoed back in the
// X-Music-Credit header so the caller can put the required attribution in the
// video description.
app.post('/make-video', express.raw({ type: ['image/png', 'application/octet-stream'], limit: '25mb' }), async (req, res) => {
  if (!req.body || !req.body.length) return res.status(400).json({ error: 'raw PNG body required' });
  const duration = Math.min(Math.max(parseInt(req.query.duration, 10) || 9, 3), 60);
  const fps = 25;
  const frames = duration * fps;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vid-'));
  const inPath = path.join(dir, 'in.png');
  const outPath = path.join(dir, 'out.mp4');
  fs.writeFileSync(inPath, req.body);

  try {
    const wantMusic = req.query.music !== '0';
    const track = wantMusic ? pickMusic(DESI_MUSIC_DIR) : null;

    // Start a few seconds in: track intros are often near-silent, which would
    // leave a short clip with no audible music at all.
    let seek = 0;
    if (track) {
      const total = await probeDuration(track).catch(() => 0);
      const room = total - duration - 2;
      if (room > 4) seek = 4 + Math.random() * Math.min(room - 4, 60);
    }

    const video = `[0:v]scale=4320:-1,zoompan=z='min(zoom+0.0006,1.15)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=1080x1080:fps=${fps}[v]`;
    const args = ['-y', '-loop', '1', '-i', inPath];
    if (track) args.push('-ss', seek.toFixed(2), '-i', track);

    if (track) {
      // Levels across the pack vary wildly, so normalise to a fixed loudness
      // rather than scaling by a fixed factor.
      const fadeOut = Math.max(duration - 1.5, 0.1);
      args.push('-filter_complex',
        `${video};[1:a]loudnorm=I=${MUSIC_LUFS}:TP=-2:LRA=11,afade=t=in:st=0:d=1.2,afade=t=out:st=${fadeOut.toFixed(2)}:d=1.5[a]`,
        '-map', '[v]', '-map', '[a]', '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '44100');
    } else {
      args.push('-filter_complex', video, '-map', '[v]');
    }
    args.push('-t', String(duration), '-c:v', 'libx264', '-preset', 'veryfast',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outPath);

    await run('ffmpeg', args, { timeout: 180000 });

    const credit = musicCredit(track);
    if (credit) {
      res.setHeader('X-Music-Credit', credit.ascii);
      res.setHeader('X-Music-Credit-B64', Buffer.from(credit.line, 'utf8').toString('base64'));
      res.setHeader('X-Music-Track', credit.file);
      console.log('[make-video] music:', credit.line, `(seek ${seek.toFixed(1)}s)`);
    } else {
      console.log('[make-video] no music track available, rendering silent');
    }
    res.setHeader('Content-Type', 'video/mp4');
    res.send(fs.readFileSync(outPath));
  } catch (err) {
    console.error('[make-video] failed:', err.message);
    res.status(500).json({ error: 'make-video failed', detail: String(err.message).slice(0, 400) });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- Reel builder: AI image + Bengali voiceover + Ken Burns video ---------

const REEL_W = 1080;
const REEL_H = 1920;

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 180000, maxBuffer: 1 << 26, ...opts }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${cmd} failed: ${String(stderr || err.message).slice(-500)}`));
      resolve({ stdout, stderr });
    });
  });
}

async function fetchImage(prompt, seed) {
  // Free tier caps output around 576x1024; ffmpeg upscales to full reel size.
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${REEL_W}&height=${REEL_H}&model=flux&nologo=true&seed=${seed}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`image generation failed: HTTP ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length < 5000) throw new Error('image generation returned a suspiciously small file');
  return buf;
}

// Each line is spoken separately and joined with silence: one long take reads
// as rushed, whereas a beat between lines gives the cinematic delivery.
async function speakLines(lines, voice, opts, dir) {
  const { rate = '-25%', pitch = '-3Hz', gap = 0.85, lead = 0.6, tail = 1.4 } = opts || {};
  const parts = [];
  for (let i = 0; i < lines.length; i++) {
    const p = path.join(dir, `line${i}.mp3`);
    await run('edge-tts', ['--voice', voice, '--text', lines[i], '--write-media', p, `--rate=${rate}`, `--pitch=${pitch}`]);
    parts.push(p);
  }
  const silence = path.join(dir, 'gap.mp3');
  await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', String(gap), '-c:a', 'libmp3lame', silence]);
  const leadSil = path.join(dir, 'lead.mp3');
  await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', String(lead), '-c:a', 'libmp3lame', leadSil]);
  const tailSil = path.join(dir, 'tail.mp3');
  await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', String(tail), '-c:a', 'libmp3lame', tailSil]);

  const seq = [leadSil];
  parts.forEach((p, i) => { seq.push(p); if (i < parts.length - 1) seq.push(silence); });
  seq.push(tailSil);

  const listFile = path.join(dir, 'concat.txt');
  fs.writeFileSync(listFile, seq.map((p) => `file '${p}'`).join('\n'));
  const out = path.join(dir, 'voice.mp3');
  await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c:a', 'libmp3lame', '-b:a', '128k', out]);
  return out;
}

function pickMusic(dir) {
  const from = dir || process.env.MUSIC_DIR || '/app/music';
  let files = [];
  try {
    files = fs.readdirSync(from).filter((f) => f.toLowerCase().endsWith('.mp3'));
  } catch (_) {
    return null;
  }
  if (!files.length) return null;
  return path.join(from, files[Math.floor(Math.random() * files.length)]);
}

// CC-BY requires naming the artist and licence wherever the work is used, so
// every track carries its credit line back to the caller.
const creditCache = new Map();
function musicCredit(trackPath) {
  if (!trackPath) return null;
  const dir = path.dirname(trackPath);
  const file = path.basename(trackPath);
  if (!creditCache.has(dir)) {
    let list = [];
    try {
      list = JSON.parse(fs.readFileSync(path.join(dir, 'MUSIC_CREDITS.json'), 'utf8'));
    } catch (_) {}
    creditCache.set(dir, new Map(list.map((c) => [c.file, c])));
  }
  const c = creditCache.get(dir).get(file);
  if (!c) return null;
  const line = `Music: "${c.title}" by ${c.artist} | ${c.license} (${c.license_url}) | ${c.source}`;
  return { file, line, ascii: toHeaderSafe(line) };
}

// HTTP headers are latin-1 only, but artist names carry accents. Fold to ASCII
// for the plain header and ship the exact UTF-8 text base64 alongside it.
function toHeaderSafe(s) {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‐-―]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^\x20-\x7e]/g, '');
}

async function probeDuration(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
  return parseFloat(String(stdout).trim()) || 0;
}

// ffmpeg's drawtext cannot shape Bengali conjuncts, so the caption is rendered
// as a transparent PNG by the browser (which shapes correctly) and overlaid.
async function renderTextOverlay(lines, brand) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { width:${REEL_W}px; height:${REEL_H}px; background:transparent;
           font-family:'Noto Sans Bengali','Lohit Bengali',sans-serif;
           display:flex; flex-direction:column; justify-content:flex-end;
           padding:0 90px 300px; }
    .line { font-size:62px; line-height:1.55; font-weight:700; color:#fff; text-align:center;
            text-shadow:0 4px 26px rgba(0,0,0,.95), 0 2px 8px rgba(0,0,0,.9); }
    .brand { margin-top:44px; text-align:center; font-size:30px; color:rgba(255,255,255,.9);
             letter-spacing:3px; text-shadow:0 2px 12px rgba(0,0,0,.9); }
  </style></head><body>
    ${lines.map((l) => `<div class="line">${esc(l)}</div>`).join('')}
    <div class="brand">${esc(brand)}</div>
  </body></html>`;
  const browser = await getBrowser();
  const page = await browser.newPage({ viewport: { width: REEL_W, height: REEL_H }, deviceScaleFactor: 1 });
  try {
    await page.setContent(html, { waitUntil: 'load' });
    await page.waitForTimeout(300);
    return await page.screenshot({ type: 'png', omitBackground: true });
  } finally {
    await page.close().catch(() => {});
  }
}

app.post('/make-reel', async (req, res) => {
  const {
    imagePrompt,
    lines,
    voice = 'bn-BD-NabanitaNeural',
    brand = '',
    seed = Math.floor(Math.random() * 1e6),
    rate = '-25%',
    pitch = '-3Hz',
    gap = 0.85,
    voiceLufs = -16,
    musicLufs = -27,
    music = true,
  } = req.body || {};
  if (!imagePrompt) return res.status(400).json({ error: 'imagePrompt is required' });
  const textLines = Array.isArray(lines) ? lines.filter(Boolean) : [];
  if (!textLines.length) return res.status(400).json({ error: 'lines (array of Bengali text) is required' });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-'));
  try {
    const imgPath = path.join(dir, 'bg.jpg');
    const overlayPath = path.join(dir, 'text.png');
    const outPath = path.join(dir, 'reel.mp4');

    const [imgBuf, overlayBuf, voicePath] = await Promise.all([
      fetchImage(imagePrompt, seed),
      withLock(() => renderTextOverlay(textLines, brand)),
      speakLines(textLines, voice, { rate, pitch, gap }, dir),
    ]);
    fs.writeFileSync(imgPath, imgBuf);
    fs.writeFileSync(overlayPath, overlayBuf);

    // Hold on screen a beat after the narration ends; Reels need at least 3s.
    const speech = await probeDuration(voicePath);
    const duration = Math.min(Math.max(Math.round((speech + 1.2) * 10) / 10, 6), 88);
    const fps = 30;
    const frames = Math.round(duration * fps);

    const musicPath = music ? pickMusic() : null;
    const inputs = ['-loop', '1', '-i', imgPath, '-i', overlayPath, '-i', voicePath];
    if (musicPath) inputs.push('-stream_loop', '-1', '-i', musicPath);

    // The CC0 tracks range from -16 dB to -44 dB, so a fixed volume multiplier
    // makes quiet ones inaudible. Normalise both stems to fixed loudness
    // targets instead: the gap between voiceLufs and musicLufs is the mix.
    const voiceChain = `[2:a]loudnorm=I=${voiceLufs}:TP=-2:LRA=11,afade=t=out:st=${Math.max(duration - 1.4, 0).toFixed(2)}:d=1.2,apad`;
    const audioFilter = musicPath
      ? `${voiceChain}[vo];` +
        `[3:a]loudnorm=I=${musicLufs}:TP=-6:LRA=11,afade=t=in:st=0:d=2.0,` +
        `afade=t=out:st=${Math.max(duration - 2.5, 0).toFixed(2)}:d=2.5[bgm];` +
        `[vo][bgm]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]`
      : `${voiceChain}[a]`;

    await run('ffmpeg', [
      '-y',
      ...inputs,
      '-filter_complex',
      `[0:v]scale=${REEL_W * 2}:${REEL_H * 2}:force_original_aspect_ratio=increase,` +
        `crop=${REEL_W * 2}:${REEL_H * 2},` +
        `zoompan=z='min(zoom+0.00035,1.14)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${REEL_W}x${REEL_H}:fps=${fps},` +
        `eq=saturation=1.06[bg];` +
        `[bg][1:v]overlay=0:0:format=auto,fade=t=in:st=0:d=0.6,fade=t=out:st=${(duration - 0.6).toFixed(2)}:d=0.6[v];` +
        audioFilter,
      '-map', '[v]', '-map', '[a]',
      '-t', String(duration),
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '21', '-pix_fmt', 'yuv420p',
      '-r', String(fps), '-g', String(fps * 2),
      '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
      '-movflags', '+faststart',
      outPath,
    ]);

    const mp4 = fs.readFileSync(outPath);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('X-Reel-Duration', String(duration));
    res.send(mp4);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`browser-automation-sidecar listening on :${PORT}`));
