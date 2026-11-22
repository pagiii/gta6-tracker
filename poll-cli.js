'use strict';
/* Serverless poller for GitHub Actions:
 * restores previous state from the live Pages site, polls all sources,
 * writes state.json for the static dashboard. No server needed. */
const fs = require('fs');
const STATE_URL = process.env.STATE_URL || 'https://pagiii.github.io/gta6-tracker/state.json';

(async () => {
  // Restore previous state (items, dedup fingerprints, rotation cursors).
  try {
    const r = await fetch(STATE_URL + '?t=' + Date.now(), { signal: AbortSignal.timeout(20000) });
    if (r.ok) {
      const j = await r.json();
      fs.mkdirSync('data', { recursive: true });
      fs.writeFileSync('data/state.json', JSON.stringify({
        items: j.items || [],
        sourceHealth: {},
        lastPollAt: j.lastPollAt || null,
        pollCount: j.pollCount || 0,
        twitterCursor: j.twitterCursor || 0,
        githubCursor: j.githubCursor || 0
      }));
      console.log('restored previous state:', (j.items || []).length, 'items');
    }
  } catch (e) { console.log('no previous state available:', e.message); }

  const { poll, publicState } = require('./server.js');
  await poll();
  const out = publicState();
  fs.writeFileSync('state.json', JSON.stringify(out));
  console.log('state.json written:', out.items.length, 'items |', out.progress.overall + '% |', out.milestones.map(m => m.id + '=' + m.status).join(' '));
})();
