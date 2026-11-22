'use strict';
/* Classifier training tests — run: node tests.js */
const { classify, credibility, isBlocked, isBlockedUrl, deriveAutoStatus, tokenSet, jaccard, MILESTONES } = require('./server.js');

const cases = [
  // --- the user's false positives: must be REJECTED ---
  {
    name: 'GTA6Intel "waiting for PC port" hype tweet',
    item: { source: 'twitter', author: '@GTA6Intel', title: 'GTA 6 fans waiting for the PC port be like…', text: 'when will it come to pc 😭 we wait' },
    expect: false
  },
  {
    name: 'GBAtemp Xbox cloud auth research thread (GTA only in body)',
    item: { source: 'rss', sourceName: 'GBAtemp', title: 'Research: Xbox Cloud Gaming console authentication on PC (XSTS DeviceTypeNotAllowed) emulation', text: 'someone in the comments mentioned gta 6 and pc dreams' },
    expect: false
  },
  {
    name: 'Metacritic review noise',
    item: { source: 'rss', sourceName: 'GBAtemp', title: 'GTA VI scores 99 on Metacritic, tying Ocarina of Time record', text: 'review scores everywhere' },
    expect: false
  },
  {
    name: 'Generic "when is GTA 6 coming to PC" article',
    item: { source: 'rss', sourceName: 'Wololo.net', title: 'When will GTA 6 come to PC? Release date expectations', text: 'fans hoping and waiting for the pc version release date' },
    expect: false
  },

  // --- the user's true positives: must be ACCEPTED ---
  {
    name: 'couldbeautism (trusted scene dev) exploit progress, no GTA mention',
    item: { source: 'twitter', author: '@couldbeautism', title: 'Byepervisor exploit released — kernel r/w working on latest firmware', text: 'public repo, enjoy' },
    expect: true
  },
  {
    name: 'Gezine (trusted scene dev) dump tooling',
    item: { source: 'twitter', author: '@Gezine', title: 'New PS5 dump tool released, decrypts game files', text: 'github link inside' },
    expect: true
  },
  {
    name: 'Random Redditor with an actual dump',
    item: { source: 'reddit', author: 'u/randomguy', title: 'GTA VI dump decrypted — full game files extracted (150 GB)', text: 'sha256 hashes attached, screenshot proof' },
    expect: true
  },
  {
    name: 'Random tweet: PC port build actually boots',
    item: { source: 'twitter', author: '@somebody', title: 'GTA VI PC port build boots to menu on Windows', text: 'screenshot proof, repo soon' },
    expect: true
  },
  {
    name: 'GitHub repo: gta6 dump tool',
    item: { source: 'github', author: 'dev', title: 'dev/gta6-dump-tool — Decrypts and extracts GTA VI PKG game files', text: 'Python · 12 stars' },
    expect: true
  },
  {
    name: 'GitHub repo: GTA VI reverse engineering',
    item: { source: 'github', author: 'dev', title: 'dev/gta-vi-research — Reverse engineering GTA VI file formats and engine internals', text: 'C++ · 40 stars' },
    expect: true
  },
  {
    name: 'Forum thread: GTA VI RE progress (GTA in title)',
    item: { source: 'rss', sourceName: 'PSXHAX', title: 'GTA VI file formats documented — reverse engineering progress thread', text: 'engine analysis, scripts decoded' },
    expect: true
  },

  // --- scam offers: rejected; scam warnings: not flagged ---
  {
    name: 'Scam: "GTA 6 PC download free working emulator"',
    item: { source: 'twitter', author: '@random', title: 'GTA 6 PC download free working emulator 2026', text: 'link in bio' },
    expect: false
  },
  {
    name: 'Scam: PCSX5 promotion',
    item: { source: 'rss', sourceName: 'GBAtemp', title: 'PCSX5 emulator runs GTA 6 on PC — download here', text: 'best ps5 emulator' },
    expect: false
  },
  {
    name: 'Scam WARNING stays unflagged (useful info)',
    fn: () => classify({ source: 'reddit', title: 'Beware: fake GTA 6 PC download sites spread malware', text: 'do not download, scam warning' }).scam !== true,
    expect: true
  },
  {
    name: 'Legit dump with download link is NOT a scam',
    item: { source: 'reddit', title: 'GTA VI dump decrypted — download link and sha256 hashes', text: '150 GB game files extracted' },
    expect: true
  },

  // --- blueprint page is context, NOT a source ---
  {
    name: 'Blocklist: example tracker repo rejected',
    fn: () => isBlocked({ source: 'github', title: 'alan-r-henry/gta6-pc-tracker — Every route to GTA 6 on PC', url: 'https://github.com/alan-r-henry/gta6-pc-tracker' }),
    expect: true
  },
  {
    name: 'Blocklist: real emulator project NOT blocked',
    fn: () => !isBlocked({ source: 'github', title: 'kytyps5emu/KytyPS5-GTA-6', url: 'https://github.com/kytyps5emu/KytyPS5-GTA-6' }),
    expect: true
  },

  // --- emulator devs & Xbox scene ---
  {
    name: 'General emulator push (no GTA) now rejected',
    item: { source: 'github', author: 'Nmzik', title: 'Nmzik pushed to kytyps5emu/KytyPS5', text: 'kernel HLE improvements · shader cache fix' },
    expect: false
  },
  {
    name: 'GTA-6 repo push with generic commit = GTA porting progress',
    item: { source: 'github', author: 'Nmzik', title: 'Nmzik pushed to kytyps5emu/KytyPS5-GTA-6', text: 'shader cache fix' },
    expect: true
  },
  {
    name: 'Core emulator repo without GTA rejected',
    item: { source: 'github', title: 'KytyPS5/KytyPS5 — PlayStation 5 translation layer for Windows, Linux and macOS', text: 'C++' },
    expect: false
  },
  {
    name: 'Random unrelated repo push stays out',
    item: { source: 'github', author: 'someone', title: 'someone pushed to dotfiles', text: 'fix typo in vimrc' },
    expect: false
  },
  {
    name: 'Xbox dump of GTA 6 accepted',
    item: { source: 'reddit', title: 'GTA 6 dumped from Xbox Series X — game files extracted', text: 'full dump, hashes posted' },
    expect: true
  },
  {
    name: 'tuxuser (trusted Xbox dev) exploit progress, no GTA mention',
    item: { source: 'twitter', author: '@tuxuser', title: 'Xbox Series kernel exploit released — working on latest firmware', text: 'repo public' },
    expect: true
  },

  // --- ecosystem noise & fake installers ---
  {
    name: 'Scam: "GTA VI PC Installer hub" repo',
    item: { source: 'github', title: 'Andriy-samp/GTA-6-Switch-Version--PC-Emulator-2026 — GTA VI PC Installer hub for Grand Theft Auto VI', text: 'download' },
    expect: false
  },
  {
    name: 'Noise: AnyPS5 Discord bot repo rejected',
    item: { source: 'github', title: 'LORDSL360/AnyPS5-Discord — Discord bot for AnyPS5', text: 'bot' },
    expect: false
  },
  {
    name: 'Noise: emulator website repo rejected',
    item: { source: 'github', title: 'sharpemu/sharpemu-site — SharpEmu website — landing page and compatibility data', text: 'website' },
    expect: false
  },
  {
    name: 'Other-game port (Saros-Recomp) rejected — not GTA 6',
    item: { source: 'github', title: 'portingpete/Saros-Recomp — Saros running on Windows with AnyPS5. Prologue gameplay', text: 'recomp' },
    expect: false
  },
  {
    name: 'Generic PS5 translation layer (ELKY5) rejected — not GTA 6',
    item: { source: 'github', title: 'Ilyesltm/ELKY5 — ELKY5 is a free and open-source PlayStation 5 translation layer', text: 'C++' },
    expect: false
  },

  {
    name: 'Emulator fork mentioning GTA only in description rejected',
    item: { source: 'github', title: 'MilliMailmanOverpass/KytyPS5-Enhanced — Enhanced KytyPS5 PS5 emulator with launcher, shader cache, GTA VI fixes', text: '' },
    expect: false
  },
  {
    name: 'GTA-named price-analysis repo rejected (not dump/RE/port work)',
    item: { source: 'github', title: 'sebusubash-rgb/gta6-xbox-price-analysis — Xbox price analysis for GTA 6', text: '' },
    expect: false
  },
  {
    name: 'Generic-named repo that decrypts GTA VI files kept',
    item: { source: 'github', title: 'dev/ps5-tools — Decrypts and extracts GTA VI PKG game files', text: 'Python' },
    expect: true
  },

  // --- rumours & fake analysis (user's r/Piracy example) ---
  {
    name: 'r/Piracy "allegedly dumped via firmware rollback" kept AND flagged fake',
    fn: () => {
      const item = { source: 'reddit', author: 'u/someone', title: 'GTA 6 allegedly dumped using a firmware rollback', text: 'sounds too good to be true' };
      return classify(item).relevant === true && credibility(item).credibility === 'fake';
    },
    expect: true
  },
  {
    name: 'Debunking post about the rollback claim is NOT flagged fake',
    fn: () => credibility({ source: 'reddit', title: 'That GTA 6 firmware rollback dump claim is fake — PS5 fuses prevent downgrade', text: 'warning, hoax debunked' }).credibility !== 'fake',
    expect: true
  },
  {
    name: 'Plain rumor (no impossible claim) = unverified, still kept',
    fn: () => {
      const item = { source: 'reddit', title: 'GTA 6 allegedly dumped, insider claims files are out there', text: 'unconfirmed' };
      return classify(item).relevant === true && credibility(item).credibility === 'unverified';
    },
    expect: true
  },
  {
    name: 'GTA-6 emulator project gets the emu tag',
    fn: () => classify({ source: 'github', title: 'kytyps5emu/KytyPS5-GTA-6 — monitors Rockstar engine progress', text: '' }).tags.includes('emu'),
    expect: true
  },

  // --- Cyberleek category ---
  {
    name: 'Cyberleek "Xbox build released, no exe" kept, tagged, tier = likely old build',
    fn: () => {
      const item = { source: 'twitter', author: '@Cyberleek', title: 'GTA 6 Xbox build released on my site — no exe, you know what to do', text: 'leek dot site' };
      const c = classify(item);
      return c.relevant === true && c.tags.includes('cyberleek') && credibility(item).credibility === 'old-build';
    },
    expect: true
  },
  {
    name: 'Third-party forensic research on Cyberleek keeps normal credibility',
    fn: () => credibility({ source: 'github', title: 'FermataRest/cyberleek-leak-research — Technical forensic research and provenance breakdown of the leak', text: '' }).credibility !== 'old-build',
    expect: true
  },
  {
    name: 'Reddit discussion mentioning Cyberleek build claim = old-build tier',
    fn: () => {
      const item = { source: 'reddit', title: 'Cyberleek says the Xbox build is up on his site', text: 'no exe though, suspicious' };
      return classify(item).relevant === true && credibility(item).credibility === 'old-build';
    },
    expect: true
  },

  {
    name: 'Discovered Reddit post (Google-indexed) about the Xbox build = old-build',
    fn: () => {
      const item = { source: 'reddit', sourceName: 'Reddit', title: "Cyberleek just dropped a GTA 6 Xbox Build without the game's executable", text: '' };
      return classify(item).relevant === true && classify(item).tags.includes('cyberleek') && credibility(item).credibility === 'old-build';
    },
    expect: true
  },
  {
    name: 'Discovered X post about the 209GB build = old-build',
    fn: () => {
      const item = { source: 'twitter', sourceName: 'X', title: 'gta vi cyber leek build out for xbox. only missing the executable. total size: 209GB', text: '' };
      return classify(item).relevant === true && credibility(item).credibility === 'old-build';
    },
    expect: true
  },

  // --- updated milestone chain (leaked build minus exe) ---
  {
    name: 'Milestone weights sum to 100',
    fn: () => MILESTONES.reduce((s, m) => s + m.weight, 0) === 100,
    expect: true
  },
  {
    name: 'r/pcmasterrace "build without executable" matches the exe step',
    fn: () => MILESTONES.find(m => m.id === 'exe-obtain').re.test("Cyberleek just dropped a GTA 6 Xbox build without the game's executable"),
    expect: true
  },

  {
    name: 'Info-only: leaked video / media / his-site URLs blocked',
    fn: () => ['https://rumble.com/v7h1qb6-final-cyber-leek-gta6-leak-101826.html',
               'https://arweave.net/hhOoYZtHBqQi3d-dmxcGooXKTbiT3HJ2-eNsE7HNtKg',
               'https://cyberleek.somegateway.io', 'https://leek.vilenarios.com/'].every(isBlockedUrl),
    expect: true
  },
  {
    name: 'Info-only: discussion posts on Reddit/X still allowed',
    fn: () => !isBlockedUrl('https://www.reddit.com/r/pcmasterrace/comments/1y0ihk9/cyberleek_just_dropped_a_gta_6_xbox_build_without/') &&
              !isBlockedUrl('https://x.com/someone/status/123'),
    expect: true
  },

  // --- conservative auto-mode ---
  {
    name: 'Auto: no evidence → locked',
    fn: () => deriveAutoStatus([]) === 'locked',
    expect: true
  },
  {
    name: 'Auto: single unverified rumor → rumored (not more)',
    fn: () => deriveAutoStatus([{ credibility: 'unverified', sourceName: 'Reddit', author: 'u/x' }]) === 'rumored',
    expect: true
  },
  {
    name: 'Auto: many independent old-build reports → in-progress',
    fn: () => deriveAutoStatus(Array.from({ length: 8 }, (_, k) => ({ credibility: 'old-build', sourceName: 'X', author: '@user' + k }))) === 'in-progress',
    expect: true
  },
  {
    name: 'Auto: fake posts never count',
    fn: () => deriveAutoStatus(Array.from({ length: 20 }, () => ({ credibility: 'fake', sourceName: 'X', author: '@bot' }))) === 'locked',
    expect: true
  },
  {
    name: 'Auto: never reaches confirmed even with massive evidence',
    fn: () => deriveAutoStatus(Array.from({ length: 100 }, (_, k) => ({ credibility: 'trusted', sourceName: 'X', author: '@dev' + k }))) === 'in-progress',
    expect: true
  },
  {
    name: 'Auto: 8 reports from ONE voice stay rumored (no brigading)',
    fn: () => deriveAutoStatus(Array.from({ length: 8 }, () => ({ credibility: 'old-build', sourceName: 'X', author: '@same' }))) === 'rumored',
    expect: true
  },

  {
    name: 'Exe negation: all four real-world "exe not out" phrasings excluded',
    fn: () => {
      const { NEG_EXE_RE } = require('./server.js');
      const titles = [
        'The executable is locked behind a countdown, with a $15M crypto market-cap condition',
        "Cyberleek just dropped a GTA 6 Xbox Build without the game's executable",
        'dropped the Xbox build with main executable - he says, he will drop it if market cap reaches 15M',
        'all the build files from the Xbox, except for the main executable'
      ];
      return titles.every(t => NEG_EXE_RE.test(t)) && !NEG_EXE_RE.test('GTA 6 main executable extracted from retail Xbox disc');
    },
    expect: true
  },

  {
    name: 'Leonida recompilation repo recognized as RE progress',
    fn: () => {
      const item = { source: 'github', title: 'ItsNotRexed/Leonida — Leonida Is A Native PC Recompilation Of The Xbox Version Of Grand Theft Auto 6', text: 'Python · 11531 stars' };
      const c = classify(item);
      return c.relevant === true && c.tags.includes('re');
    },
    expect: true
  },

  // --- near-duplicate suppression ---
  {
    name: 'Jaccard: same story reworded',
    fn: () => jaccard(tokenSet('GTA VI dump decrypted — full game files extracted'), tokenSet('GTA VI dump decrypted: full game files extracted!')) >= 0.8,
    expect: true
  },
  {
    name: 'Jaccard: different stories stay separate',
    fn: () => jaccard(tokenSet('GTA VI dump decrypted — full game files extracted'), tokenSet('GTA VI PC port build boots to menu on Windows')) < 0.8,
    expect: true
  }
];

let pass = 0, fail = 0;
for (const c of cases) {
  const got = c.fn ? c.fn() : classify(c.item).relevant;
  const ok = got === c.expect;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}  (expected ${c.expect}, got ${got})`);
  ok ? pass++ : fail++;
}
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
