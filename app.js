/* ============================================================
   JobHunt — frontend logic
   State machine: body.view-{feed|saved|detail} drives layout.
   Renders are surgical where possible to preserve animations.
   ============================================================ */

const API_URL = '/api/jobs';
const LS_SAVED = 'jobhunt.saved';
const LS_CACHE = 'jobhunt.cache';
const CACHE_TTL = 1000 * 60 * 30; // 30 min — UI prefers fresh, but offline-friendly

const state = {
  jobs: [],
  saved: new Set(loadSaved()),
  view: 'feed',           // 'feed' | 'saved' | 'detail'
  detailId: null,
  search: '',
  source: 'all',          // 'all' | 'RemoteOK' | 'WWR' | 'HN'
  companyFilter: null,
  loading: true,
  error: null,
  sourcesOk: null,
};

// -------------------- BOOTSTRAP --------------------

window.addEventListener('DOMContentLoaded', () => {
  wireEvents();
  renderShell();
  loadJobs();
  registerSW();
});

function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/service-worker.js').catch(() => {});
  }
}

// -------------------- DATA LOADING --------------------

async function loadJobs({ force = false } = {}) {
  // Show cached jobs immediately if we have any
  const cached = readCache();
  if (cached && !force) {
    state.jobs = cached.jobs;
    state.sourcesOk = cached.sourcesOk;
    state.loading = false;
    renderCurrent();
  } else {
    state.loading = true;
    renderCurrent();
  }

  try {
    const r = await fetch(API_URL, { cache: force ? 'reload' : 'default' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    state.jobs = data.jobs || [];
    state.sourcesOk = data.sourcesOk || null;
    state.error = null;
    writeCache(data);
  } catch (err) {
    if (!cached) state.error = err.message || 'Failed to load jobs';
  } finally {
    state.loading = false;
    document.getElementById('refresh-btn').classList.remove('spinning');
    renderCurrent();
  }
}

function readCache() {
  try {
    const raw = localStorage.getItem(LS_CACHE);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (Date.now() - parsed.t > CACHE_TTL) return null;
    return parsed.data;
  } catch { return null; }
}

function writeCache(data) {
  try {
    localStorage.setItem(LS_CACHE, JSON.stringify({ t: Date.now(), data }));
  } catch {}
}

function loadSaved() {
  try { return JSON.parse(localStorage.getItem(LS_SAVED) || '[]'); }
  catch { return []; }
}

function persistSaved() {
  localStorage.setItem(LS_SAVED, JSON.stringify([...state.saved]));
}

// -------------------- EVENT WIRING --------------------

function wireEvents() {
  // Search input
  const input = document.getElementById('search-input');
  const wrap = document.getElementById('search-wrap');
  input.addEventListener('input', () => {
    state.search = input.value.trim().toLowerCase();
    wrap.classList.toggle('has-value', !!input.value);
    renderFeed();
  });
  document.getElementById('search-clear').addEventListener('click', () => {
    input.value = '';
    state.search = '';
    wrap.classList.remove('has-value');
    renderFeed();
    input.focus();
  });

  // Source chips
  document.getElementById('source-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    document.querySelectorAll('#source-chips .chip').forEach((c) => c.classList.remove('active'));
    chip.classList.add('active');
    state.source = chip.dataset.source;
    renderFeed();
  });

  // Company filter clear
  document.getElementById('company-filter-clear').addEventListener('click', () => {
    state.companyFilter = null;
    updateCompanyFilterBar();
    renderFeed();
  });

  // Tab bar
  document.getElementById('tabbar').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    switchView(tab.dataset.view);
  });

  // Refresh
  document.getElementById('refresh-btn').addEventListener('click', () => {
    document.getElementById('refresh-btn').classList.add('spinning');
    loadJobs({ force: true });
  });

  // Card / detail click delegation
  document.getElementById('content').addEventListener('click', onContentClick);
}

function onContentClick(e) {
  const saveBtn = e.target.closest('[data-save-id]');
  if (saveBtn) {
    e.stopPropagation();
    toggleSave(saveBtn.dataset.saveId);
    return;
  }

  const companyLink = e.target.closest('[data-company]');
  if (companyLink) {
    e.stopPropagation();
    state.companyFilter = companyLink.dataset.company;
    state.source = 'all';
    document.querySelectorAll('#source-chips .chip').forEach((c) =>
      c.classList.toggle('active', c.dataset.source === 'all')
    );
    updateCompanyFilterBar();
    switchView('feed');
    document.getElementById('content').scrollTop = 0;
    return;
  }

  const back = e.target.closest('[data-back]');
  if (back) {
    switchView(state.view === 'detail' ? 'feed' : 'feed');
    return;
  }

  const card = e.target.closest('[data-job-id]');
  if (card) {
    openDetail(card.dataset.jobId);
  }
}

// -------------------- VIEW SWITCHING --------------------

function switchView(view) {
  state.view = view;
  document.body.className = 'view-' + view;
  // Update tabs (only Feed/Saved exist in the tab bar)
  document.querySelectorAll('#tabbar .tab').forEach((t) => {
    const isActive = (view === 'detail' && t.dataset.view === 'feed') ||
                     t.dataset.view === view;
    t.classList.toggle('active', isActive);
  });
  if (view === 'feed') renderFeed();
  else if (view === 'saved') renderSaved();
  document.getElementById('content').scrollTop = 0;
}

function openDetail(id) {
  state.detailId = id;
  renderDetail();
  switchView('detail');
}

// -------------------- RENDER --------------------

function renderShell() {
  updateCompanyFilterBar();
}

function renderCurrent() {
  if (state.view === 'feed') renderFeed();
  else if (state.view === 'saved') renderSaved();
  else if (state.view === 'detail') renderDetail();
}

function renderFeed() {
  const el = document.getElementById('feed-list');

  if (state.loading && !state.jobs.length) {
    el.innerHTML = skeletonHtml(6);
    return;
  }

  if (state.error && !state.jobs.length) {
    el.innerHTML = emptyHtml('⚠️', 'Could not load jobs', state.error);
    return;
  }

  const list = filterJobs(state.jobs);

  if (!list.length) {
    el.innerHTML = emptyHtml('🔍', 'No jobs match', 'Try a different search or source.');
    return;
  }

  el.innerHTML = list.map(cardHtml).join('');
}

function renderSaved() {
  const el = document.getElementById('saved-list');
  const list = state.jobs.filter((j) => state.saved.has(j.id));

  if (!list.length) {
    el.innerHTML = emptyHtml('★', 'No saved jobs yet', 'Tap the bookmark on any job to save it here.');
    return;
  }

  el.innerHTML = list.map(cardHtml).join('');
}

function renderDetail() {
  const el = document.getElementById('detail-view');
  const job = state.jobs.find((j) => j.id === state.detailId);

  if (!job) {
    el.innerHTML = `
      <button class="detail-back" data-back type="button">‹ Back</button>
      ${emptyHtml('—', 'Job not found', 'It may have been removed from the feed.')}
    `;
    return;
  }

  const sameCompany = state.jobs
    .filter((j) => j.company === job.company && j.id !== job.id)
    .slice(0, 5);

  const isSaved = state.saved.has(job.id);

  el.innerHTML = `
    <button class="detail-back" data-back type="button">‹ Back</button>
    <div class="detail-title">${esc(job.title)}</div>
    <a class="detail-company" data-company="${esc(job.company)}" href="#">${esc(job.company)}</a>
    <div class="detail-meta">
      <span class="badge src-${job.source}">${job.source}</span>
      <span>${esc(job.location)}</span>
      <span>· ${timeAgo(job.postedAt)}</span>
      ${job.salary ? `<span>· ${esc(job.salary)}</span>` : ''}
    </div>

    <div class="detail-actions">
      <a class="btn-apply" href="${esc(job.url)}" target="_blank" rel="noopener noreferrer">Apply / View</a>
      <button class="btn-save-large ${isSaved ? 'saved' : ''}" data-save-id="${job.id}" type="button" aria-label="${isSaved ? 'Unsave' : 'Save'}">
        ${bookmarkSvg(isSaved)}
      </button>
    </div>

    ${job.tags && job.tags.length ? `
      <div class="detail-section">
        <h3>Tags</h3>
        <div>${job.tags.map((t) => `<span class="detail-tag">${esc(t)}</span>`).join('')}</div>
      </div>` : ''}

    ${job.contacts && job.contacts.length ? `
      <div class="detail-section">
        <h3>Contact</h3>
        ${job.contacts.map((c) => `<a class="contact-row" href="mailto:${esc(c)}">${esc(c)}</a>`).join('')}
      </div>` : ''}

    <div class="detail-section">
      <h3>Description</h3>
      <div class="detail-desc">${esc(job.description || '(No description.)')}</div>
    </div>

    ${sameCompany.length ? `
      <div class="detail-section">
        <h3>More from ${esc(job.company)}</h3>
        ${sameCompany.map((j) => `
          <div class="same-company-card" data-job-id="${j.id}">
            <div class="card-title">${esc(j.title)}</div>
            <div class="card-meta">
              <span class="badge src-${j.source}">${j.source}</span>
              <span class="meta-text">${esc(j.location)}</span>
              <span class="meta-text">${timeAgo(j.postedAt)}</span>
            </div>
          </div>
        `).join('')}
      </div>` : ''}
  `;
}

// -------------------- FILTER --------------------

function filterJobs(jobs) {
  let list = jobs;
  if (state.source !== 'all') list = list.filter((j) => j.source === state.source);
  if (state.companyFilter) list = list.filter((j) => j.company === state.companyFilter);
  if (state.search) {
    const q = state.search;
    list = list.filter((j) =>
      (j.title || '').toLowerCase().includes(q) ||
      (j.company || '').toLowerCase().includes(q) ||
      (j.location || '').toLowerCase().includes(q) ||
      (j.tags || []).some((t) => t.toLowerCase().includes(q))
    );
  }
  return list;
}

function updateCompanyFilterBar() {
  const bar = document.getElementById('company-filter');
  const name = document.getElementById('company-filter-name');
  if (state.companyFilter) {
    bar.hidden = false;
    name.textContent = state.companyFilter;
  } else {
    bar.hidden = true;
    name.textContent = '';
  }
}

// -------------------- SAVE / UNSAVE --------------------

function toggleSave(id) {
  if (state.saved.has(id)) state.saved.delete(id);
  else state.saved.add(id);
  persistSaved();
  // Surgical update — find and update the icon in place
  document.querySelectorAll(`[data-save-id="${cssEsc(id)}"]`).forEach((btn) => {
    const nowSaved = state.saved.has(id);
    btn.classList.toggle('saved', nowSaved);
    btn.innerHTML = bookmarkSvg(nowSaved);
    btn.setAttribute('aria-label', nowSaved ? 'Unsave' : 'Save');
  });
  // If we're on the saved view, re-render to remove the card
  if (state.view === 'saved') renderSaved();
}

// -------------------- HTML BUILDERS --------------------

function cardHtml(j) {
  const isSaved = state.saved.has(j.id);
  const initial = (j.company || '?').trim().charAt(0).toUpperCase();
  const logoHtml = j.logo
    ? `<div class="card-logo"><img src="${esc(j.logo)}" alt="" loading="lazy"></div>`
    : `<div class="card-logo" style="background:${colorFromString(j.company)}">${esc(initial)}</div>`;

  return `
    <div class="card" data-job-id="${esc(j.id)}">
      <div class="card-head">
        ${logoHtml}
        <div class="card-titles">
          <div class="card-title">${esc(j.title)}</div>
          <div class="card-company">${esc(j.company)}</div>
        </div>
        <button class="card-save ${isSaved ? 'saved' : ''}" data-save-id="${esc(j.id)}" type="button" aria-label="${isSaved ? 'Unsave' : 'Save'}">
          ${bookmarkSvg(isSaved)}
        </button>
      </div>
      <div class="card-meta">
        <span class="badge src-${j.source}">${j.source}</span>
        <span class="meta-text">${esc(j.location || 'Remote')}</span>
        <span class="meta-text">${timeAgo(j.postedAt)}</span>
        ${j.salary ? `<span class="meta-text">${esc(j.salary)}</span>` : ''}
      </div>
    </div>
  `;
}

function skeletonHtml(n) {
  return Array.from({ length: n }, () => '<div class="skeleton"></div>').join('');
}

function emptyHtml(icon, title, text) {
  return `
    <div class="empty">
      <div class="empty-icon">${esc(icon)}</div>
      <div class="empty-title">${esc(title)}</div>
      <div class="empty-text">${esc(text)}</div>
    </div>
  `;
}

function bookmarkSvg(filled) {
  return `<svg viewBox="0 0 24 24" width="20" height="20" fill="${filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>`;
}

// -------------------- UTILITIES --------------------

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function cssEsc(s) {
  return String(s).replace(/(["\\])/g, '\\$1');
}

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  return `${mo}mo ago`;
}

function colorFromString(s) {
  // Deterministic muted color from company name
  let h = 0;
  for (let i = 0; i < (s || '').length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return `hsl(${hue}, 35%, 32%)`;
}
