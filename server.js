/*
 * GTA VI — Live Dump & PC Port Tracker
 * Zero-dependency Node.js server (Node 18+).
 *
 * Polls Reddit, scene-forum RSS feeds and (best-effort) X/Twitter
 * timelines, keeps only GTA VI dump / PC-port posts dated on or after
 * release day, classifies them into milestones and pushes
 * live updates to the dashboard over Server-Sent Events.
 *
 * Run:  node server.js   →  http://127.0.0.1:3090
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const STATE_PATH = path.join(DATA_DIR, 'state.json');

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const PORT = Number(process.env.PORT || config.port || 3090);
const POLL_MS = Math.max(1, Number(process.env.POLL_MINUTES || config.pollMinutes || 5)) * 60_000;
const MIN_DATE_STR = String(config.minDate || '2026-11-19');
const MIN_DATE = new Date(MIN_DATE_STR + 'T00:00:00'); // release day, local midnight
const MAX_ITEMS = 800;
const UA_BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/* ------------------------------------------------------------------ */
/* Milestone model                                                     */
/* ------------------------------------------------------------------ */

/* Weights reflect real difficulty: getting decrypted files is hard,
 * reverse engineering and porting are even harder. Weights sum to 100.
 * Chain updated for the release-day situation: Cyberleek's leaked Xbox
 * build (~209 GB) reportedly contains everything EXCEPT the main .exe. */
const MILESTONES = [
  {
    id: 'dump-files', track: 'dump', weight: 10, name: 'GTA VI game files leaked / dumped',
    desc: 'Xbox build (~209 GB) leaked by Cyberleek — reportedly complete except the main executable. Unverified; likely old / dev build.',
    re: /gta[\s-]?(6|vi|six).{0,160}(dump(s|ed|ing)?|leak(ed)?\s+(files|build)|\.pkg|disc\s+image|game\s+files)|(dump(s|ed|ing)?).{0,100}gta[\s-]?(6|vi|six)/i
  },
  {
    id: 'exe-obtain', track: 'dump', weight: 15, name: 'Main executable obtained',
    desc: 'The missing piece: the leaked build has no main .exe. Needs a retail Xbox dump or reconstruction before anything can run.',
    re: /(gta[\s-]?(6|vi|six)|cyber[\s-]?leek|xbox\s+build).{0,160}(executable|\.exe|main\s+exe)|(executable|\.exe).{0,120}(gta[\s-]?(6|vi|six)|cyber[\s-]?leek|xbox\s+build)/i
  },
  {
    id: 'dump-verify', track: 'dump', weight: 15, name: 'Build authentic, decrypted & verified',
    desc: 'The hard part: prove the build is genuine (not old / faked), decrypt and verify its contents.',
    re: /(dump|pkg|game files|build).{0,140}(verified|decrypt\w*|complete|extracted|authentic)|(verified|decrypt\w*|authentic).{0,100}(dump|gta[\s-]?(6|vi)|build)/i
  },
  {
    id: 'pc-re', track: 'dump', weight: 20, name: 'Reverse engineering underway',
    desc: 'Even harder: file formats, scripting and engine internals understood / documented.',
    re: /gta[\s-]?(6|vi|six).{0,160}(reverse[ -]?engineer|reversing|formats?\s+(documented|cracked|figured|understood)|engine\s+(reversed|analysis|internals))|(reverse[ -]?engineer|reversing).{0,120}gta[\s-]?(6|vi|six)/i
  },
  {
    id: 'pc-project', track: 'dump', weight: 15, name: 'PC port / emulation build in progress',
    desc: 'A community effort to get the build running on PC (native port or emulator) is publicly underway.',
    re: /gta[\s-]?(6|vi|six).{0,160}(pc\s+port|pc\s+build|windows\s+(build|port)|porting|running\s+on\s+pc)|(pc\s+port|pc\s+build).{0,120}gta[\s-]?(6|vi|six)/i
  },
  {
    id: 'pc-playable', track: 'dump', weight: 25, name: 'Playable on PC',
    desc: 'The end goal: GTA VI actually playable on PC hardware.',
    re: /gta[\s-]?(6|vi|six).{0,200}(playable|runs|boot(s|ed)?|working).{0,120}(pc|windows)|(pc|windows).{0,120}gta[\s-]?(6|vi|six).{0,160}(playable|runs|working)/i
  }
];
const STRONG_RE = /\b(released|public release|confirmed|works|working|successfully|booted|playable|decrypted|verified|full dump|complete dump)\b/i;
const STATUS_WEIGHT = { locked: 0, rumored: 0.15, 'in-progress': 0.5, confirmed: 1 };

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

fs.mkdirSync(DATA_DIR, { recursive: true });
let state = { items: [], sourceHealth: {}, lastPollAt: null, pollCount: 0, twitterCursor: 0, githubCursor: 0, siteHashes: {}, gatewayCursor: 0 };
try {
  const saved = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  state = Object.assign(state, saved);
} catch { /* first run */ }

// Prune health entries for sources no longer configured.
{
  const expected = new Set([
    'reddit-search', 'reddit-new', 'github', 'github-contrib',
    ...(config.rss || []).map(f => 'rss:' + f.name),
    ...(config.news || []).map(f => 'news:' + f.name),
    ...(config.discovery || []).map(f => 'disc:' + f.name),
    ...(config.twitter.accounts || []).map(a => 'x:@' + a)
  ]);
  for (const k of Object.keys(state.sourceHealth)) if (!expected.has(k)) delete state.sourceHealth[k];
  for (const s of Object.values(state.sourceHealth)) {
    if (s.lastError && s.lastError.includes('+ Add post')) s.lastError = 'rate limited by X — rotates back on later polls';
  }
}

let polling = false;
const sseClients = new Set();

function saveState() {
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify({
      items: state.items,
      sourceHealth: state.sourceHealth, lastPollAt: state.lastPollAt, pollCount: state.pollCount,
      twitterCursor: state.twitterCursor || 0, githubCursor: state.githubCursor || 0,
      siteHashes: state.siteHashes || {}, gatewayCursor: state.gatewayCursor || 0
    }));
  } catch (e) { log('WARN save failed: ' + e.message); }
}

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }
function hash(s) { return crypto.createHash('sha1').update(s).digest('hex').slice(0, 16); }

/* ------------------------------------------------------------------ */
/* Fetch helpers                                                       */
/* ------------------------------------------------------------------ */

async function fetchText(url, { ua = UA_BROWSER, accept = '*/*', timeoutMs = 20_000 } = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': ua, 'Accept': accept, 'Accept-Language': 'en-US,en;q=0.9' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { text: await res.text(), contentType: res.headers.get('content-type') || '', finalUrl: res.url };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function pool(tasks, size = 4) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < tasks.length) {
      const idx = i++;
      try { results[idx] = await tasks[idx](); } catch (e) { results[idx] = { __error: e.message }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, tasks.length) }, worker));
  return results;
}

/* ------------------------------------------------------------------ */
/* Parsers                                                             */
/* ------------------------------------------------------------------ */

function decodeEntities(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}
function stripTags(s) { return decodeEntities(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim(); }
function tagContent(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? decodeEntities(m[1]).trim() : '';
}

function parseRss(xml, feedName, source = 'rss') {
  const blocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) || xml.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
  const out = [];
  for (const b of blocks.slice(0, 60)) {
    const title = stripTags(tagContent(b, 'title'));
    let link = tagContent(b, 'link');
    if (!link) {
      const m = b.match(/<link[^>]*href=["']([^"']+)["']/i);
      link = m ? m[1] : '';
    }
    const dateRaw = tagContent(b, 'pubDate') || tagContent(b, 'dc:date') || tagContent(b, 'published') || tagContent(b, 'updated');
    const desc = stripTags(tagContent(b, 'description') || tagContent(b, 'content:encoded') || tagContent(b, 'summary') || tagContent(b, 'content')).slice(0, 600);
    const author = stripTags(tagContent(b, 'dc:creator') || tagContent(b, 'author'));
    if (!title || !link) continue;
    const d = dateRaw ? new Date(dateRaw) : null;
    let sourceName = feedName;
    const srcTag = stripTags(tagContent(b, 'source')); // Google News: real publisher
    if (srcTag) sourceName = srcTag;
    if (feedName.includes('+')) { // global Reddit search: derive the real sub from the link
      const sm = link.match(/reddit\.com\/r\/([^/]+)/i);
      if (sm) sourceName = 'r/' + sm[1];
    }
    out.push({
      source, sourceName, externalId: hash(link),
      author, title, text: desc, url: link,
      date: d && !isNaN(d.getTime()) ? d.toISOString() : null
    });
  }
  return out;
}

function collectTweets(node, out, depth = 0) {
  if (!node || depth > 9 || out.length > 40) return;
  if (Array.isArray(node)) { for (const v of node) collectTweets(v, out, depth + 1); return; }
  if (typeof node === 'object') {
    if (typeof node.full_text === 'string' && node.id_str) {
      const user = (node.user && node.user.screen_name) ||
        (node.core && node.core.user_results && node.core.user_results.result &&
          node.core.user_results.result.legacy && node.core.user_results.result.legacy.screen_name) || '';
      out.push({ text: node.full_text, id: node.id_str, date: node.created_at, user });
    }
    for (const v of Object.values(node)) collectTweets(v, out, depth + 1);
  }
}

function parseTwitterTimeline(html, account) {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('no timeline data (X blocks unauthenticated access)');
  const tweets = [];
  collectTweets(JSON.parse(m[1]), tweets);
  if (!tweets.length) throw new Error('timeline empty / blocked by X');
  return tweets.map(t => {
    const d = t.date ? new Date(t.date) : null;
    const text = decodeEntities(t.text);
    return {
      source: 'twitter', sourceName: 'X @' + (t.user || account), externalId: t.id,
      author: '@' + (t.user || account),
      title: text.split('\n')[0].slice(0, 140),
      text: text.slice(0, 600),
      url: `https://x.com/${t.user || account}/status/${t.id}`,
      date: d && !isNaN(d.getTime()) ? d.toISOString() : null
    };
  });
}

/* ------------------------------------------------------------------ */
/* Classification                                                      */
/* ------------------------------------------------------------------ */

const GTA_RE = /\b(gta[\s-]?(6|vi|six)|grand theft auto)\b/i;
const DUMP_RE = /\b(dump(s|ed|ing)?|decrypt(ed|ion|able)?|\.pkg|leak(ed)?\s+(files|build)|game\s+files|data\s+files|disc\s+image|rip(s|ped)?|extract(ed|ing|ion)?|full\s+(game|dump))\b/i;
const RE_RE = /\b(reverse[ -]?engineer\w*|reversing|formats?\s+(documented|cracked|figured|understood)|engine\s+(reversed|analysis|internals)|decompil\w*)\b/i;
const PC_RE = /\b(pc\s+port|pc\s+build|pc\s+version|windows\s+(build|port|version)|port\w*\s+to\s+pc|on\s+pc)\b/i;
const PC_WORK_RE = /\b(port(ed|ing|s)?|build|boot(s|ed|ing)?|run(s|ning)?|playable|progress|working|works|released|repo(sitory)?|source\s+code|tool|patch|emulat\w*)\b/i;
const WAITING_RE = /\b(waiting|wait\s+for|can'?t\s+wait|when\s+(will|is|does)|release\s+date|comes?\s+to\s+pc|coming\s+to\s+pc|hoping|hope\b|wish|will\s+it)\b/i;
const SCENE_RE = /\b(exploit|kernel|jailbreak|webkit|kex|hypervisor|byepervisor|bd-?jb|userland|dump|decrypt|\.elf|payload)\b/i;
/* Scam offers (fake "GTA 6 PC downloads", PCSX5, keygens…) are rejected outright.
 * Posts WARNING about scams are exempt — they are useful community info.
 * Context: fake AnyPS5/KytyPS5 repos spread password-stealing malware (Oct 2026);
 * PCSX5 has no source code and has never been shown running a PS5 game. */
const SCAM_RE = /\b(pcsx5|keygen|torrent|free\s+download|full\s+version\s+download|crack\s+download|gta[\s-]?(6|vi|six)\s+pc\s+download|download\s+gta[\s-]?(6|vi|six)\s+(pc|for\s+pc)|gta[\s-]?(6|vi|six)\b.{0,60}\b(installer|install\s+now))\b/i;
const SCAM_WARN_RE = /\b(scam|fake|malware|hoax|beware|warning|don'?t\s+download|debunk|not\s+real|steal\w*)\b/i;
/* Technically impossible claims = strong fake markers.
 * PS5 firmware is fuse-protected: rollback/downgrade is impossible, so
 * "dumped via firmware rollback" stories are fake (as community debunked).
 * Posts debunking such claims are exempt via SCAM_WARN_RE. */
const IMPOSSIBLE_RE = /\b((firmware|fw)\s+rollback|rollback\s+(firmware|fw)|downgrad\w*\s+(firmware|fw|ps5)|ps5\s+downgrade|firmware\s+downgrade)\b/i;
/* Cyberleek: Aug-2026 GTA VI leak operation (authentic-but-old internal footage,
 * wrapped in a $CYBERLEEK memecoin pump-and-dump per community forensics).
 * His reported "Xbox build without exe" is unverified and likely an old/dev build.
 * All Cyberleek-related posts are collected under their own tag + trust tier. */
const CYBERLEEK_RE = /\bcyber[\s-]?leek\b/i;
const CYBERLEEK_RELEASE_RE = /\b(xbox\s+build|build|released|release|no\s+exe|without\s+exe|leak(ed|s)?)\b/i;
const ANALYSIS_RE = /\b(forensic\w*|research|investigation|analysis|provenance|debunk\w*)\b/i;
/* Known PS5 emulator projects — used for credibility scoring only.
 * General emulator development is NOT collected: everything must be
 * specifically about dumping / reverse engineering / porting GTA 6.
 * Ecosystem noise (Discord bots, monitors, launchers, packaging, websites,
 * cheat tables, archives) is rejected even on GTA-named repos. */
const EMU_PROJECT_RE = /\b(anyps5|kytyps5|sharpemu)\b/i;
const PS5_EMU_RE = /\b(ps5|playstation\s?5)\b.{0,60}\b(emulator|translation\s+layer|recomp\w*)\b|\b(emulator|translation\s+layer)\b.{0,60}\b(ps5|playstation\s?5)\b/i;
const EMU_NOISE_RE = /\b(discord|monitor\w*|bot\b|website|\bsite\b|landing|appimage|launcher|modded|cheat\w*|archiv\w*|stream\w*|youtube|desktop|retro)\b/i;
const PORT_PROGRESS_RE = /\b(recomp\w*|port(ed|ing|s)?|running\s+on|gameplay|in-?game|boots?|playable|gta)\b/i;
/* A GTA-named repo only counts if its name indicates dump/RE/port work —
 * not price lists, news roundups, fan pages etc. */
const GTA_REPO_WORK_RE = /(dump|port|recomp|decrypt|extract|reverse|emu|kytyps5|anyps5|sharpemu|translation|\bpc\b|windows|linux|files|pkg|build)/i;
/* Aggregators / example pages are blueprints, NOT primary sources. */
const BLOCKLIST = (config.blocklist || []).map(s => String(s).toLowerCase());
function isBlocked(item) {
  const blob = `${item.title || ''} ${item.url || ''} ${item.sourceName || ''}`.toLowerCase();
  return BLOCKLIST.some(b => blob.includes(b));
}
/* Information-only policy: never link leaked media (videos/images) or
 * Cyberleek's own sites/mirrors. Discussion posts ABOUT them are fine. */
const BLOCKED_URL_RE = /(arweave\.net|\.ar\.io|ardrive\.net|permaweb\.io|rumble\.com|vilenarios\.com|vevivo\.art|gamedrive\.org|ipfs\.io|cyberleek\.[a-z])/i;
function isBlockedUrl(url) { return BLOCKED_URL_RE.test(String(url || '')); }
const TRUSTED_X = new Set((config.twitter.trusted || []).map(s => String(s).toLowerCase()));

/* Trained topic filter (v2):
 *  - GTA must be in the TITLE for forum/reddit/github posts (body mentions don't count —
 *    kills off-topic threads that merely mention GTA somewhere).
 *  - Tweets: GTA anywhere, but needs a real dump / RE / PC-work signal.
 *  - "Waiting for PC port / when will it come to PC" hype is NOT progress → rejected
 *    unless actual dump/RE work is described.
 *  - Trusted scene developers: technical progress posts (exploit/dump/decrypt released,
 *    working…) are included even without an explicit GTA mention, tagged 'scene'.
 *  - Random newcomers still get through via dump/RE keywords + GitHub + Reddit search. */
function classify(item) {
  const title = String(item.title || '');
  const blob = `${title} ${item.text || ''} ${item.author || ''} ${item.sourceName || ''}`;
  if (SCAM_RE.test(blob) && !SCAM_WARN_RE.test(blob)) {
    return { tags: [], signals: [], strong: false, relevant: false, scam: true };
  }
  const gtaTitle = GTA_RE.test(title);
  const gtaAny = GTA_RE.test(blob);
  const dump = DUMP_RE.test(blob);
  const re = RE_RE.test(blob);
  const pcStrict = PC_RE.test(blob) && (dump || re || (PC_WORK_RE.test(blob) && !WAITING_RE.test(blob)));
  const handle = String(item.author || '').replace(/^@/, '').toLowerCase();
  const trustedDev = item.source === 'twitter' && TRUSTED_X.has(handle);

  let relevant = false;
  const tags = [];
  /* GitHub: GTA must be in the REPO NAME (description mentions don't anchor —
   * a general emulator fork mentioning GTA among many games is emulator news).
   * A GTA-named repo counts only if its name indicates dump/RE/port work. */
  const repoPart = title.split(' — ')[0];
  const gtaRepo = item.source === 'github' && GTA_RE.test(repoPart);
  const gtaAnchor = item.source === 'github' ? gtaRepo : gtaTitle;
  if ((gtaAnchor || (item.source === 'twitter' && gtaAny)) && (dump || re || pcStrict)) {
    relevant = true;
  } else if (item.source === 'github' && gtaAny && (dump || re)) {
    relevant = true; // GTA-specific tooling described (e.g. "decrypts GTA VI PKG")
  } else if (gtaRepo && GTA_REPO_WORK_RE.test(repoPart) && !EMU_NOISE_RE.test(repoPart)) {
    relevant = true;
  } else if (CYBERLEEK_RE.test(blob)) {
    relevant = true; // Cyberleek is by definition GTA-6 leak activity
  } else if (trustedDev && SCENE_RE.test(blob) && STRONG_RE.test(blob)) {
    relevant = true;
    tags.push('scene');
  }
  if (relevant) {
    if (dump) tags.push('dump');
    if (re) tags.push('re');
    if (pcStrict) tags.push('pc');
    if (gtaRepo && !tags.length) tags.push('pc');
    if (EMU_PROJECT_RE.test(blob) || PS5_EMU_RE.test(blob) || /\bemulators?\b/i.test(title)) tags.push('emu');
    if (CYBERLEEK_RE.test(blob)) tags.push('cyberleek');
  }
  const signals = relevant ? MILESTONES.filter(m => m.re.test(blob)).map(m => m.id) : [];
  return { tags, signals, strong: STRONG_RE.test(blob), relevant };
}

/* Credibility heuristic — NOT fact-checking:
 *  +2 known scene developers on X (trusted list in config)
 *  +1 established scene forums (Wololo / PSXHAX / GBAtemp)
 *  +1 concrete evidence markers (repo links, hashes, screenshots, file sizes…)
 *  -1 rumor / hoax language (allegedly, insider, unconfirmed, debunked…)
 * score >= 2 → trusted · 1 → community · <= 0 → unverified */
const EVIDENCE_RE = /(github\.com|gitlab\.com|screenshot|\bproof\b|\bhash(es)?\b|sha-?256|\bmd5\b|\d+(\.\d+)?\s?(gb|mb)\b|repository|source\s+code|\brepo\b|file\s?size|\bdownload\b)/i;
const RUMOR_RE = /\b(rumou?r(ed|s)?|alleged(ly)?|reportedly|speculat\w*|insider(s)?|leaker(s)?|unconfirmed|hoax|debunked|clickbait|fake)\b/i;
function credibility(item) {
  const blob = `${item.title || ''} ${item.text || ''} ${item.author || ''} ${item.sourceName || ''}`;
  let score = 0;
  if (item.source === 'twitter') {
    const handle = String(item.author || '').replace(/^@/, '').toLowerCase();
    if (TRUSTED_X.has(handle)) score += 2;
  } else if (item.source === 'rss') {
    score += 1;
  } else if (item.source === 'github') {
    // real projects / porting progress = concrete evidence; junk forks = community only
    score += (EMU_PROJECT_RE.test(blob) || PS5_EMU_RE.test(blob) || PORT_PROGRESS_RE.test(blob)) ? 2 : 1;
  }
  if (EVIDENCE_RE.test(blob)) score += 1;
  if (RUMOR_RE.test(blob)) score -= 1;
  // Rumor language + technically impossible claim → likely fake
  // (e.g. "GTA 6 allegedly dumped via firmware rollback" — PS5 fuses forbid that).
  if (IMPOSSIBLE_RE.test(blob) && !SCAM_WARN_RE.test(blob) && (RUMOR_RE.test(blob) || score <= 0)) {
    return { credScore: score - 2, credibility: 'fake' };
  }
  // Cyberleek's own releases / build claims → "likely old build" tier.
  // Third-party forensics, warnings and analysis keep their normal scoring.
  const ckHandle = String(item.author || '').replace(/^@/, '').toLowerCase();
  if (CYBERLEEK_RE.test(blob) && !SCAM_WARN_RE.test(blob) && !ANALYSIS_RE.test(blob) &&
      (ckHandle === 'cyberleek' || CYBERLEEK_RELEASE_RE.test(blob))) {
    return { credScore: score, credibility: 'old-build' };
  }
  return { credScore: score, credibility: score >= 2 ? 'trusted' : score === 1 ? 'community' : 'unverified' };
}

// Re-classify persisted items with current rules; drop off-topic, pre-release,
// news-site or blocklisted (aggregator/example-page) items.
state.items = state.items.filter(i => {
  if (i.source === 'news' || i.source === 'manual' || i.source === 'site') return false;
  if (isBlocked(i) || isBlockedUrl(i.url)) return false;
  // Cyberleek is not on GitHub — mirror/memecoin repos are not him.
  if (i.source === 'github' && /cyberleek/i.test(i.title)) return false;
  const d = new Date(i.date);
  if (!i.date || isNaN(d.getTime()) || d < MIN_DATE) return false;
  const c = classify(i);
  if (!c.relevant) return false;
  i.tags = c.tags; i.signals = c.signals; i.strong = c.strong;
  Object.assign(i, credibility(i));
  return true;
});

/* Near-duplicate suppression: identical normalized text (reposts/RTs) or
 * near-identical titles (same story cross-posted) are kept only once. */
function normText(s) {
  return String(s || '').toLowerCase().replace(/https?:\/\/\S+/g, ' ').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function tokenSet(s) { return new Set(normText(s).split(' ').filter(w => w.length > 2)); }
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

function upsertItems(rawItems) {
  const known = new Set(state.items.map(i => i.id));
  const knownFp = new Set(state.items.map(i => i.fp).filter(Boolean));
  const knownTitles = state.items.map(i => tokenSet(i.title));
  const added = [];
  for (const raw of rawItems) {
    if (isBlocked(raw) || isBlockedUrl(raw.url)) continue;
    // Hard freshness cutoff: nothing older than release day.
    const d = new Date(raw.date);
    if (!raw.date || isNaN(d.getTime()) || d < MIN_DATE) continue;
    const c = classify(raw);
    if (!c.relevant) continue;
    const id = `${raw.source}:${raw.externalId || hash(raw.url + raw.title)}`;
    if (known.has(id)) continue;
    const fp = hash(normText(`${raw.title} ${raw.text}`).slice(0, 500));
    if (knownFp.has(fp)) continue;
    const tt = tokenSet(raw.title);
    if (knownTitles.some(kt => jaccard(tt, kt) >= 0.8)) continue;
    known.add(id); knownFp.add(fp); knownTitles.push(tt);
    const item = Object.assign({ id, fp, addedAt: new Date().toISOString() }, raw, c, credibility(raw));
    state.items.push(item);
    added.push(item);
  }
  if (added.length) {
    state.items.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    state.items = state.items.slice(0, MAX_ITEMS);
  }
  return added;
}

/* ------------------------------------------------------------------ */
/* Milestones + progress                                               */
/* ------------------------------------------------------------------ */

/* Progress is STATIC: statuses come only from config.json → "progress".
 * The maintainer edits them by hand when legitimate sources prove a step.
 * Matching posts are shown as evidence, but never change the status. */
const VALID_STATUSES = ['locked', 'rumored', 'in-progress', 'confirmed'];
const CRED_RANK = { trusted: 0, community: 1, 'old-build': 2, unverified: 3, fake: 4 };
/* Conservative auto-mode: evidence can raise a step to rumored / in-progress,
 * NEVER to confirmed (that stays maintainer-only via config.progress).
 * Points per credibility tier; in-progress needs broad independent corroboration. */
const TIER_POINTS = { trusted: 3, community: 2, 'old-build': 1.5, unverified: 1 };
function deriveAutoStatus(items) {
  const valid = items.filter(i => i.credibility !== 'fake');
  if (!valid.length) return 'locked';
  const points = valid.reduce((s, i) => s + (TIER_POINTS[i.credibility] || 0), 0);
  const voices = new Set(valid.map(i => `${i.sourceName}|${i.author || ''}`)).size;
  return (points >= 8 && voices >= 4) ? 'in-progress' : 'rumored';
}
/* Posts saying the executable is MISSING / held / conditional are not progress
 * toward obtaining it (covers "without the game's executable", "except for the
 * main executable", "locked behind a countdown", "will drop it if market cap…"). */
const NEG_EXE_RE = /((without|missing|lacks|except|minus|no|locked|held)\b.{0,40}?\b(executables?|exe)\b|\b(executables?|exe)\b.{0,40}?\b(missing|not\s+included|absent|locked|countdown|will\s+(drop|release|be))|market\s*cap.{0,80}(exe|executable|drop|release)|(exe|executable).{0,80}market\s*cap)/i;
function computeMilestones() {
  return MILESTONES.map(m => {
    let matching = state.items.filter(i => i.signals && i.signals.includes(m.id));
    if (m.id === 'exe-obtain') matching = matching.filter(i => !NEG_EXE_RE.test(`${i.title} ${i.text || ''}`));
    const evidence = matching
      .sort((a, b) => (CRED_RANK[a.credibility] ?? 3) - (CRED_RANK[b.credibility] ?? 3) || (b.date || '').localeCompare(a.date || ''))
      .slice(0, 5)
      .map(i => ({ id: i.id, title: i.title, url: i.url, date: i.date, sourceName: i.sourceName, credibility: i.credibility }));
    const configured = (config.progress || {})[m.id];
    let status;
    if (configured && configured !== 'auto' && VALID_STATUSES.includes(configured)) status = configured; // manual wins
    else if (config.autoProgress) status = deriveAutoStatus(matching);
    else status = 'locked';
    return { id: m.id, track: m.track, weight: m.weight, name: m.name, desc: m.desc, status, evidence, signalCount: matching.length };
  });
}

function computeProgress(milestones) {
  const totalWeight = milestones.reduce((s, m) => s + m.weight, 0) || 1;
  const earned = milestones.reduce((s, m) => s + m.weight * (STATUS_WEIGHT[m.status] || 0), 0);
  const pct = Math.round(100 * earned / totalWeight);
  return { dump: pct, overall: pct };
}

function publicState() {
  const milestones = computeMilestones();
  return {
    minDate: MIN_DATE_STR,
    pollMinutes: POLL_MS / 60_000,
    lastPollAt: state.lastPollAt,
    nextPollAt: state.lastPollAt ? new Date(new Date(state.lastPollAt).getTime() + POLL_MS).toISOString() : null,
    pollCount: state.pollCount,
    polling,
    twitterCursor: state.twitterCursor || 0,
    githubCursor: state.githubCursor || 0,
    milestones,
    progress: computeProgress(milestones),
    items: state.items.slice(0, 300)
  };
}

function broadcast() {
  const payload = `data: ${JSON.stringify({ type: 'state', state: publicState() })}\n\n`;
  for (const res of sseClients) { try { res.write(payload); } catch { sseClients.delete(res); } }
}

/* ------------------------------------------------------------------ */
/* Polling                                                             */
/* ------------------------------------------------------------------ */

function setHealth(key, name, kind, ok, extra = {}) {
  const prev = state.sourceHealth[key] || {};
  state.sourceHealth[key] = Object.assign(prev, {
    key, name, kind, ok,
    lastAttempt: new Date().toISOString(),
    lastSuccess: ok ? new Date().toISOString() : prev.lastSuccess || null,
    lastError: ok ? null : (extra.error || 'unknown error'),
    itemsFound: extra.itemsFound != null ? extra.itemsFound : prev.itemsFound || 0
  });
}

async function poll() {
  if (polling) return { ok: false, reason: 'already polling' };
  polling = true;
  const started = Date.now();
  log('poll started');
  const tasks = [];
  let totalSources = 0;

  // Forum / blog RSS feeds + news RSS (parallel — these are friendly).
  for (const feed of config.rss || []) {
    totalSources++;
    tasks.push(async () => {
      const key = 'rss:' + feed.name;
      try {
        const r = await fetchText(feed.url, { accept: 'application/rss+xml, application/xml, text/xml, */*' });
        const items = parseRss(r.text, feed.name);
        const added = upsertItems(items);
        setHealth(key, feed.name, 'rss', true, { itemsFound: added.length });
      } catch (e) { setHealth(key, feed.name, 'rss', false, { error: e.message }); }
    });
  }
  for (const feed of config.news || []) {
    totalSources++;
    tasks.push(async () => {
      const key = 'news:' + feed.name;
      try {
        const r = await fetchText(feed.url, { accept: 'application/rss+xml, application/xml, text/xml, */*' });
        const items = parseRss(r.text, feed.name, 'news');
        const added = upsertItems(items);
        setHealth(key, feed.name, 'news', true, { itemsFound: added.length });
      } catch (e) { setHealth(key, feed.name, 'news', false, { error: e.message }); }
    });
  }
  // Community discovery via search-engine index: site-restricted queries that
  // surface actual Reddit / X posts (used because Reddit/X APIs block this host).
  // Items are attributed to their real platform, not to the index.
  for (const feed of config.discovery || []) {
    totalSources++;
    tasks.push(async () => {
      const key = 'disc:' + feed.name;
      try {
        const r = await fetchText(feed.url, { accept: 'application/rss+xml, application/xml, text/xml, */*' });
        const items = parseRss(r.text, feed.name, feed.source).map(it => Object.assign(it, {
          title: it.title.replace(/\s+-\s+(Reddit|X|Twitter)\s*$/i, ''),
          sourceName: feed.source === 'reddit' ? 'Reddit' : 'X'
        }));
        const added = upsertItems(items);
        setHealth(key, feed.name, 'discovery', true, { itemsFound: added.length });
      } catch (e) { setHealth(key, feed.name, 'discovery', false, { error: e.message }); }
    });
  }
  await pool(tasks, 4);

  // GitHub: repository search — public API, no auth (10 searches/min limit).
  // Freshness uses pushed_at, so actively-developed dump/port/RE repos surface.
  const ghQueries = (config.github && config.github.queries) || [];
  if (ghQueries.length) {
    totalSources++;
    let ghOk = false, ghAdded = 0, ghErr = null;
    for (let i = 0; i < ghQueries.length; i++) {
      if (i > 0) await sleep(7_000);
      try {
        const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(ghQueries[i])}&sort=updated&order=desc&per_page=30`;
        const r = await fetchText(url, { accept: 'application/vnd.github+json' });
        const data = JSON.parse(r.text);
        const items = (data.items || []).map(repo => ({
          source: 'github', sourceName: 'GitHub', externalId: String(repo.id),
          author: repo.owner ? repo.owner.login : '',
          title: repo.full_name + (repo.description ? ' — ' + repo.description : ''),
          text: [repo.language, repo.stargazers_count + ' stars', (repo.topics || []).join(', ')].filter(Boolean).join(' · ').slice(0, 600),
          url: repo.html_url,
          date: repo.pushed_at || repo.created_at || null
        }));
        ghAdded += upsertItems(items).length;
        ghOk = true;
      } catch (e) { ghErr = e.message; }
    }
    setHealth('github', 'GitHub repos', 'github', ghOk, { itemsFound: ghAdded, error: ghErr });
  }

  // GitHub contributor activity: public push events of the known emulator /
  // Xbox developers (names sourced from the community blueprint). Rotated a
  // few per poll; one item per repo per day so active projects don't flood.
  const contributors = (config.github && config.github.contributors) || [];
  const contribPerPoll = Math.max(1, Number((config.github && config.github.contributorsPerPoll) || 3));
  if (contributors.length) {
    totalSources++;
    const cursor = Number(state.githubCursor || 0);
    const batch = [];
    for (let k = 0; k < Math.min(contribPerPoll, contributors.length); k++) batch.push(contributors[(cursor + k) % contributors.length]);
    state.githubCursor = (cursor + batch.length) % contributors.length;
    let cOk = false, cAdded = 0, cErr = null;
    for (let i = 0; i < batch.length; i++) {
      if (i > 0) await sleep(2_000);
      const user = batch[i];
      try {
        const r = await fetchText(`https://api.github.com/users/${encodeURIComponent(user)}/events/public?per_page=50`, { accept: 'application/vnd.github+json' });
        const events = JSON.parse(r.text);
        if (!Array.isArray(events)) throw new Error('unexpected response');
        const items = [];
        for (const ev of events) {
          if (ev.type !== 'PushEvent' || !ev.repo || !ev.created_at) continue;
          const commits = ((ev.payload && ev.payload.commits) || []).map(c => c.message).join(' · ');
          // GTA-6-specific (or Cyberleek) only: repo name or commit messages must match.
          if (!/gta|cyberleek|leek/i.test(ev.repo.name) && !GTA_RE.test(commits) && !CYBERLEEK_RE.test(commits)) continue;
          const day = ev.created_at.slice(0, 10);
          items.push({
            source: 'github', sourceName: 'GitHub',
            externalId: `evt:${ev.repo.name}:${day}`,
            author: user,
            title: `${user} pushed to ${ev.repo.name}`,
            text: commits.slice(0, 600),
            url: `https://github.com/${ev.repo.name}`,
            date: ev.created_at
          });
        }
        cAdded += upsertItems(items).length;
        cOk = true;
      } catch (e) { cErr = e.message; }
    }
    setHealth('github-contrib', 'GitHub dev activity', 'github', cOk, { itemsFound: cAdded, error: cErr });
  }

  // Reddit: public Atom/RSS endpoints, spaced out to respect rate limits.
  const subs = (config.reddit.subreddits || []).join('+');
  const q = encodeURIComponent(config.reddit.query || '"gta 6 dump" OR "gta vi pc port"');
  const mainSub = (config.reddit.subreddits || ['ps5homebrew'])[0];
  const mirror = String(config.reddit.mirror || '').replace(/\/$/, '');
  const redditJobs = [
    {
      key: 'reddit-search', name: 'Reddit search',
      urls: [
        `https://www.reddit.com/search.rss?q=${q}&sort=new&t=day&limit=50`,
        mirror ? `${mirror}/search.rss?q=${q}&sort=new&t=day&limit=50` : null
      ].filter(Boolean)
    },
    {
      key: 'reddit-new', name: `Reddit r/${mainSub} new`,
      urls: [
        `https://www.reddit.com/r/${mainSub}/new/.rss?limit=50`,
        mirror ? `${mirror}/r/${mainSub}/new.rss` : null
      ].filter(Boolean)
    }
  ];
  for (let i = 0; i < redditJobs.length; i++) {
    const job = redditJobs[i];
    totalSources++;
    if (i > 0) await sleep(12_000);
    try {
      let r, lastErr;
      for (const u of job.urls) {
        try { r = await fetchText(u, { accept: 'application/atom+xml, application/rss+xml, application/xml, text/xml, */*' }); break; }
        catch (e) { lastErr = e; }
      }
      if (!r) throw lastErr || new Error('no urls');
      if (!/<rss|<feed|<\?xml/i.test(r.text.slice(0, 400))) throw new Error('Reddit returned a block page (not a feed)');
      const items = parseRss(r.text, 'r/' + (job.key === 'reddit-new' ? mainSub : subs), 'reddit');
      const added = upsertItems(items);
      setHealth(job.key, job.name, 'reddit', true, { itemsFound: added.length });
    } catch (e) {
      const msg = /429/.test(e.message) ? 'rate limited (429) — retrying next poll' : e.message;
      setHealth(job.key, job.name, 'reddit', false, { error: msg });
    }
  }

  // X/Twitter: nitter RSS first (healthier), official syndication as fallback.
  // Rotates a small batch per poll, spaced out, with one delayed retry on 429.
  const accounts = config.twitter.accounts || [];
  const perPoll = Math.max(1, Number(config.twitter.perPoll || 2));
  const nitterBase = String(config.twitter.nitter || '').replace(/\/$/, '');
  if (accounts.length) {
    const cursor = Number(state.twitterCursor || 0);
    const batch = [];
    for (let k = 0; k < Math.min(perPoll, accounts.length); k++) batch.push(accounts[(cursor + k) % accounts.length]);
    state.twitterCursor = (cursor + batch.length) % accounts.length;
    for (let i = 0; i < batch.length; i++) {
      const account = batch[i];
      totalSources++;
      if (i > 0) await sleep(10_000);
      const key = 'x:@' + account;
      const syndUrl = `https://syndication.twitter.com/srv/timeline-profile/screen-name/${account}`;
      try {
        let items = null;
        // 1) nitter RSS — the instance sits behind Cloudflare and challenges
        // intermittently, so retry once after a pause to catch an open window.
        if (nitterBase) {
          for (let attempt = 0; attempt < 2 && !items; attempt++) {
            if (attempt > 0) await sleep(20_000);
            try {
              const r = await fetchText(`${nitterBase}/${account}/rss`, { accept: 'application/rss+xml, application/xml, text/xml, */*' });
              if (/<rss|<\?xml/i.test(r.text.slice(0, 400)) && /<item[\s>]/i.test(r.text)) {
                items = parseRss(r.text, 'X @' + account, 'twitter').map(it => {
                  const sm = it.url.match(/\/status\/(\d+)/);
                  return Object.assign(it, {
                    externalId: sm ? sm[1] : it.externalId,
                    author: '@' + account,
                    url: it.url.replace(/^https?:\/\/[^/]+/i, 'https://x.com').replace(/#m$/, '')
                  });
                });
              }
            } catch { /* retry / fall through to syndication */ }
          }
        }
        // 2) official syndication endpoint
        if (!items) {
          let r;
          try { r = await fetchText(syndUrl, { accept: 'text/html' }); }
          catch (e) {
            if (/429/.test(e.message)) { await sleep(45_000); r = await fetchText(syndUrl, { accept: 'text/html' }); }
            else throw e;
          }
          items = parseTwitterTimeline(r.text, account);
        }
        const added = upsertItems(items);
        setHealth(key, 'X @' + account, 'twitter', true, { itemsFound: added.length });
      } catch (e) {
        const msg = /429/.test(e.message) ? 'rate limited by X — rotates back on later polls' : e.message;
        setHealth(key, 'X @' + account, 'twitter', false, { error: msg });
      }
    }
  }

  state.lastPollAt = new Date().toISOString();
  state.pollCount++;
  saveState();
  broadcast();
  polling = false;
  const okCount = Object.values(state.sourceHealth).filter(s => s.ok).length;
  log(`poll finished in ${((Date.now() - started) / 1000).toFixed(1)}s — ${okCount}/${totalSources} sources ok, ${state.items.length} items tracked`);
  return { ok: true };
}

function scheduleNext() {
  setTimeout(async () => { await poll(); scheduleNext(); }, POLL_MS).unref?.();
}

/* ------------------------------------------------------------------ */
/* HTTP server                                                         */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon'
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  try {
    if (p === '/api/state' && req.method === 'GET') return sendJson(res, 200, publicState());

    if (p === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store',
        'Connection': 'keep-alive', 'X-Accel-Buffering': 'no'
      });
      res.write(`data: ${JSON.stringify({ type: 'state', state: publicState() })}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (p.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' });

    // Static files.
    let filePath = path.normalize(path.join(PUBLIC_DIR, p === '/' ? 'index.html' : p));
    if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(filePath).pipe(res);
  } catch (e) {
    log('ERROR ' + e.message);
    try { sendJson(res, 500, { error: e.message }); } catch { /* noop */ }
  }
});

if (require.main === module) {
  setInterval(() => { for (const r of sseClients) { try { r.write(': hb\n\n'); } catch { sseClients.delete(r); } } }, 25_000);

  const HOST = String(process.env.HOST || config.host || '127.0.0.1');
  server.listen(PORT, HOST, () => {
    log(`GTA VI live tracker listening on http://${HOST}:${PORT}`);
    log(`GTA VI dump watch since ${MIN_DATE_STR} — polling every ${POLL_MS / 60_000} min`);
    setTimeout(() => { poll().then(scheduleNext); }, 1000);
  });
}

module.exports = { classify, credibility, isBlocked, isBlockedUrl, deriveAutoStatus, NEG_EXE_RE, normText, tokenSet, jaccard, MILESTONES, TRUSTED_X, poll, publicState };
