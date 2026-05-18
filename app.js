/* ============================================================
   JobHunt v2 — frontend logic
   State machine: body.view-{feed|saved|applied|settings|detail} + body.theme-{dark|light}
   Features: filters, sort, applied tracking, settings, recent search,
   share, vibrate, toast, pull-to-refresh, match score, action sheet.
   ============================================================ */

const API_URL = '/api/jobs';

const LS = {
  saved: 'jobhunt.saved',
  applied: 'jobhunt.applied',
  cache: 'jobhunt.cache',
  filters: 'jobhunt.filters',
  theme: 'jobhunt.theme',
  recents: 'jobhunt.recents',
  sourcePrefs: 'jobhunt.sourcePrefs',
};

const CACHE_TTL = 1000 * 60 * 30;

const KNOWN_SOURCES = ['RemoteOK', 'WWR', 'HN', 'Remotive', 'Arbeitnow', 'Himalayas', 'TheMuse'];

const DEFAULT_FILTERS = {
  sort: 'newest',
  posted: '',           // '' | 'day' | 'week' | 'month'
  loc: '',              // '' | 'remote' | 'us' | 'europe' | 'worldwide'
  salary: 0,            // 0 | 50000 | 100000 | 150000 | 200000
  sources: [...KNOWN_SOURCES],
};

// Merge persisted filters with defaults, auto-enabling sources that didn't
// exist when the user's preferences were saved.
function loadFilters() {
  const loaded = loadJson(LS.filters, {});
  const merged = { ...DEFAULT_FILTERS, ...loaded };
  if (Array.isArray(loaded.sources)) {
    const newOnes = KNOWN_SOURCES.filter((s) => !loaded.sources.includes(s));
    merged.sources = [...new Set([...loaded.sources, ...newOnes])];
  }
  return merged;
}

const state = {
  jobs: [],
  saved: new Set(loadJson(LS.saved, [])),
  applied: new Set(loadJson(LS.applied, [])),
  view: 'feed',
  detailId: null,
  actionJobId: null,
  search: '',
  source: 'all',
  filters: loadFilters(),
  draftFilters: null,
  companyFilter: null,
  recents: loadJson(LS.recents, []),
  sourcePrefs: {
    ...Object.fromEntries(KNOWN_SOURCES.map((s) => [s, true])),
    ...loadJson(LS.sourcePrefs, {}),
  },
  theme: localStorage.getItem(LS.theme) || 'system',
  loading: true,
  error: null,
  sourcesOk: null,
};

// -------------------- BOOT --------------------

window.addEventListener('DOMContentLoaded', () => {
  applyTheme(state.theme);
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

// -------------------- DATA --------------------

async function loadJobs({ force = false } = {}) {
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
    else toast('Could not refresh — showing cached jobs.', 'error');
  } finally {
    state.loading = false;
    document.getElementById('refresh-btn').classList.remove('spinning');
    document.body.classList.remove('ptr-refreshing');
    renderShell();
    renderCurrent();
  }
}

function readCache() {
  try {
    const raw = localStorage.getItem(LS.cache);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (Date.now() - parsed.t > CACHE_TTL) return null;
    return parsed.data;
  } catch { return null; }
}

function writeCache(data) {
  try { localStorage.setItem(LS.cache, JSON.stringify({ t: Date.now(), data })); }
  catch {}
}

function loadJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}

function persist(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch {}
}

// -------------------- THEME --------------------

function applyTheme(theme) {
  state.theme = theme;
  let resolved = theme;
  if (theme === 'system') {
    resolved = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  document.body.classList.remove('theme-dark', 'theme-light');
  document.body.classList.add('theme-' + resolved);
  localStorage.setItem(LS.theme, theme);

  // Update theme-color meta to match
  const tc = document.querySelector('meta[name="theme-color"]:not([media])') ||
             document.querySelector('meta[name="theme-color"]');
  if (tc) tc.content = resolved === 'light' ? '#f6f7fb' : '#0a0e1a';
}

// Listen for system changes if user picked "system"
matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (state.theme === 'system') applyTheme('system');
});

// -------------------- EVENT WIRING --------------------

function wireEvents() {
  const input = document.getElementById('search-input');
  const wrap = document.getElementById('search-wrap');

  input.addEventListener('input', () => {
    state.search = input.value.trim().toLowerCase();
    wrap.classList.toggle('has-value', !!input.value);
    renderSuggestions();
    renderFeed();
  });
  input.addEventListener('focus', renderSuggestions);
  input.addEventListener('blur', () => setTimeout(hideSuggestions, 150));
  input.addEventListener('change', () => {
    if (state.search.length > 1) addRecent(state.search);
  });

  document.getElementById('search-clear').addEventListener('click', () => {
    input.value = '';
    state.search = '';
    wrap.classList.remove('has-value');
    hideSuggestions();
    renderFeed();
    input.focus();
  });

  // Source quick chips
  document.getElementById('source-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    document.querySelectorAll('#source-chips .chip').forEach((c) => c.classList.remove('active'));
    chip.classList.add('active');
    state.source = chip.dataset.source;
    vibrate(8);
    renderFeed();
  });

  // Filter pills clear
  document.getElementById('filter-pills').addEventListener('click', (e) => {
    const close = e.target.closest('[data-clear]');
    if (!close) return;
    const key = close.dataset.clear;
    if (key === 'company') state.companyFilter = null;
    else if (key === 'source') state.source = 'all';
    else state.filters[key] = DEFAULT_FILTERS[key];
    persist(LS.filters, state.filters);
    renderShell();
    renderFeed();
  });

  // Tab bar
  document.getElementById('tabbar').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    vibrate(8);
    switchView(tab.dataset.view);
  });

  // Refresh
  document.getElementById('refresh-btn').addEventListener('click', () => {
    document.getElementById('refresh-btn').classList.add('spinning');
    vibrate(12);
    loadJobs({ force: true });
  });

  // Filter button
  document.getElementById('filter-btn').addEventListener('click', openFilterSheet);

  // Filter sheet controls
  document.getElementById('filter-cancel').addEventListener('click', closeSheets);
  document.getElementById('filter-reset').addEventListener('click', () => {
    state.draftFilters = { ...DEFAULT_FILTERS };
    syncFilterSheet();
  });
  document.getElementById('filter-apply').addEventListener('click', applyFilters);

  document.getElementById('sort-control').addEventListener('click', (e) => {
    const b = e.target.closest('[data-sort]');
    if (!b) return;
    state.draftFilters.sort = b.dataset.sort;
    syncFilterSheet();
  });
  document.getElementById('posted-chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-posted]');
    if (!b) return;
    state.draftFilters.posted = b.dataset.posted;
    syncFilterSheet();
  });
  document.getElementById('location-chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-loc]');
    if (!b) return;
    state.draftFilters.loc = b.dataset.loc;
    syncFilterSheet();
  });
  document.getElementById('salary-chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-salary]');
    if (!b) return;
    state.draftFilters.salary = +b.dataset.salary;
    syncFilterSheet();
  });
  document.getElementById('source-multi').addEventListener('click', (e) => {
    const b = e.target.closest('[data-src]');
    if (!b) return;
    const src = b.dataset.src;
    const set = new Set(state.draftFilters.sources);
    if (set.has(src)) set.delete(src); else set.add(src);
    if (set.size === 0) set.add(src); // never allow zero sources
    state.draftFilters.sources = [...set];
    syncFilterSheet();
  });

  // Action sheet
  document.getElementById('action-sheet').addEventListener('click', (e) => {
    const b = e.target.closest('[data-action]');
    if (!b) return;
    handleAction(b.dataset.action);
  });

  // Backdrop closes sheets
  document.getElementById('sheet-backdrop').addEventListener('click', closeSheets);

  // Settings view
  document.getElementById('theme-control').addEventListener('click', (e) => {
    const b = e.target.closest('[data-theme]');
    if (!b) return;
    applyTheme(b.dataset.theme);
    renderSettings();
    vibrate(8);
  });
  document.getElementById('clear-cache').addEventListener('click', () => {
    localStorage.removeItem(LS.cache);
    toast('Refreshing…', 'success');
    loadJobs({ force: true });
  });
  document.getElementById('clear-saved').addEventListener('click', () => {
    if (state.saved.size === 0) { toast('No saved jobs.'); return; }
    if (!confirm('Clear all saved jobs?')) return;
    state.saved.clear();
    persist(LS.saved, [...state.saved]);
    toast('Saved jobs cleared.', 'success');
    renderCurrent();
    renderBadges();
  });
  document.getElementById('clear-applied').addEventListener('click', () => {
    if (state.applied.size === 0) { toast('No applied jobs.'); return; }
    if (!confirm('Clear applied list?')) return;
    state.applied.clear();
    persist(LS.applied, [...state.applied]);
    toast('Applied list cleared.', 'success');
    renderCurrent();
    renderBadges();
  });

  // Content (cards, details, settings sources, etc.)
  document.getElementById('content').addEventListener('click', onContentClick);

  // Pull to refresh
  wirePullToRefresh();
}

function onContentClick(e) {
  const more = e.target.closest('[data-more-id]');
  if (more) {
    e.stopPropagation();
    openActionSheet(more.dataset.moreId);
    return;
  }

  const saveBtn = e.target.closest('[data-save-id]');
  if (saveBtn) {
    e.stopPropagation();
    toggleSave(saveBtn.dataset.saveId);
    return;
  }

  const appliedBtn = e.target.closest('[data-applied-id]');
  if (appliedBtn) {
    e.stopPropagation();
    toggleApplied(appliedBtn.dataset.appliedId);
    return;
  }

  const companyLink = e.target.closest('[data-company]');
  if (companyLink) {
    e.stopPropagation();
    e.preventDefault();
    state.companyFilter = companyLink.dataset.company;
    state.source = 'all';
    document.querySelectorAll('#source-chips .chip').forEach((c) =>
      c.classList.toggle('active', c.dataset.source === 'all')
    );
    switchView('feed');
    renderShell();
    document.getElementById('content').scrollTop = 0;
    toast(`Filtered to ${state.companyFilter}`);
    return;
  }

  const tagLink = e.target.closest('[data-tag]');
  if (tagLink) {
    e.stopPropagation();
    const tag = tagLink.dataset.tag;
    const input = document.getElementById('search-input');
    input.value = tag;
    state.search = tag.toLowerCase();
    document.getElementById('search-wrap').classList.add('has-value');
    switchView('feed');
    renderFeed();
    addRecent(tag);
    return;
  }

  const sourceToggle = e.target.closest('[data-src-pref]');
  if (sourceToggle) {
    const src = sourceToggle.dataset.srcPref;
    state.sourcePrefs[src] = !state.sourcePrefs[src];
    persist(LS.sourcePrefs, state.sourcePrefs);
    vibrate(8);
    renderSettings();
    renderCurrent();
    return;
  }

  const back = e.target.closest('[data-back]');
  if (back) {
    switchView('feed');
    return;
  }

  const card = e.target.closest('[data-job-id]');
  if (card) openDetail(card.dataset.jobId);
}

// -------------------- VIEW SWITCHING --------------------

function switchView(view) {
  state.view = view;
  document.body.className = `view-${view} theme-${getResolvedTheme()}`;
  document.querySelectorAll('#tabbar .tab').forEach((t) => {
    const isActive = (view === 'detail' && t.dataset.view === 'feed') ||
                     t.dataset.view === view;
    t.classList.toggle('active', isActive);
  });
  hideSuggestions();
  renderCurrent();
  document.getElementById('content').scrollTop = 0;
}

function getResolvedTheme() {
  if (state.theme === 'system') {
    return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  return state.theme;
}

function openDetail(id) {
  state.detailId = id;
  renderDetail();
  switchView('detail');
}

// -------------------- FILTER SHEET --------------------

function openFilterSheet() {
  state.draftFilters = { ...state.filters, sources: [...state.filters.sources] };
  syncFilterSheet();
  document.getElementById('filter-sheet').hidden = false;
  requestAnimationFrame(() => {
    document.body.classList.add('sheet-open', 'filter-sheet-open');
  });
}

function syncFilterSheet() {
  const f = state.draftFilters;
  setActive('sort-control', `[data-sort="${f.sort}"]`);
  setActive('posted-chips', `[data-posted="${f.posted}"]`);
  setActive('location-chips', `[data-loc="${f.loc}"]`);
  setActive('salary-chips', `[data-salary="${f.salary}"]`);

  // Render source-multi dynamically from KNOWN_SOURCES (so new sources auto-show)
  const present = new Set(state.jobs.map((j) => j.source));
  const sources = KNOWN_SOURCES.filter((s) => present.has(s) || state.sourcesOk?.[s]);
  for (const s of present) if (!sources.includes(s)) sources.push(s);
  document.getElementById('source-multi').innerHTML = sources.map((s) => `
    <button class="filter-chip ${f.sources.includes(s) ? 'active' : ''}" data-src="${esc(s)}" type="button">${esc(s)}</button>
  `).join('');

  // Preview count
  const previewState = { ...state, filters: f, source: 'all' };
  const count = filterJobs(state.jobs, previewState).length;
  document.getElementById('filter-count-preview').textContent =
    count === 1 ? '1 job' : `${count} jobs`;
}

function setActive(containerId, selector) {
  const container = document.getElementById(containerId);
  container.querySelectorAll('.seg-btn, .filter-chip').forEach((b) => b.classList.remove('active'));
  const match = container.querySelector(selector);
  if (match) match.classList.add('active');
}

function applyFilters() {
  state.filters = { ...state.draftFilters };
  persist(LS.filters, state.filters);
  vibrate(10);
  closeSheets();
  renderShell();
  renderFeed();
}

function closeSheets() {
  document.body.classList.remove('sheet-open', 'filter-sheet-open', 'action-sheet-open');
  setTimeout(() => {
    document.getElementById('filter-sheet').hidden = true;
    document.getElementById('action-sheet').hidden = true;
  }, 280);
}

// -------------------- ACTION SHEET --------------------

function openActionSheet(jobId) {
  state.actionJobId = jobId;
  const job = state.jobs.find((j) => j.id === jobId);
  if (!job) return;
  const isSaved = state.saved.has(jobId);
  const isApplied = state.applied.has(jobId);
  document.getElementById('action-save-label').textContent = isSaved ? 'Unsave' : 'Save';
  document.getElementById('action-applied-label').textContent = isApplied ? 'Unmark applied' : 'Mark as applied';
  document.querySelector('[data-action="save"]').classList.toggle('is-active', isSaved);
  document.querySelector('[data-action="applied"]').classList.toggle('is-active', isApplied);

  document.getElementById('action-sheet').hidden = false;
  requestAnimationFrame(() => {
    document.body.classList.add('sheet-open', 'action-sheet-open');
  });
}

function handleAction(action) {
  const jobId = state.actionJobId;
  const job = state.jobs.find((j) => j.id === jobId);
  closeSheets();
  if (!job && action !== 'cancel') return;

  if (action === 'save') toggleSave(jobId);
  else if (action === 'applied') toggleApplied(jobId);
  else if (action === 'share') shareJob(job);
  else if (action === 'open') window.open(job.url, '_blank', 'noopener,noreferrer');
}

// -------------------- SAVE / APPLIED --------------------

function toggleSave(id) {
  const willSave = !state.saved.has(id);
  if (willSave) state.saved.add(id); else state.saved.delete(id);
  persist(LS.saved, [...state.saved]);
  vibrate(willSave ? [10, 30, 10] : 8);
  toast(willSave ? 'Saved' : 'Removed from saved', willSave ? 'success' : null);
  refreshSaveIcons(id);
  if (state.view === 'saved') renderSaved();
  renderBadges();
}

function toggleApplied(id) {
  const willApply = !state.applied.has(id);
  if (willApply) state.applied.add(id); else state.applied.delete(id);
  persist(LS.applied, [...state.applied]);
  vibrate(willApply ? [10, 30, 10] : 8);
  toast(willApply ? 'Marked as applied ✓' : 'Removed from applied', willApply ? 'success' : null);
  refreshAppliedIcons(id);
  renderCurrent();
  renderBadges();
}

function refreshSaveIcons(id) {
  document.querySelectorAll(`[data-save-id="${cssEsc(id)}"]`).forEach((btn) => {
    const saved = state.saved.has(id);
    btn.classList.toggle('saved', saved);
    btn.innerHTML = bookmarkSvg(saved);
    btn.setAttribute('aria-label', saved ? 'Unsave' : 'Save');
  });
}
function refreshAppliedIcons(id) {
  document.querySelectorAll(`[data-applied-id="${cssEsc(id)}"]`).forEach((btn) => {
    const applied = state.applied.has(id);
    btn.classList.toggle('applied', applied);
    btn.innerHTML = checkSvg(applied);
    btn.setAttribute('aria-label', applied ? 'Unmark applied' : 'Mark as applied');
  });
}

// -------------------- SHARE --------------------

async function shareJob(job) {
  if (!job) return;
  const shareData = {
    title: `${job.title} at ${job.company}`,
    text: `${job.title} · ${job.company} (${job.source})`,
    url: job.url,
  };
  try {
    if (navigator.share) {
      await navigator.share(shareData);
    } else {
      await navigator.clipboard.writeText(job.url);
      toast('Link copied', 'success');
    }
  } catch (e) {
    if (e.name !== 'AbortError') toast('Could not share');
  }
}

// -------------------- VIBRATE --------------------

function vibrate(pattern) {
  if (navigator.vibrate) {
    try { navigator.vibrate(pattern); } catch {}
  }
}

// -------------------- TOAST --------------------

let toastTimer = null;
function toast(message, kind) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = '';
  if (kind) el.classList.add(kind);
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

// -------------------- RECENT SEARCHES --------------------

function addRecent(term) {
  if (!term || term.length < 2) return;
  const t = term.trim();
  state.recents = [t, ...state.recents.filter((r) => r.toLowerCase() !== t.toLowerCase())].slice(0, 6);
  persist(LS.recents, state.recents);
}

function renderSuggestions() {
  const el = document.getElementById('search-suggestions');
  const q = state.search;
  let items = [];

  if (q) {
    // Top matches from current jobs (titles + companies)
    const seen = new Set();
    for (const j of state.jobs) {
      const cmp = j.company || '';
      const ttl = j.title || '';
      if (cmp.toLowerCase().includes(q) && !seen.has('c:' + cmp)) {
        seen.add('c:' + cmp);
        items.push({ kind: 'company', text: cmp });
      } else if (ttl.toLowerCase().includes(q) && !seen.has('t:' + ttl)) {
        seen.add('t:' + ttl);
        items.push({ kind: 'title', text: ttl });
      }
      if (items.length >= 6) break;
    }
  } else if (state.recents.length) {
    items = state.recents.map((t) => ({ kind: 'recent', text: t }));
  }

  if (!items.length) { hideSuggestions(); return; }

  el.innerHTML = items.map((it) => `
    <button class="suggest-item" data-suggest="${esc(it.text)}" type="button">
      <span class="suggest-icon">${suggestIcon(it.kind)}</span>
      <span>${esc(it.text)}</span>
      <span class="suggest-meta">${it.kind === 'recent' ? 'recent' : it.kind}</span>
    </button>
  `).join('');
  el.hidden = false;

  el.querySelectorAll('[data-suggest]').forEach((b) => {
    b.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const v = b.dataset.suggest;
      const input = document.getElementById('search-input');
      input.value = v;
      state.search = v.toLowerCase();
      document.getElementById('search-wrap').classList.add('has-value');
      addRecent(v);
      hideSuggestions();
      renderFeed();
    });
  });
}

function hideSuggestions() {
  document.getElementById('search-suggestions').hidden = true;
}

function suggestIcon(kind) {
  if (kind === 'recent') return '↻';
  if (kind === 'company') return '◯';
  return '⌖';
}

// -------------------- PULL TO REFRESH --------------------

function wirePullToRefresh() {
  const content = document.getElementById('content');
  let startY = 0;
  let pulling = false;

  content.addEventListener('touchstart', (e) => {
    if (content.scrollTop > 0) return;
    startY = e.touches[0].clientY;
    pulling = true;
  }, { passive: true });

  content.addEventListener('touchmove', (e) => {
    if (!pulling) return;
    const dy = e.touches[0].clientY - startY;
    if (dy > 12) document.body.classList.add('ptr-active');
    else document.body.classList.remove('ptr-active');
  }, { passive: true });

  content.addEventListener('touchend', (e) => {
    if (!pulling) return;
    pulling = false;
    const dy = (e.changedTouches[0]?.clientY ?? 0) - startY;
    document.body.classList.remove('ptr-active');
    if (dy > 80) {
      vibrate(15);
      document.body.classList.add('ptr-refreshing');
      loadJobs({ force: true });
    }
  }, { passive: true });
}

// -------------------- RENDER --------------------

function renderShell() {
  renderSourceChips();
  renderFilterPills();
  renderFilterBadge();
  renderBadges();
}

function renderSourceChips() {
  const el = document.getElementById('source-chips');
  // Union of canonical sources + whatever the API actually returned this load
  const present = new Set(state.jobs.map((j) => j.source));
  const sources = KNOWN_SOURCES.filter((s) => present.has(s) || state.sourcesOk?.[s]);
  // Include any extras (future-proofing if API adds sources later)
  for (const s of present) if (!sources.includes(s)) sources.push(s);

  const current = state.source;
  el.innerHTML = `
    <button class="chip ${current === 'all' ? 'active' : ''}" data-source="all" type="button">All</button>
    ${sources.map((s) => `
      <button class="chip ${current === s ? 'active' : ''}" data-source="${esc(s)}" type="button">${esc(s)}</button>
    `).join('')}
  `;
}

function renderCurrent() {
  if (state.view === 'feed') renderFeed();
  else if (state.view === 'saved') renderSaved();
  else if (state.view === 'applied') renderApplied();
  else if (state.view === 'detail') renderDetail();
  else if (state.view === 'settings') renderSettings();
}

function renderBadges() {
  const bs = document.getElementById('badge-saved');
  const ba = document.getElementById('badge-applied');
  if (state.saved.size) { bs.hidden = false; bs.textContent = state.saved.size; }
  else bs.hidden = true;
  if (state.applied.size) { ba.hidden = false; ba.textContent = state.applied.size; }
  else ba.hidden = true;
}

function renderFilterBadge() {
  const btn = document.getElementById('filter-btn');
  const badge = document.getElementById('filter-count');
  const f = state.filters;
  const active = [
    f.posted !== DEFAULT_FILTERS.posted,
    f.loc !== DEFAULT_FILTERS.loc,
    f.salary !== DEFAULT_FILTERS.salary,
    f.sources.length !== DEFAULT_FILTERS.sources.length,
    f.sort !== DEFAULT_FILTERS.sort,
  ].filter(Boolean).length;
  btn.classList.toggle('has-filters', active > 0);
  if (active > 0) { badge.hidden = false; badge.textContent = active; }
  else badge.hidden = true;
}

function renderFilterPills() {
  const el = document.getElementById('filter-pills');
  const pills = [];
  if (state.companyFilter) pills.push({ key: 'company', label: state.companyFilter });
  if (state.source !== 'all') pills.push({ key: 'source', label: state.source });
  if (state.filters.posted) pills.push({ key: 'posted', label: postedLabel(state.filters.posted) });
  if (state.filters.loc) pills.push({ key: 'loc', label: capitalize(state.filters.loc) });
  if (state.filters.salary) pills.push({ key: 'salary', label: `$${state.filters.salary / 1000}k+` });
  if (state.filters.sort !== 'newest') pills.push({ key: 'sort', label: `Sort: ${state.filters.sort}` });

  if (!pills.length) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = pills.map((p) => `
    <span class="pill">${esc(p.label)}<button data-clear="${p.key}" aria-label="Clear">×</button></span>
  `).join('');
}

function renderFeed() {
  const el = document.getElementById('feed-list');

  if (state.loading && !state.jobs.length) {
    el.innerHTML = skeletonHtml(6);
    return;
  }

  if (state.error && !state.jobs.length) {
    el.innerHTML = emptyHtml('alert', 'Could not load jobs', state.error);
    return;
  }

  const list = filterJobs(state.jobs, state);

  if (!list.length) {
    el.innerHTML = emptyHtml('search', 'No matches', 'Try clearing some filters or changing your search.');
    return;
  }

  el.innerHTML = list.map(cardHtml).join('');
}

function renderSaved() {
  const el = document.getElementById('saved-list');
  const list = state.jobs.filter((j) => state.saved.has(j.id));

  if (!list.length) {
    el.innerHTML = emptyHtml('bookmark', 'No saved jobs', 'Tap the bookmark on any job to keep it here for later.');
    return;
  }
  el.innerHTML = list.map(cardHtml).join('');
}

function renderApplied() {
  const el = document.getElementById('applied-list');
  const list = state.jobs.filter((j) => state.applied.has(j.id));

  if (!list.length) {
    el.innerHTML = emptyHtml('check', 'No applications tracked', 'Mark jobs you\'ve applied to from the card menu to see them here.');
    return;
  }
  el.innerHTML = list.map(cardHtml).join('');
}

function renderSettings() {
  // Theme buttons
  document.querySelectorAll('#theme-control [data-theme]').forEach((b) => {
    b.classList.toggle('active', b.dataset.theme === state.theme);
  });

  // Source toggles — dynamic from known + loaded sources
  const srcEl = document.getElementById('settings-sources');
  const srcCounts = state.jobs.reduce((acc, j) => {
    acc[j.source] = (acc[j.source] || 0) + 1; return acc;
  }, {});
  const present = new Set(state.jobs.map((j) => j.source));
  const sources = KNOWN_SOURCES.filter((s) => present.has(s) || state.sourcesOk?.[s]);
  for (const s of present) if (!sources.includes(s)) sources.push(s);
  srcEl.innerHTML = sources.map((s) => {
    const on = state.sourcePrefs[s] !== false;
    const ok = state.sourcesOk?.[s];
    const count = srcCounts[s] || 0;
    return `
      <div class="source-toggle" data-src-pref="${s}">
        <div class="src-info">
          <div class="src-label"><span class="badge src-${s}">${s}</span></div>
          <div class="src-status">${ok === false ? '⚠ Unreachable' : count + ' jobs loaded'}</div>
        </div>
        <div class="toggle-switch ${on ? 'on' : ''}"></div>
      </div>
    `;
  }).join('');
}

function renderDetail() {
  const el = document.getElementById('detail-view');
  const job = state.jobs.find((j) => j.id === state.detailId);

  if (!job) {
    el.innerHTML = `
      <button class="detail-back" data-back type="button">‹ Back</button>
      ${emptyHtml('alert', 'Job not found', 'It may have been removed from the feed.')}
    `;
    return;
  }

  const sameCompany = state.jobs.filter((j) => j.company === job.company && j.id !== job.id).slice(0, 5);
  const isSaved = state.saved.has(job.id);
  const isApplied = state.applied.has(job.id);
  const initial = (job.company || '?').trim().charAt(0).toUpperCase();
  const logoHtml = job.logo
    ? `<img src="${esc(job.logo)}" alt="">`
    : `<span style="background:${colorFromString(job.company)};width:100%;height:100%;display:flex;align-items:center;justify-content:center;">${esc(initial)}</span>`;
  const match = matchScore(job);

  el.innerHTML = `
    <button class="detail-back" data-back type="button">‹ Back</button>

    <div class="detail-head">
      <div class="detail-logo">${logoHtml}</div>
      <div class="detail-headinfo">
        <div class="detail-title">${esc(job.title)}</div>
        <a class="detail-company" data-company="${esc(job.company)}" href="#">${esc(job.company)}</a>
      </div>
    </div>

    <div class="detail-source-row">
      <span class="badge src-${job.source}">${job.source}</span>
      ${match > 50 ? `<span class="match-badge">${match}% match</span>` : ''}
    </div>

    <div class="detail-meta">
      ${metaItem('location', esc(job.location))}
      ${metaItem('clock', timeAgo(job.postedAt))}
      ${job.salary ? metaItem('cash', esc(job.salary), 'salary') : ''}
    </div>

    <div class="detail-actions">
      <a class="btn-apply" href="${esc(job.url)}" target="_blank" rel="noopener noreferrer">Apply / View →</a>
      <button class="btn-circ ${isSaved ? 'saved' : ''}" data-save-id="${job.id}" type="button" aria-label="${isSaved ? 'Unsave' : 'Save'}">
        ${bookmarkSvg(isSaved)}
      </button>
      <button class="btn-circ ${isApplied ? 'applied' : ''}" data-applied-id="${job.id}" type="button" aria-label="${isApplied ? 'Unmark applied' : 'Mark applied'}">
        ${checkSvg(isApplied)}
      </button>
    </div>

    ${job.tags && job.tags.length ? `
      <div class="detail-section">
        <h3>Skills</h3>
        <div class="detail-tags">${job.tags.map((t) => `<button class="detail-tag" data-tag="${esc(t)}" type="button">${esc(t)}</button>`).join('')}</div>
      </div>` : ''}

    ${job.contacts && job.contacts.length ? `
      <div class="detail-section">
        <h3>Contact</h3>
        ${job.contacts.map((c) => `
          <a class="contact-row" href="mailto:${esc(c)}">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>
            ${esc(c)}
          </a>`).join('')}
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
            <div class="card-meta" style="margin-top:6px;">
              <span class="badge src-${j.source}">${j.source}</span>
              <span class="meta-item">${esc(j.location)}</span>
              <span class="meta-item">${timeAgo(j.postedAt)}</span>
            </div>
          </div>
        `).join('')}
      </div>` : ''}
  `;
}

// -------------------- FILTER & SORT --------------------

function filterJobs(jobs, st = state) {
  let list = jobs;

  // Source preferences (applies always)
  list = list.filter((j) => st.sourcePrefs[j.source] !== false);

  // Quick chip source filter
  if (st.source && st.source !== 'all') list = list.filter((j) => j.source === st.source);

  // Filter sheet sources (subset)
  if (st.filters.sources && st.filters.sources.length < 3) {
    list = list.filter((j) => st.filters.sources.includes(j.source));
  }

  if (st.companyFilter) list = list.filter((j) => j.company === st.companyFilter);

  if (st.filters.posted) {
    const cutoff = Date.now() - postedCutoff(st.filters.posted);
    list = list.filter((j) => (j.postedAt || 0) >= cutoff);
  }

  if (st.filters.loc) {
    list = list.filter((j) => (j.locationTags || []).includes(st.filters.loc));
  }

  if (st.filters.salary > 0) {
    list = list.filter((j) => (j.salaryMin || j.salaryMax || 0) >= st.filters.salary);
  }

  if (st.search) {
    const q = st.search;
    list = list.filter((j) =>
      (j.title || '').toLowerCase().includes(q) ||
      (j.company || '').toLowerCase().includes(q) ||
      (j.location || '').toLowerCase().includes(q) ||
      (j.tags || []).some((t) => t.toLowerCase().includes(q))
    );
  }

  // Sort
  const sort = st.filters.sort || 'newest';
  if (sort === 'newest') {
    list = [...list].sort((a, b) => (b.postedAt || 0) - (a.postedAt || 0));
  } else if (sort === 'salary') {
    list = [...list].sort((a, b) => (b.salaryMax || b.salaryMin || -1) - (a.salaryMax || a.salaryMin || -1));
  } else if (sort === 'company') {
    list = [...list].sort((a, b) => (a.company || '').localeCompare(b.company || ''));
  }

  return list;
}

function postedCutoff(key) {
  const day = 1000 * 60 * 60 * 24;
  return key === 'day' ? day : key === 'week' ? 7 * day : key === 'month' ? 30 * day : Infinity;
}

function postedLabel(key) {
  return key === 'day' ? 'Last 24h' : key === 'week' ? 'This week' : key === 'month' ? 'This month' : '';
}

// -------------------- MATCH SCORE --------------------

function matchScore(job) {
  // Heuristic based on tag overlap with user's saved jobs.
  if (!state.saved.size) return 0;
  const savedJobs = state.jobs.filter((j) => state.saved.has(j.id));
  if (!savedJobs.length) return 0;

  const tagCounts = {};
  for (const s of savedJobs) {
    for (const t of s.tags || []) tagCounts[t.toLowerCase()] = (tagCounts[t.toLowerCase()] || 0) + 1;
  }
  const topTags = Object.keys(tagCounts);
  if (!topTags.length) return 0;

  const jobTags = (job.tags || []).map((t) => t.toLowerCase());
  if (!jobTags.length) return 0;

  const overlap = jobTags.filter((t) => topTags.includes(t)).length;
  return Math.min(100, Math.round((overlap / Math.max(jobTags.length, 1)) * 100));
}

// -------------------- HTML BUILDERS --------------------

function cardHtml(j) {
  const isSaved = state.saved.has(j.id);
  const isApplied = state.applied.has(j.id);
  const initial = (j.company || '?').trim().charAt(0).toUpperCase();
  const logoHtml = j.logo
    ? `<img src="${esc(j.logo)}" alt="" loading="lazy">`
    : `<span style="background:${colorFromString(j.company)};width:100%;height:100%;display:flex;align-items:center;justify-content:center;">${esc(initial)}</span>`;
  const match = matchScore(j);
  const tagsHtml = (j.tags || []).slice(0, 3).map((t) =>
    `<button class="tag-chip" data-tag="${esc(t)}" type="button">${esc(t)}</button>`
  ).join('');

  return `
    <div class="card ${isApplied ? 'is-applied' : ''}" data-job-id="${esc(j.id)}">
      <div class="card-actions-top">
        <button class="icon-btn ${isSaved ? 'saved' : ''}" data-save-id="${esc(j.id)}" type="button" aria-label="${isSaved ? 'Unsave' : 'Save'}">
          ${bookmarkSvg(isSaved)}
        </button>
        <button class="icon-btn" data-more-id="${esc(j.id)}" type="button" aria-label="More">
          ${dotsSvg()}
        </button>
      </div>
      <div class="card-top">
        <div class="card-logo">${logoHtml}</div>
        <div class="card-info">
          <div class="card-source-row">
            <span class="badge src-${j.source}">${j.source}</span>
            ${match > 50 ? `<span class="match-badge">${match}%</span>` : ''}
            <span class="card-time">${timeAgo(j.postedAt)}</span>
          </div>
          <div class="card-title">${esc(j.title)}</div>
          <div class="card-company">${esc(j.company)}</div>
        </div>
      </div>
      <div class="card-meta">
        ${metaItem('location', esc(j.location || 'Remote'))}
        ${j.salary ? metaItem('cash', esc(j.salary), 'salary') : ''}
      </div>
      ${tagsHtml ? `<div class="card-tags">${tagsHtml}</div>` : ''}
    </div>
  `;
}

function metaItem(icon, text, extraClass = '') {
  const icons = {
    location: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 7-8 13-8 13s-8-6-8-13a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/></svg>',
    clock: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    cash: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M16 6a4 4 0 0 0-4-2c-2.2 0-4 1.3-4 3 0 1.7 1.8 2.5 4 3s4 1.3 4 3-1.8 3-4 3a4 4 0 0 1-4-2"/></svg>',
  };
  return `<span class="meta-item ${extraClass}">${icons[icon] || ''}${text}</span>`;
}

function skeletonHtml(n) {
  return Array.from({ length: n }, () => '<div class="skeleton"></div>').join('');
}

function emptyHtml(icon, title, text) {
  const icons = {
    alert: '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>',
    search: '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
    bookmark: '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>',
    check: '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  };
  return `
    <div class="empty">
      <div class="empty-icon">${icons[icon] || icons.alert}</div>
      <div class="empty-title">${esc(title)}</div>
      <div class="empty-text">${esc(text)}</div>
    </div>
  `;
}

function bookmarkSvg(filled) {
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="${filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>`;
}

function checkSvg(filled) {
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="${filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${filled ? '<circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-5"/>' : '<path d="M20 6 9 17l-5-5"/>'}</svg>`;
}

function dotsSvg() {
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>`;
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
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d`;
  const mo = Math.floor(d / 30);
  return `${mo}mo`;
}

function colorFromString(s) {
  let h = 0;
  for (let i = 0; i < (s || '').length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return `hsl(${hue}, 38%, 38%)`;
}

function capitalize(s) {
  return (s || '').charAt(0).toUpperCase() + (s || '').slice(1);
}
