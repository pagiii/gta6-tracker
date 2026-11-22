'use strict';
/* GTA VI dump & PC-port live tracker — frontend */

let S = null;               // latest server state
let filter = 'all';
let query = '';
let page = 1;
const PAGE_SIZE = 24;
let knownIds = new Set();
let firstRender = true;

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function timeAgo(iso) {
  if (!iso) return 'never';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return Math.floor(s) + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}
function timeUntil(iso) {
  if (!iso) return '—';
  const s = Math.max(0, (new Date(iso).getTime() - Date.now()) / 1000);
  if (s < 60) return Math.floor(s) + 's';
  return Math.floor(s / 60) + 'm ' + Math.floor(s % 60) + 's';
}
function fmtDate(iso) {
  const d = new Date(iso + 'T00:00:00');
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/* ---------------- data ---------------- */

async function fetchState() {
  try {
    const r = await fetch('state.json?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    applyState(await r.json());
    setLive(true, 'auto-refresh');
  } catch (e) { setLive(false, 'offline — retrying'); }
}

function setLive(on, label) {
  $('live-dot').className = 'dot ' + (on ? 'on' : 'off');
  $('live-label').textContent = label;
}

function applyState(state) {
  const newIds = new Set(state.items.map(i => i.id));
  state.__fresh = new Set([...newIds].filter(id => !knownIds.has(id)));
  if (firstRender) { state.__fresh = new Set(); firstRender = false; }
  knownIds = newIds;
  S = state;
  render();
}

/* ---------------- render ---------------- */

function render() {
  if (!S) return;
  const md = fmtDate(S.minDate);
  $('min-date').textContent = md;
  document.querySelectorAll('.min-date-echo').forEach(el => el.textContent = md);
  $('last-poll').textContent = S.polling ? 'polling…' : 'last poll ' + timeAgo(S.lastPollAt);

  $('pct-dump').textContent = S.progress.dump + '%';
  $('pct-overall').textContent = S.progress.overall + '%';
  $('bar-dump').style.width = S.progress.dump + '%';
  $('bar-overall').style.width = S.progress.overall + '%';

  $('stat-posts').textContent = S.items.length;
  $('stat-trusted').textContent = S.items.filter(i => i.credibility === 'trusted').length;
  $('stat-next').textContent = S.polling ? 'now' : timeUntil(S.nextPollAt);

  renderMilestones($('ms-dump'));
  renderFeed();
}

const STATUS_LABEL = { locked: 'Locked', rumored: 'Rumored', 'in-progress': 'In progress', confirmed: 'Confirmed' };

function renderMilestones(ul) {
  ul.innerHTML = S.milestones.map(m => {
    const ev = m.evidence.slice(0, 3).map(e =>
      `<a href="${esc(e.url)}" target="_blank" rel="noopener">↳ ${esc(e.title)} <span class="muted">(${esc(e.sourceName)}, ${timeAgo(e.date)})</span></a>`
    ).join('');
    return `<li class="milestone">
      <div class="ms-row">
        <span class="pill ${m.status}">${STATUS_LABEL[m.status] || m.status}</span>
        <span class="ms-name">${esc(m.name)}</span>
      </div>
      <div class="ms-desc">${esc(m.desc)}</div>
      ${ev ? `<div class="ms-evidence">${ev}</div>` : ''}
    </li>`;
  }).join('');
}

function matches(item) {
  if (filter === 'trusted' && item.credibility !== 'trusted') return false;
  if (filter === 'rumours' && !['unverified', 'fake', 'old-build'].includes(item.credibility)) return false;
  if (filter === 'dump' && !(item.tags || []).includes('dump')) return false;
  if (filter === 're' && !(item.tags || []).includes('re')) return false;
  if (filter === 'pc' && !(item.tags || []).includes('pc')) return false;
  if (filter === 'emu' && !(item.tags || []).includes('emu')) return false;
  if (filter === 'cyberleek' && !(item.tags || []).includes('cyberleek')) return false;
  if (['twitter', 'reddit', 'rss', 'github'].includes(filter) && item.source !== filter) return false;
  if (query) {
    const blob = `${item.title} ${item.text} ${item.author} ${item.sourceName}`.toLowerCase();
    if (!blob.includes(query.toLowerCase())) return false;
  }
  return true;
}

const TAG_LABEL = { dump: '💾 dump', re: '🔬 reverse engineering', pc: '🖥️ pc port', emu: '🎮 emulator', cyberleek: '🥬 cyberleek', scene: '🔧 scene progress' };
const CRED_LABEL = { trusted: '🟢 trusted', community: '🟡 community', unverified: '🔴 unverified', fake: '⛔ likely fake', 'old-build': '📦 likely old build' };
const CRED_TITLE = {
  trusted: 'Known scene developer, or concrete evidence (repo / hash / screenshot / file size)',
  community: 'Established scene forum, or partially supported claim',
  unverified: 'Anonymous or rumor-language post — treat as speculation (heuristic, not fact-checking)',
  fake: 'Rumor language + technically impossible claim (e.g. PS5 firmware rollback is fuse-protected) — likely fake; excluded from milestone evidence',
  'old-build': 'Cyberleek-style release: may be authentic but outdated / unverified (Aug-2026 footage was real but old; the operation pushed a memecoin). His reported Xbox build has no exe and is unproven.'
};

function renderFeed() {
  const items = S.items.filter(matches);
  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  if (page > totalPages) page = totalPages;
  if (page < 1) page = 1;
  const slice = items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  $('feed-count').textContent = `${items.length} posts · page ${page}/${totalPages} · updated ${timeAgo(S.lastPollAt)}`;
  if (!items.length) {
    $('feed').innerHTML = `<div class="empty">No GTA VI dump / PC-port posts since release day yet.<br>The tracker keeps watching every ${S.pollMinutes} min… 🌴</div>`;
    $('pagination').innerHTML = '';
    return;
  }
  $('feed').innerHTML = slice.map(i => {
    const fresh = S.__fresh && S.__fresh.has(i.id);
    const tags = (i.tags || []).map(t => `<span class="tag ${t}">${TAG_LABEL[t] || t}</span>`).join('');
    const signals = (i.signals || []).length ? `<span class="tag signal">⚡ milestone signal</span>` : '';
    return `<article class="post${fresh ? ' fresh' : ''}">
      <div class="post-top">
        <span class="src-badge ${i.source}">${esc(i.sourceName)}</span>
        <span class="cred ${i.credibility || 'unverified'}" title="${CRED_TITLE[i.credibility] || ''}">${CRED_LABEL[i.credibility] || CRED_LABEL.unverified}</span>
        <span>${esc(i.author || '')}</span>
        <span>·</span>
        <span title="${esc(i.date)}">${timeAgo(i.date)}</span>
      </div>
      <div class="post-title"><a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.title)}</a></div>
      ${i.text ? `<div class="post-text">${esc(i.text)}</div>` : ''}
      <div class="post-tags">${tags}${signals}</div>
    </article>`;
  }).join('');
  renderPagination(totalPages);
}

function renderPagination(totalPages) {
  const el = $('pagination');
  if (totalPages <= 1) { el.innerHTML = ''; return; }
  const btn = (p, label, dis, act) =>
    `<button class="page-btn${act ? ' active' : ''}" data-page="${p}" ${dis ? 'disabled' : ''}>${label}</button>`;
  let html = btn(page - 1, '‹ Prev', page <= 1, false);
  const window = 2;
  let last = 0;
  for (let p = 1; p <= totalPages; p++) {
    if (p === 1 || p === totalPages || Math.abs(p - page) <= window) {
      if (p - last > 1) html += '<span class="page-gap">…</span>';
      html += btn(p, p, false, p === page);
      last = p;
    }
  }
  html += btn(page + 1, 'Next ›', page >= totalPages, false);
  el.innerHTML = html;
}

$('pagination').addEventListener('click', e => {
  const b = e.target.closest('.page-btn');
  if (!b || b.disabled) return;
  page = Number(b.dataset.page);
  renderFeed();
  document.querySelector('.feed-head').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

/* ---------------- interactions ---------------- */

$('chips').addEventListener('click', e => {
  const btn = e.target.closest('.chip');
  if (!btn) return;
  document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
  btn.classList.add('active');
  filter = btn.dataset.f;
  page = 1;
  renderFeed();
});

$('search').addEventListener('input', e => { query = e.target.value.trim(); page = 1; renderFeed(); });

/* keep timestamps fresh */
setInterval(() => { if (S) render(); }, 30_000);

/* static hosting: refresh data every 60s (poller runs via GitHub Actions cron) */
setInterval(fetchState, 60_000);
fetchState();
