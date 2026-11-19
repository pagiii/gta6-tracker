---
title: GTA VI Dump & PC Port Tracker
emoji: 🎮
colorFrom: pink
colorTo: purple
sdk: docker
app_port: 7860
pinned: false
---

# GTA VI — Live Dump & PC Port Tracker

A **live, read-only, public-facing** dashboard tracking one thing: **GTA VI game files
getting dumped, decrypted, reverse engineered and ported to PC**.
Community sources only — **Reddit, X/Twitter and scene forums**. No news sites, no magazines,
no logins, no database, no visitor-editable state.

## Weighted milestones (difficulty-aware progress)

Getting decrypted files is hard; reverse engineering and porting are even harder —
the percentages reflect that. Weights sum to 100. Chain updated for the release-day
situation (Cyberleek's leaked Xbox build reportedly lacks only the main .exe):

| Step | Weight | Meaning |
|---|---|---|
| Game files leaked / dumped | **10** | Xbox build (~209 GB) out — reportedly minus the main executable |
| Main executable obtained | **15** | the missing .exe — needs a retail Xbox dump or reconstruction |
| Build authentic, decrypted & verified | **15** | prove it's genuine (not old/faked), decrypt, verify |
| Reverse engineering underway | **20** | formats, scripting, engine internals understood |
| PC port / emulation build in progress | **15** | community effort to run it on PC underway |
| Playable on PC | **25** | the end goal |

Progress % = Σ (step weight × status factor), where status factor is
`locked 0 · rumored 0.15 · in-progress 0.5 · confirmed 1`.

**Conservative auto-mode** (`"autoProgress": true`): steps set to `"auto"` in
`config.json → progress` derive their status from collected evidence:

- fake-flagged posts never count; posts saying the .exe is *missing* never count
  toward obtaining it
- tier points: trusted 3 · community 2 · likely-old-build 1.5 · unverified 1
- any valid evidence → **rumored**; ≥ 8 points from ≥ 4 independent voices → **in-progress**
- **auto never reaches `confirmed`** — that stays maintainer-only
- an explicit status in `config.progress` always overrides auto (e.g. `dump-files` is
  maintainer-confirmed: the ~209 GB Xbox build leak is corroborated by dozens of
  independent reports; the remaining skepticism lives in the *verify* and *executable* steps)

## Trained topic filter (v2) — rare, real dump news only

Tuned against real false positives / false negatives:

- **Title anchor:** forum / Reddit / GitHub posts must mention GTA VI **in the title** —
  a thread about something else that merely mentions GTA in the body is rejected
  (e.g. Xbox-cloud-auth research threads).
- **Hype ≠ progress:** "waiting for the PC port", "when will GTA 6 come to PC",
  release-date speculation → rejected unless actual dump / RE / port *work* is described
  (boots, build, tool, repo, released, progress…).
- **Trusted scene developers** (theflow0, SpecterDev, ChendoChap, flat_z, idlesauce,
  notzecoxao, **couldbeautism**, **Gezine**): technical progress posts (exploit / dump /
  decrypt released or working) are included **even without an explicit GTA mention**,
  tagged `scene progress` — because that work is the prerequisite chain.
- **Random newcomers still get through** via dump/RE keywords, Reddit search and GitHub —
  credibility badges, not whitelists, decide how much weight a post carries.
- **GitHub repository search** (4 queries/poll, public API): actively pushed repos about
  GTA 6 dumps / PC ports / decryption / reverse engineering. Freshness uses `pushed_at`,
  so live development surfaces; public code counts as concrete evidence (🟢).
- **Near-duplicate suppression:** identical normalized text (reposts/RTs) and
  near-identical titles (Jaccard ≥ 0.8, same story cross-posted) are kept only once.
- **Scam-offer rejection:** fake "GTA 6 PC download" offers, PCSX5 promotion, keygens,
  torrents etc. are rejected outright (context: fake AnyPS5/KytyPS5 repos spread
  password-stealing malware in Oct 2026; PCSX5 has never been shown running a PS5 game).
  Posts *warning* about scams are exempt.
- **Collection context** drawn from the community blueprint at
  `alan-r-henry.github.io/gta6-pc-tracker` — used **only as training data, never as a source**:
  - The blueprint itself (and its repo) is **blocklisted** from the feed (`config.blocklist`).
  - GTA VI requires FW **14.23** while public jailbreaks reach only 13.60 → `14.23` is part
    of the Reddit search query (the exploit bottleneck is a dump signal).
  - **Well-known hackers** on the X watchlist/trusted tier: theflow0, SpecterDev, ChendoChap,
    flat_z, idlesauce, notzecoxao, couldbeautism, Gezine, Znullptr, oct0xor, **tuxuser (Xbox scene)**.
  - **Emulator developers**: the blueprint's 30 named contributors to AnyPS5 / KytyPS5 / SharpEmu
    (+ tuxuser, XboxDev) are tracked via their **public GitHub push events**, rotated 3 per poll,
    one item per repo per day — but **only GTA-6-specific activity counts**: the repo name or
    the commit messages must mention GTA. General emulator development, other games' ports
    and ecosystem noise (Discord bots, monitors, launchers, packaging, websites, cheats)
    are rejected. A GTA-named repo is by definition a GTA-6 dump/RE/port effort and is kept.
  - GitHub repo searches are GTA-specific: dump / PC port / RE / emulator / decrypt / Xbox.

Regression tests for all of the above: `node tests.js` (30 cases, incl. the exact
false-positive examples that motivated each training pass).

## Fake vs real: credibility heuristic

Every post gets a badge (heuristic — **not** fact-checking):

- 🟢 **trusted** — known scene developers on X (`twitter.trusted` list: theflow0, SpecterDev,
  ChendoChap, flat_z, idlesauce, notzecoxao, couldbeautism, Gezine, Znullptr, oct0xor, tuxuser)
  **or** concrete evidence markers (repo links, hashes, screenshots, file sizes, public GitHub code)
- 🟡 **community** — established scene forums (Wololo / PSXHAX / GBAtemp) or partially
  supported claims
- 🔴 **unverified** — anonymous posts or rumor language (*allegedly, insider, leaker,
  unconfirmed…*) — treat as speculation; collected worldwide (any subreddit) via global search
- ⛔ **likely fake** — rumor language **plus a technically impossible claim**
  (e.g. "dumped via firmware rollback" — PS5 firmware is fuse-protected, rollback is impossible).
  Excluded from milestone evidence. Posts *debunking* such claims are exempt.

Scoring: +2 trusted dev, +1 scene forum, +2 real GitHub project / +1 other repo,
+1 evidence markers, −1 rumor language; impossible-claim combo overrides to `fake`.
Filter chips: **🟢 Trusted**, **❓ Rumours** (unverified + old-build + likely fake), topic chips
(Dump / Reverse engineering / PC port / 🎮 Emulators / 🥬 **Cyberleek**) and source chips.
Per-step weights are calculated on the backend only — not shown on the page.
Polling is **automatic only** (no manual refresh button or endpoint).

## Cyberleek category (📦 likely old build)

Cyberleek = the Aug-2026 GTA VI leak operation: authentic-but-old internal footage
(confirmed by Take-Two DMCA takedowns) distributed via a Solana/Arweave decentralized site,
wrapped in a `$CYBERLEEK` memecoin pump-and-dump (per community forensics). His reported
release-day "Xbox build without exe" (~209 GB) is unverified and likely an old/dev build.

- **He has no official Twitter/Reddit account.** He operated sites like
  `cyberleek.vevivo.art` / `leek.vilenarios.com` (blockchain-hosted, now down/blocked).
- **Information-only policy:** the tracker does **not** poll or link his sites/mirrors,
  and never links leaked media (videos/images). URLs pointing to Arweave/ArNS gateways,
  Rumble leak videos, his domains or leak-download sites are blocked outright.
- **Mention collection is the route:** recent posts from *other* accounts about
  Cyberleek and his leaked Xbox build are collected worldwide via site-restricted
  search-index queries (`cyberleek site:reddit.com`, `cyberleek site:x.com`, last 24 h) —
  real post titles, dates and links to the **discussion posts**, attributed to Reddit/X.
  Links go through the search engine's article redirect (one consent click in the EU).
- His releases / build claims get the **📦 likely old build** trust tier; third-party
  forensics, warnings and analysis keep normal credibility.

## Strict post filtering

- **Topic:** GTA VI / GTA 6 / Grand Theft Auto **AND** dump / decrypt / PKG / game files /
  leaked build / rip / extract / reverse engineering / PC port / PC version.
- **Freshness:** dated **19 Nov 2026 (release day) or newer** (`minDate`). Older or undated
  posts are dropped. News-site items are never accepted.

## Sources & health strategy

| Source | Method |
|---|---|
| X/Twitter | **nitter.cz RSS first**, official syndication endpoint as fallback; 2 accounts per poll, spaced, delayed retry; links normalized to x.com |
| Reddit | official Atom RSS — global dump-phrase search (24 h) + r/ps4homebrew new; spaced requests |
| Forums | Wololo.net, PSXHAX, GBAtemp official RSS |
| GitHub | repository search API (6 GTA-specific dump/port/RE/emulator/decrypt/Xbox queries per poll) + rotated push-event tracking of 32 named emulator/Xbox developers, **GTA-6 activity only** |

Source health is tracked **internally only** (server log) — visitors don't see it.
Reddit/X throttle unauthenticated access from any given IP; red periods recover automatically
on later polls, and a public host with a fresh IP generally fares better.

## Run / deploy

```
double-click start.bat      (or: node server.js)
```

Local: **http://127.0.0.1:3090**. Zero dependencies, Node 18+.

**Going live:** set `"host": "0.0.0.0"` in `config.json` (or env `HOST`) and put the service
behind your reverse proxy / hosting of choice. The page is fully read-only; the only write
endpoint is `POST /api/poll`, throttled to one forced refresh per minute.

## Files

- `server.js` — pollers, parsers, classifier, credibility scorer, weighted milestone engine, SSE
- `public/` — public dashboard (HTML/CSS/JS)
- `config.json` — progress statuses, sources, trusted accounts, cutoff, host/port
- `data/state.json` — plain-JSON cache of fetched posts (not a database; safe to delete)
- `start.bat` — one-click launcher

## Honest limitations

- Forum RSS exposes **thread-start dates**: threads started before release day won't appear
  even if bumped today. X and Reddit dates are post-level and exact.
- Credibility badges are heuristics; they reduce noise but cannot guarantee truth.
- Quiet periods with an empty feed are normal and correct given the strict filters.

> This tool only aggregates **public discussion**. It hosts no game files, keys or copyrighted content.
