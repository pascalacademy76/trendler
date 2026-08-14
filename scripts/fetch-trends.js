// Haalt de top 10 trending zoektermen (Google Trends NL) op plus bijbehorende
// nieuwsartikelen (Bing News) en schrijft het resultaat naar data.json.
// Draai dit script opnieuw (npm run fetch) om de data te verversen.

const TOP_N = 10;

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.join(__dirname, '..', 'data.json');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Zet een traffic-string zoals "5K+" of "1000+" om naar een getal.
 */
function parseTraffic(trafficStr) {
  if (!trafficStr) return 0;
  const cleaned = trafficStr.trim().replace(/\+/g, '');

  const kMatch = cleaned.match(/^(\d+(?:\.\d+)?)\s*K$/i);
  if (kMatch) return Math.round(parseFloat(kMatch[1]) * 1000);

  const mMatch = cleaned.match(/^(\d+(?:\.\d+)?)\s*M$/i);
  if (mMatch) return Math.round(parseFloat(mMatch[1]) * 1_000_000);

  const num = parseInt(cleaned.replace(/[^0-9]/g, ''), 10);
  return isNaN(num) ? 0 : num;
}

/**
 * Haalt de trending zoektermen op door de (server-side gerenderde) HTML van
 * trends.google.com/trending te parsen. Geeft dezelfde termen/volumes terug
 * als de website zelf, maar leunt op niet-officiële CSS-classnamen die
 * Google zonder waarschuwing kan wijzigen. Gooit een error als de structuur
 * niet meer klopt, zodat fetchTrendingTerms() kan terugvallen op de RSS-feed.
 */
async function fetchTrendingTermsFromWebsite() {
  const response = await fetch('https://trends.google.com/trending?geo=NL&hl=nl', {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept-Language': 'nl-NL,nl;q=0.9',
    },
  });

  if (!response.ok) {
    throw new Error(`Trending-pagina gaf status ${response.status}`);
  }

  const html = await response.text();
  const rows = html.match(/<tr[^>]*data-row-id="\d+"[^>]*>[\s\S]*?<\/tr>/g) ?? [];

  const items = [];
  for (const row of rows) {
    const titleMatch = row.match(/class="mZ3RIc">([^<]*)<\/div>/);
    const title = titleMatch?.[1]?.trim();
    if (!title) continue;

    const volumeMatch = row.match(/class="qNpYPd">([^<]*)<\/div>/);
    const trafficLabel = volumeMatch?.[1]?.replace(/zoekopdrachten/i, '').trim() || '0';
    const traffic = parseTraffic(trafficLabel);

    // De pagina toont per trend een "uitsplitsing" van gerelateerde zoektermen
    // (bv. "zonsverduistering" bij "hoe laat is de eclipse"). Die zijn vaak
    // beter bruikbaar als nieuws-zoekopdracht dan de letterlijke, soms erg
    // specifieke of vraag-achtige hoofdterm.
    const breakdownMatch = row.match(/class="xm9Xec">([\s\S]*?)<\/td>/);
    const breakdownHtml = breakdownMatch?.[1] ?? '';
    const relatedTerms = [...new Set([...breakdownHtml.matchAll(/data-term="([^"]+)"/g)].map((m) => m[1]))]
      .filter((term) => term.toLowerCase() !== title.toLowerCase())
      .slice(0, 2);

    items.push({ title, traffic, trafficLabel, relatedTerms });
  }

  if (items.length === 0) {
    throw new Error('Geen trending termen gevonden op de trending-pagina (structuur mogelijk gewijzigd)');
  }

  // De volgorde op de pagina zelf is Google's eigen "relevantie"-ranking
  // (houdt ook rekening met hoe snel een term nu stijgt), niet strikt het
  // zoekvolume. Sorteer expliciet op volume zodat de tabvolgorde altijd
  // overeenkomt met de getoonde volumebadges.
  return items.sort((a, b) => b.traffic - a.traffic);
}

/**
 * Haalt alle trending zoektermen op uit de Google Trends NL RSS-feed,
 * gefilterd op de laatste 4 uur en gesorteerd op traffic (hoogste eerst).
 * Dit is de stabiele, officieel aangeboden feed - gebruikt als terugval.
 */
async function fetchTrendingTermsFromRSS() {
  const response = await fetch('https://trends.google.nl/trending/rss?geo=NL', {
    headers: { 'User-Agent': USER_AGENT },
  });

  if (!response.ok) {
    throw new Error(`Google Trends RSS gaf status ${response.status}`);
  }

  const xmlText = await response.text();
  const items = [];
  const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  const now = new Date();
  let itemMatch;

  while ((itemMatch = itemRegex.exec(xmlText)) !== null) {
    const itemContent = itemMatch[1] ?? '';

    const titleMatch = itemContent.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
    const title = titleMatch?.[1]?.trim() ?? '';

    const trafficMatch = itemContent.match(/<ht:approx_traffic>([^<]+)<\/ht:approx_traffic>/);
    const trafficLabel = trafficMatch?.[1]?.trim() ?? '0';
    const traffic = parseTraffic(trafficLabel);

    const pubDateMatch = itemContent.match(/<pubDate>([^<]+)<\/pubDate>/);
    const pubDate = pubDateMatch?.[1]?.trim() ?? '';

    let hoursAgo = 999;
    if (pubDate) {
      const pubDateTime = new Date(pubDate);
      if (!isNaN(pubDateTime.getTime())) {
        hoursAgo = (now.getTime() - pubDateTime.getTime()) / (1000 * 60 * 60);
      }
    }

    if (title && title !== 'Daily Search Trends' && title !== 'Trending Searches') {
      items.push({ title, traffic, trafficLabel, pubDate, hoursAgo });
    }
  }

  const recentItems = items.filter((item) => item.hoursAgo <= 4).sort((a, b) => b.traffic - a.traffic);
  if (recentItems.length > 0) return recentItems;

  // Fallback: geen items in de laatste 4 uur, pak dan alles gesorteerd op traffic
  return items.sort((a, b) => b.traffic - a.traffic);
}

/**
 * Probeert eerst de rijkere trending-pagina; valt bij een fout terug op de
 * stabiele RSS-feed zodat het script blijft werken als Google iets wijzigt.
 */
async function fetchTrendingTerms() {
  try {
    const items = await fetchTrendingTermsFromWebsite();
    console.log(`${items.length} termen gevonden via trends.google.com/trending.`);
    return items;
  } catch (error) {
    console.warn(`Kon trending-pagina niet gebruiken (${error.message}). Terugvallen op RSS-feed...`);
    return fetchTrendingTermsFromRSS();
  }
}

/**
 * Haalt Bing News-artikelen op voor een zoekterm.
 */
async function fetchNewsArticles(keyword, maxResults = 10) {
  const encodedKeyword = encodeURIComponent(keyword);
  const rssUrl = `https://www.bing.com/news/search?q=${encodedKeyword}&format=rss&mkt=nl-NL`;

  const response = await fetch(rssUrl, {
    headers: { 'User-Agent': USER_AGENT },
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`Bing News RSS gaf status ${response.status}`);
  }

  const xmlText = await response.text();
  const articles = [];
  const seenUrls = new Set();
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let itemMatch;

  while ((itemMatch = itemRegex.exec(xmlText)) !== null) {
    const itemContent = itemMatch[1] ?? '';

    const titleMatch = itemContent.match(/<title>([\s\S]*?)<\/title>/);
    const title = titleMatch?.[1]?.trim() ?? '';

    const linkMatch = itemContent.match(/<link>([\s\S]*?)<\/link>/);
    const rawLink = linkMatch?.[1]?.trim() ?? '';
    const url = extractRealUrl(rawLink);

    const sourceMatch = itemContent.match(/<News:Source>([\s\S]*?)<\/News:Source>/i);
    const source = sourceMatch?.[1]?.trim() ?? '';

    const pubDateMatch = itemContent.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
    const pubDateStr = pubDateMatch?.[1]?.trim() ?? '';

    const descMatch = itemContent.match(/<description>([\s\S]*?)<\/description>/);
    const description = descMatch?.[1]?.trim() ?? null;

    if (title && url && source && !seenUrls.has(url)) {
      seenUrls.add(url);
      const publishedDate = pubDateStr && !isNaN(new Date(pubDateStr).getTime()) ? pubDateStr : null;
      articles.push({ title, source, url, publishedDate, description });
    }
  }

  articles.sort((a, b) => new Date(b.publishedDate ?? 0) - new Date(a.publishedDate ?? 0));
  return articles.slice(0, maxResults);
}

function extractRealUrl(bingLink) {
  const decoded = bingLink.replace(/&amp;/g, '&');
  const urlMatch = decoded.match(/url=(https?[^&]+)/);
  if (urlMatch) {
    try {
      return decodeURIComponent(urlMatch[1]);
    } catch {
      return urlMatch[1];
    }
  }
  return bingLink;
}

// Bekende, landelijke Nederlandse nieuwstitels. Puur gebruikt om artikelen
// van deze bronnen voorrang te geven in de sortering - filtert niets weg.
const KNOWN_OUTLETS = [
  'nos',
  'nu.nl',
  'de telegraaf',
  'telegraaf',
  'algemeen dagblad',
  'de volkskrant',
  'volkskrant',
  'nrc',
  'rtl nieuws',
  'het parool',
  'parool',
  'trouw',
  'bnnvara',
  'ed.nl',
  'eindhovens dagblad',
];

function isKnownOutlet(source) {
  const lower = source.toLowerCase();
  return KNOWN_OUTLETS.some((outlet) => lower === outlet || lower.startsWith(`${outlet} `));
}

/**
 * Haalt artikelen op voor de hoofdterm én (indien beschikbaar) de eerste
 * gerelateerde term, voegt ze samen (zonder duplicaten op URL) en sorteert
 * zo dat bekende landelijke titels bovenaan komen, anders op meest recent.
 */
async function fetchNewsArticlesForTrend(term, maxResults = 10) {
  const queries = [term.title, ...(term.relatedTerms ?? [])];
  const seenUrls = new Set();
  const combined = [];

  for (const query of queries) {
    const results = await fetchNewsArticles(query, maxResults);
    for (const article of results) {
      if (!seenUrls.has(article.url)) {
        seenUrls.add(article.url);
        combined.push(article);
      }
    }
    if (combined.length >= maxResults * 2) break;
  }

  combined.sort((a, b) => {
    const knownDiff = Number(isKnownOutlet(b.source)) - Number(isKnownOutlet(a.source));
    if (knownDiff !== 0) return knownDiff;
    return new Date(b.publishedDate ?? 0) - new Date(a.publishedDate ?? 0);
  });

  return combined.slice(0, maxResults);
}

async function main() {
  console.log('Trending termen ophalen...');
  const trendingTerms = await fetchTrendingTerms();

  if (trendingTerms.length === 0) {
    throw new Error('Geen trending termen gevonden.');
  }

  const topTerms = trendingTerms.slice(0, TOP_N);
  const trends = [];

  for (const term of topTerms) {
    console.log(`Nieuwsartikelen ophalen voor "${term.title}" (${term.trafficLabel})...`);
    const articles = await fetchNewsArticlesForTrend(term, 10);
    console.log(`${articles.length} artikelen gevonden voor "${term.title}".`);

    trends.push({
      keyword: term.title,
      trafficLabel: term.trafficLabel,
      articles,
    });
  }

  const data = {
    fetchedAt: new Date().toISOString(),
    trends,
  };

  await writeFile(OUTPUT_PATH, JSON.stringify(data, null, 2), 'utf-8');
  console.log(`Weggeschreven naar ${OUTPUT_PATH}`);
}

main().catch((error) => {
  console.error('Fout bij het ophalen van trending data:', error.message);
  process.exit(1);
});
