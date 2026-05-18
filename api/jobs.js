// Vercel serverless function: aggregates jobs from multiple sources.
// Sources: RemoteOK, We Work Remotely (all categories), Hacker News
// "Who is hiring" (last 2 threads), Remotive, Arbeitnow.
// Cached 10 min at the edge so repeat loads are cheap.

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1800');

  const sources = await Promise.allSettled([
    fetchRemoteOK(),
    fetchWWR(),
    fetchHN(),
    fetchRemotive(),
    fetchArbeitnow(),
  ]);
  const labels = ['RemoteOK', 'WWR', 'HN', 'Remotive', 'Arbeitnow'];

  let jobs = [];
  const sourcesOk = {};
  const errors = {};
  sources.forEach((r, i) => {
    sourcesOk[labels[i]] = r.status === 'fulfilled';
    errors[labels[i]] = r.status === 'rejected' ? String(r.reason).slice(0, 200) : null;
    if (r.status === 'fulfilled') jobs.push(...r.value);
  });

  // Sort newest first, then dedupe (newer wins)
  jobs.sort((a, b) => (b.postedAt || 0) - (a.postedAt || 0));
  jobs = dedupe(jobs);

  res.status(200).json({
    jobs,
    counts: { total: jobs.length },
    sourcesOk,
    errors,
    fetchedAt: Date.now(),
  });
}

// -- RemoteOK ----------------------------------------------------------------

async function fetchRemoteOK() {
  const r = await fetch('https://remoteok.com/api', {
    headers: { 'User-Agent': 'JobHunt/1.0 (+https://github.com)' },
  });
  if (!r.ok) throw new Error(`RemoteOK ${r.status}`);
  const data = await r.json();
  return data.slice(1).map((j) => {
    const desc = j.description || '';
    const sal = parseSalary(j.salary_min, j.salary_max, j.salary || desc);
    return {
      id: 'remoteok-' + j.id,
      title: (j.position || j.title || '').trim(),
      company: (j.company || 'Unknown').trim(),
      location: prettyLocation(j.location) || 'Remote',
      locationTags: locationTags(j.location, true),
      description: cleanHtml(desc),
      descriptionHtml: desc,
      url: j.url || j.apply_url,
      source: 'RemoteOK',
      postedAt: j.date ? new Date(j.date).getTime() : Date.now(),
      tags: Array.isArray(j.tags) ? j.tags.slice(0, 8) : [],
      contacts: extractEmails(desc),
      logo: j.company_logo || null,
      salary: sal.display,
      salaryMin: sal.min,
      salaryMax: sal.max,
    };
  });
}

// -- We Work Remotely (all categories via master RSS) -----------------------

async function fetchWWR() {
  // Master feed instead of just programming → ~3x more listings
  const r = await fetch('https://weworkremotely.com/remote-jobs.rss');
  if (!r.ok) throw new Error(`WWR ${r.status}`);
  const xml = await r.text();
  return parseWWR(xml);
}

function parseWWR(xml) {
  const out = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const title = decodeXml(pick(block, 'title'));
    const link = decodeXml(pick(block, 'link'));
    const pubDate = pick(block, 'pubDate');
    const description = decodeXml(pick(block, 'description'));
    const guid = pick(block, 'guid');
    const region = decodeXml(pick(block, 'region'));

    const colonIdx = title.indexOf(':');
    const company = colonIdx > -1 ? title.slice(0, colonIdx).trim() : 'Unknown';
    const role = colonIdx > -1 ? title.slice(colonIdx + 1).trim() : title;
    const sal = parseSalary(null, null, description);

    out.push({
      id: 'wwr-' + (guid || link),
      title: role,
      company,
      location: prettyLocation(region) || 'Remote',
      locationTags: locationTags(region, true),
      description: cleanHtml(description),
      descriptionHtml: description,
      url: link,
      source: 'WWR',
      postedAt: pubDate ? new Date(pubDate).getTime() : Date.now(),
      tags: guessTags(role + ' ' + description),
      contacts: extractEmails(description),
      logo: null,
      salary: sal.display,
      salaryMin: sal.min,
      salaryMax: sal.max,
    });
  }
  return out;
}

function pick(block, tag) {
  const re = new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`);
  const m = block.match(re);
  return m ? m[1].trim() : '';
}

// -- Hacker News "Who is hiring" (last 2 threads) ---------------------------

async function fetchHN() {
  const searchRes = await fetch(
    'https://hn.algolia.com/api/v1/search?query=Ask%20HN%20Who%20is%20hiring&tags=story&hitsPerPage=10'
  );
  if (!searchRes.ok) throw new Error(`HN search ${searchRes.status}`);
  const search = await searchRes.json();

  // Take 2 most recent matching stories
  const stories = (search.hits || [])
    .filter((h) => /who is hiring/i.test(h.title || ''))
    .sort((a, b) => (b.created_at_i || 0) - (a.created_at_i || 0))
    .slice(0, 2);

  if (!stories.length) return [];

  const allComments = await Promise.all(
    stories.map(async (story) => {
      const r = await fetch(
        `https://hn.algolia.com/api/v1/search?tags=comment,story_${story.objectID}&hitsPerPage=100`
      );
      if (!r.ok) return [];
      const data = await r.json();
      return data.hits || [];
    })
  );

  return allComments.flat()
    .filter((c) => c.comment_text)
    .map((c) => {
      const text = cleanHtml(c.comment_text);
      const firstLine = text.split('\n').find((l) => l.trim()) || '';
      const parts = firstLine.split('|').map((s) => s.trim()).filter(Boolean);

      const company = parts[0] || c.author || 'Unknown';
      const role = parts[1] || 'See description';
      const locationStr = parts.slice(2, 4).join(' · ') || 'See description';
      const sal = parseSalary(null, null, text);

      return {
        id: 'hn-' + c.objectID,
        title: role.slice(0, 120),
        company: company.slice(0, 80),
        location: prettyLocation(locationStr),
        locationTags: locationTags(locationStr, /remote/i.test(text)),
        description: text,
        descriptionHtml: c.comment_text,
        url: `https://news.ycombinator.com/item?id=${c.objectID}`,
        source: 'HN',
        postedAt: (c.created_at_i || 0) * 1000,
        tags: guessTags(text),
        contacts: extractEmails(text),
        logo: null,
        salary: sal.display,
        salaryMin: sal.min,
        salaryMax: sal.max,
      };
    });
}

// -- Remotive (public JSON API) ---------------------------------------------

async function fetchRemotive() {
  const r = await fetch('https://remotive.com/api/remote-jobs?limit=200');
  if (!r.ok) throw new Error(`Remotive ${r.status}`);
  const data = await r.json();
  return (data.jobs || []).map((j) => {
    const desc = j.description || '';
    const sal = parseSalary(null, null, j.salary || desc);
    return {
      id: 'remotive-' + j.id,
      title: (j.title || '').trim(),
      company: (j.company_name || 'Unknown').trim(),
      location: prettyLocation(j.candidate_required_location) || 'Remote',
      locationTags: locationTags(j.candidate_required_location, true),
      description: cleanHtml(desc),
      descriptionHtml: desc,
      url: j.url,
      source: 'Remotive',
      postedAt: j.publication_date ? new Date(j.publication_date).getTime() : Date.now(),
      tags: Array.isArray(j.tags) ? j.tags.slice(0, 8) : guessTags(j.title + ' ' + desc),
      contacts: extractEmails(desc),
      logo: j.company_logo || j.company_logo_url || null,
      salary: sal.display,
      salaryMin: sal.min,
      salaryMax: sal.max,
    };
  });
}

// -- Arbeitnow (public JSON API, EU-focused) --------------------------------

async function fetchArbeitnow() {
  const r = await fetch('https://www.arbeitnow.com/api/job-board-api');
  if (!r.ok) throw new Error(`Arbeitnow ${r.status}`);
  const data = await r.json();
  return (data.data || []).map((j) => {
    const desc = j.description || '';
    const sal = parseSalary(null, null, desc);
    const isRemote = !!j.remote;
    return {
      id: 'arbeitnow-' + (j.slug || j.id || Math.random().toString(36).slice(2)),
      title: (j.title || '').trim(),
      company: (j.company_name || 'Unknown').trim(),
      location: prettyLocation(j.location) || (isRemote ? 'Remote' : 'Europe'),
      locationTags: locationTags(j.location, isRemote).concat(['europe']),
      description: cleanHtml(desc),
      descriptionHtml: desc,
      url: j.url,
      source: 'Arbeitnow',
      postedAt: j.created_at ? j.created_at * 1000 : Date.now(),
      tags: Array.isArray(j.tags) ? j.tags.slice(0, 8) : guessTags(j.title + ' ' + desc),
      contacts: extractEmails(desc),
      logo: null,
      salary: sal.display,
      salaryMin: sal.min,
      salaryMax: sal.max,
    };
  });
}

// -- Dedup -------------------------------------------------------------------

function dedupe(jobs) {
  const seen = new Set();
  const out = [];
  for (const j of jobs) {
    const key = normKey(j.company, j.title);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(j);
  }
  return out;
}

function normKey(company, title) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return norm(company) + '::' + norm(title);
}

// -- Utilities ---------------------------------------------------------------

function extractEmails(text) {
  if (!text) return [];
  const cleaned = cleanHtml(text);
  const matches = cleaned.match(/[\w.+%-]+@[\w.-]+\.[A-Za-z]{2,}/g) || [];
  return [...new Set(matches)].slice(0, 5);
}

function cleanHtml(s) {
  if (!s) return '';
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeXml(s) {
  if (!s) return '';
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function parseSalary(min, max, text) {
  let lo = toNum(min);
  let hi = toNum(max);

  if (!lo && !hi && text) {
    const t = String(text);
    const range = t.match(/\$?\s?(\d{1,3})\s?k\s?[-–to]+\s?\$?\s?(\d{1,3})\s?k/i);
    if (range) { lo = +range[1] * 1000; hi = +range[2] * 1000; }
    else {
      const rangeFull = t.match(/\$\s?(\d{2,3}),(\d{3})\s?[-–to]+\s?\$?\s?(\d{2,3}),(\d{3})/);
      if (rangeFull) {
        lo = +(rangeFull[1] + rangeFull[2]);
        hi = +(rangeFull[3] + rangeFull[4]);
      } else {
        const single = t.match(/\$\s?(\d{1,3})\s?k(?!\s?[-–])/i) ||
                       t.match(/\$\s?(\d{2,3}),(\d{3})(?!\s?[-–])/);
        if (single) {
          const v = single[2] ? +(single[1] + single[2]) : +single[1] * 1000;
          lo = v; hi = v;
        }
      }
    }
  }

  if (!lo && !hi) return { display: null, min: null, max: null };
  if (lo && hi && lo !== hi) {
    return { display: `$${kFmt(lo)}–${kFmt(hi)}`, min: lo, max: hi };
  }
  const v = lo || hi;
  return { display: `$${kFmt(v)}`, min: v, max: v };
}

function toNum(v) {
  if (v == null) return null;
  const n = +v;
  return Number.isFinite(n) && n > 0 ? n : null;
}

function kFmt(n) {
  if (n >= 1000) return Math.round(n / 1000) + 'k';
  return String(n);
}

function prettyLocation(loc) {
  if (!loc) return null;
  const s = String(loc).trim();
  if (!s) return null;
  return s.replace(/[\|]/g, ' · ').slice(0, 60);
}

function locationTags(loc, isRemote) {
  const tags = [];
  if (isRemote || /remote/i.test(loc || '')) tags.push('remote');
  const s = String(loc || '').toLowerCase();
  if (/\busa?\b|united states|us only|us-only|us[- ]based/.test(s)) tags.push('us');
  if (/europe|eu only|emea|germany|france|spain|italy|netherlands|uk|united kingdom/.test(s)) tags.push('europe');
  if (/worldwide|anywhere|global/.test(s)) tags.push('worldwide');
  return tags;
}

const TAG_DICT = [
  'react','vue','svelte','angular','next.js','typescript','javascript','node',
  'python','django','flask','fastapi','ruby','rails','go','golang','rust',
  'java','kotlin','swift','c++','c#','.net','php','laravel','elixir','phoenix',
  'aws','gcp','azure','kubernetes','docker','terraform','postgres','mysql',
  'mongodb','redis','graphql','rest','ai','ml','llm','data','devops','sre',
  'mobile','ios','android','frontend','backend','fullstack','senior','staff','principal'
];
function guessTags(text) {
  if (!text) return [];
  const t = text.toLowerCase();
  const hits = [];
  for (const tag of TAG_DICT) {
    const re = new RegExp(`\\b${tag.replace(/[+#.]/g, '\\$&')}\\b`, 'i');
    if (re.test(t)) hits.push(tag);
    if (hits.length >= 6) break;
  }
  return hits;
}
