const tabList = document.getElementById('tab-list');
const trendSection = document.getElementById('trend-section');
const pageMeta = document.getElementById('page-meta');

let trendsData = [];
let fetchedAt = null;
let activeIndex = 0;

/**
 * Decodeert HTML-entities (bv. &#233; -> é) die in de RSS-teksten voorkomen.
 */
function decodeHtmlEntities(text) {
  const el = document.createElement('textarea');
  el.innerHTML = text ?? '';
  return el.value;
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return '';
  return date.toLocaleString('nl-NL', {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Geeft terug hoe lang geleden dateStr was, bv. "12 minuten geleden".
 */
function formatRelativeTime(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return '';

  const diffMinutes = Math.floor((Date.now() - date.getTime()) / 60000);
  if (diffMinutes < 1) return 'zojuist ververst';
  if (diffMinutes < 60) {
    return `${diffMinutes} ${diffMinutes === 1 ? 'minuut' : 'minuten'} geleden ververst`;
  }

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours} uur geleden ververst`;
  }

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays} ${diffDays === 1 ? 'dag' : 'dagen'} geleden ververst`;
}

function updatePageMeta() {
  if (!fetchedAt) return;
  pageMeta.textContent = formatRelativeTime(fetchedAt);
  pageMeta.title = `Ververst op ${formatDate(fetchedAt)}`;
}

function renderArticle(article) {
  const li = document.createElement('li');
  li.className = 'article-card';

  const source = document.createElement('span');
  source.className = 'article-source';
  source.textContent = decodeHtmlEntities(article.source);

  const title = document.createElement('a');
  title.className = 'article-title';
  title.href = article.url;
  title.target = '_blank';
  title.rel = 'noopener noreferrer';
  title.textContent = decodeHtmlEntities(article.title);

  li.append(source, title);

  if (article.description) {
    const description = document.createElement('p');
    description.className = 'article-description';
    description.textContent = decodeHtmlEntities(article.description);
    li.append(description);
  }

  if (article.publishedDate) {
    const date = document.createElement('span');
    date.className = 'article-date';
    date.textContent = formatDate(article.publishedDate);
    li.append(date);
  }

  return li;
}

function renderTabs() {
  tabList.innerHTML = '';

  trendsData.forEach((trend, index) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'tab' + (index === activeIndex ? ' active' : '');
    tab.textContent = decodeHtmlEntities(trend.keyword);
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', index === activeIndex ? 'true' : 'false');
    tab.addEventListener('click', () => {
      if (activeIndex === index) return;
      activeIndex = index;
      renderTabs();
      renderActiveTrend();
    });
    tabList.append(tab);
  });
}

function renderActiveTrend() {
  const trend = trendsData[activeIndex];
  trendSection.innerHTML = '';

  if (!trend) {
    renderError('Geen trending data gevonden.');
    return;
  }

  const header = document.createElement('div');
  header.className = 'trend-header';

  const title = document.createElement('h1');
  title.className = 'trend-title';
  title.textContent = decodeHtmlEntities(trend.keyword);

  header.append(title);

  if (trend.trafficLabel) {
    const volume = document.createElement('span');
    volume.className = 'trend-volume';
    volume.textContent = `${trend.trafficLabel} zoekopdrachten`;
    header.append(volume);
  }

  const list = document.createElement('ul');
  list.className = 'articles';

  if (trend.articles && trend.articles.length > 0) {
    trend.articles.forEach((article) => list.append(renderArticle(article)));
  } else {
    const empty = document.createElement('p');
    empty.className = 'loading';
    empty.textContent = 'Geen nieuwsartikelen gevonden voor deze zoekterm.';
    list.append(empty);
  }

  trendSection.append(header, list);
}

function renderError(message) {
  pageMeta.textContent = '';
  pageMeta.removeAttribute('title');
  tabList.innerHTML = '';
  trendSection.innerHTML = `<p class="error">${message}</p>`;
}

async function loadTrends() {
  try {
    const response = await fetch('data.json', { cache: 'no-store' });
    if (!response.ok) {
      throw new Error('data.json niet gevonden');
    }
    const data = await response.json();
    trendsData = data.trends ?? [];
    fetchedAt = data.fetchedAt;

    if (trendsData.length === 0) {
      throw new Error('Geen trending termen in data.json');
    }

    updatePageMeta();
    renderTabs();
    renderActiveTrend();
  } catch (error) {
    renderError(
      'Geen trending data gevonden. Draai "npm run fetch" om data.json te genereren.'
    );
    console.error(error);
  }
}

loadTrends();
setInterval(updatePageMeta, 60_000);
