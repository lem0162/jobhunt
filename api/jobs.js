// Vercel serverless function: aggregates jobs from RemoteOK, We Work Remotely, and HN "Who is hiring".
// Cached 10 min at the edge so repeat loads are cheap.

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1800');

  const [remoteok, wwr, hn] = await Promise.allSettled([
    fetchRemoteOK(),
    fetchWWR(),
    fetchHN(),
  ]);

  const jobs = [];
  if (remoteok.status === 'fulfilled') jobs.push(...remoteok.value);
  if (wwr.status === 'fulfilled') jobs.push(...wwr.value);
  if (hn.status === 'fulfilled') jobs.push(...hn.value);

  jobs.sort((a, b) => (b.postedAt || 0) - (a.postedAt || 0));

  res.status(200).json({
    jobs,
    sourcesOk: {
      RemoteOK: remoteok.status === 'fulfilled',
      WWR: wwr.status === 'fulfilled',
      HN: hn.status === 'fulfilled',
    },
    errors: {
      RemoteOK: remoteok.status === 'rejected' ? String(remoteok.reason) : null,
      WWR: wwr.status === 'rejected' ? String(wwr.reason) : null,
      HN: hn.status === 'rejected' ? String(hn.reason) : null,
    },
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
  // First entry is API metadata, skip it
  return data.slice(1).map((j) => ({
    id: 'remoteok-' + j.id,
    title: (j.position || j.title || '').trim(),
    company: (j.company || 'Unknown').trim(),
    location: j.location || 'Remote',
    description: cleanHtml(j.description || ''),
    descriptionHtml: j.description || '',
    url: j.url || j.apply_url,
    source: 'RemoteOK',
    postedAt: j.date ? new Date(j.date).getTime() : Date.now(),
    tags: Array.isArray(j.tags) ? j.tags.slice(0, 6) : [],
    contacts: extractEmails(j.description || ''),
    logo: j.company_logo || null,
    salary: j.salary || (j.salary_min ? `$${j.salary_min}+` : null),
  }));
}

// -- We Work Remotely (RSS) --------------------------------------------------

async function fetchWWR() {
  const r = await fetch('https://weworkremotely.com/categories/remote-programming-jobs.rss');
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

    // WWR title format: "Company: Job Title"
    const colonIdx = title.indexOf(':');
    const company = colonIdx > -1 ? title.slice(0, colonIdx).trim() : 'Unknown';
    const role = colonIdx > -1 ? title.slice(colonIdx + 1).trim() : title;

    out.push({
      id: 'wwr-' + (guid || link),
      title: role,
      company,
      location: region || 'Remote',
      description: cleanHtml(description),
      descriptionHtml: description,
      url: link,
      source: 'WWR',
      postedAt: pubDate ? new Date(pubDate).getTime() : Date.now(),
      tags: [],
      contacts: extractEmails(description),
      logo: null,
      salary: null,
    });
  }
  return out;
}

function pick(block, tag) {
  const re = new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`);
  const m = block.match(re);
  return m ? m[1].trim() : '';
}

// -- Hacker News "Who is hiring" --------------------------------------------

async function fetchHN() {
  // Find the most recent "Ask HN: Who is hiring?" story
  const searchRes = await fetch(
    'https://hn.algolia.com/api/v1/search?query=Ask%20HN%20Who%20is%20hiring&tags=story&hitsPerPage=5'
  );
  if (!searchRes.ok) throw new Error(`HN search ${searchRes.status}`);
  const search = await searchRes.json();
  const story = (search.hits || []).find((h) =>
    /who is hiring/i.test(h.title || '')
  );
  if (!story) return [];

  // Pull top-level comments on that story
  const commentsRes = await fetch(
    `https://hn.algolia.com/api/v1/search?tags=comment,story_${story.objectID}&hitsPerPage=100`
  );
  if (!commentsRes.ok) throw new Error(`HN comments ${commentsRes.status}`);
  const comments = await commentsRes.json();

  return (comments.hits || [])
    .filter((c) => c.comment_text)
    .map((c) => {
      const text = cleanHtml(c.comment_text);
      const firstLine = text.split('\n').find((l) => l.trim()) || '';
      const parts = firstLine.split('|').map((s) => s.trim()).filter(Boolean);

      const company = parts[0] || c.author || 'Unknown';
      const role = parts[1] || 'See description';
      const location = parts.slice(2, 4).join(' · ') || 'See description';

      return {
        id: 'hn-' + c.objectID,
        title: role.slice(0, 120),
        company: company.slice(0, 80),
        location,
        description: text,
        descriptionHtml: c.comment_text,
        url: `https://news.ycombinator.com/item?id=${c.objectID}`,
        source: 'HN',
        postedAt: (c.created_at_i || 0) * 1000,
        tags: [],
        contacts: extractEmails(text),
        logo: null,
        salary: null,
      };
    });
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
