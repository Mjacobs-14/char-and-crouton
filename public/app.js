const DISHES = {
  burger: { board: 'Burgers', plural: 'burgers', one: 'burger', other: 'caesar', otherEmoji: '🥗' },
  caesar: { board: 'Caesars', plural: 'Caesars', one: 'Caesar', other: 'burger', otherEmoji: '🍔' },
};
const VERDICTS = [
  [10, 'Perfection'],
  [9, 'Legendary'],
  [8, 'Seriously good'],
  [7, 'Solid'],
  [6, 'Decent'],
  [5, 'Mid'],
  [4, 'Disappointing'],
  [2.5, 'Rough'],
  [1, 'Call the authorities'],
];

const $ = (id) => document.getElementById(id);
const esc = (text) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fmt = (score) => score.toFixed(1);
// "McDonald's" and "mcdonalds" should find each other, as should "Cafe" and "Café".
const norm = (text) => text.normalize('NFD').replace(/[̀-ͯ'’.]/g, '').toLowerCase();

function stored(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function store(key, value) {
  try { localStorage.setItem(key, value); } catch { /* the app still works, it just forgets */ }
}

const state = {
  people: [],
  restaurants: [],
  ratings: [],
  dish: stored('dish') === 'caesar' ? 'caesar' : 'burger',
  view: ['map', 'try'].includes(stored('view')) ? stored('view') : 'board',
  mapSelected: null,
  wishes: [],
  query: '',
  person: '',
  area: '',
  filtersOpen: false,
  folds: { critics: true }, // which collapsible sections are open
  lists: [],
  sort: 'top',
  me: stored('me') || '',
  open: new Set(),
};
let lastSnapshot = '';

async function api(path, options) {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Could not reach the server.');
  return body;
}

function applyData(data) {
  state.people = data.people;
  state.wishes = data.wishes;
  state.restaurants = data.restaurants;
  state.ratings = data.ratings;
  lastSnapshot = JSON.stringify(data);
  render();
}

async function refresh() {
  try {
    const data = await api('/api/state');
    if (JSON.stringify(data) !== lastSnapshot) applyData(data);
  } catch {
    // Keep showing what we have; the next refresh will try again.
  }
}

function matches(restaurant, query) {
  const haystack = norm(`${restaurant.name} ${restaurant.area}`);
  return norm(query).split(/\s+/).filter(Boolean).every((word) => haystack.includes(word));
}

function average(ratings) {
  return ratings.reduce((sum, r) => sum + r.score, 0) / ratings.length;
}

function allRatingsFor(restaurantId, dish) {
  return state.ratings
    .filter((r) => r.restaurantId === restaurantId && r.dish === dish)
    .sort((a, b) => b.score - a.score);
}

function ratingsFor(restaurantId, dish) {
  return allRatingsFor(restaurantId, dish).filter((r) => !state.person || r.rater === state.person);
}

const NO_AREA = '__none';
const areaKey = (restaurant) => restaurant.area.toLowerCase() || NO_AREA;

// Person and location filters re-rank the board ("best in West Loop"), but
// searching doesn't, so a search can't turn #7 into #1.
function buildBoard() {
  const rated = [];
  const unrated = [];
  for (const restaurant of state.restaurants) {
    if (state.area && areaKey(restaurant) !== state.area) continue;
    const ratings = ratingsFor(restaurant.id, state.dish);
    if (ratings.length) rated.push({ restaurant, ratings, avg: average(ratings) });
    // Places only saved to Want to Try stay off the boards until someone has eaten there.
    else if (!state.person && state.ratings.some((r) => r.restaurantId === restaurant.id)) unrated.push(restaurant);
  }
  rated.sort((a, b) => b.avg - a.avg || b.ratings.length - a.ratings.length);
  rated.forEach((entry, i) => {
    const tied = i > 0 && fmt(rated[i - 1].avg) === fmt(entry.avg);
    entry.rank = tied ? rated[i - 1].rank : i + 1;
  });
  return { rated, unrated };
}

const byName = (a, b) => a.name.localeCompare(b.name);

function sortEntries(entries) {
  const list = [...entries];
  if (state.sort === 'count') list.sort((a, b) => b.ratings.length - a.ratings.length || b.avg - a.avg);
  if (state.sort === 'name') list.sort((a, b) => byName(a.restaurant, b.restaurant));
  return list;
}

function initials(name) {
  return esc(name.trim().charAt(0).toUpperCase());
}

// Chains can have several locations in one city; only then is the street needed on the board.
function locationLabel(restaurant) {
  const hasTwin = state.restaurants.some((r) => r.id !== restaurant.id
    && norm(r.name) === norm(restaurant.name) && norm(r.area) === norm(restaurant.area));
  return hasTwin && restaurant.address ? `${restaurant.address}, ${restaurant.area}` : restaurant.area;
}

function needsLocation(restaurant) {
  if (!restaurant.area) return false;
  return new Set(state.restaurants.map(areaKey)).size > 1 || locationLabel(restaurant) !== restaurant.area;
}

function reviewHtml(rating) {
  const mine = state.me && rating.rater.toLowerCase() === state.me.toLowerCase();
  const date = new Date(rating.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  return `
    <div class="review">
      <span class="avatar" aria-hidden="true">${initials(rating.rater)}</span>
      <div>
        <span class="review-name">${esc(rating.rater)}</span><span class="review-date">${esc(date)}</span>
        ${rating.note ? `<p class="review-note">${esc(rating.note)}</p>` : ''}
        ${rating.photo ? `<a class="review-photo" href="/photos/${esc(rating.photo)}.jpg" target="_blank" rel="noopener"><img src="/photos/${esc(rating.photo)}.jpg" alt="${esc(rating.rater)}'s photo" loading="lazy"></a>` : ''}
        ${mine ? `<div class="review-actions">
          <button class="link" type="button" data-edit="${rating.id}">Edit</button>
          <button class="link" type="button" data-delete="${rating.id}">Delete</button>
        </div>` : ''}
      </div>
      <span class="review-score">${fmt(rating.score)}</span>
    </div>`;
}

function rowHtml(entry) {
  const { restaurant, ratings, avg, rank } = entry;
  const dish = DISHES[state.dish];
  const isOpen = state.open.has(restaurant.id);
  const other = ratingsFor(restaurant.id, dish.other);
  const everyone = allRatingsFor(restaurant.id, state.dish);
  const count = state.person
    ? `Group ${fmt(average(everyone))}`
    : ratings.map((r) => `${r.rater}\u00a0${fmt(r.score)}`).join(' · ');
  const scoreLabel = state.person ? `${state.person}'s grade` : 'Average grade';
  const iRatedThis = !state.me || everyone.some((r) => isMe(r.rater));
  const meta = [
    count,
    state.person || iRatedThis ? '' : `${state.me} hasn't rated`,
    other.length ? `${dish.otherEmoji}\u00a0${fmt(average(other))}` : '',
  ].filter(Boolean).map(esc).join(' · ');
  // Location is noise when everything's in one city, so it only shows once it helps.
  const moreMeta = needsLocation(restaurant) ? esc(locationLabel(restaurant)) : '';
  const iRated = state.me && everyone.some((r) => r.rater.toLowerCase() === state.me.toLowerCase());
  const photo = ratings.find((r) => r.photo);
  const isSingle = !state.person && ratings.length === 1;
  const place = `
          <span class="place-name">${esc(restaurant.name)}</span>
          <span class="place-meta">${meta}</span>
          ${moreMeta ? `<span class="place-meta">${moreMeta}</span>` : ''}
          ${listTagsHtml(restaurant, state.dish)}`;
  return `
    <article class="row${rank === 1 ? ' first' : ''}${isSingle ? ' single' : ''}">
      <button class="row-main" type="button" data-toggle="${restaurant.id}" aria-expanded="${isOpen}">
        <span class="rank">${rank}</span>
        ${photo
    ? `<span class="place-with-thumb"><img class="row-thumb" src="/photos/${esc(photo.photo)}.jpg" alt="" loading="lazy"><span class="place">${place}</span></span>`
    : `<span class="place">${place}</span>`}
        <span class="score-cell">
          <span class="score" aria-label="${esc(scoreLabel)} ${fmt(avg)} out of 10">${fmt(avg)}</span>
          ${isSingle ? '<span class="score-note">1 rating</span>' : ''}
        </span>
        <svg class="chevron" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      ${isOpen ? `<div class="detail">
        ${listLinksHtml(restaurant, state.dish)}
        ${restaurant.address || restaurant.area ? `<p class="place-address">${[restaurant.address, restaurant.area].filter(Boolean).map(esc).join(', ')}</p>` : ''}
        ${ratings.map(reviewHtml).join('')}
        <div class="detail-foot">
          ${iRated ? '' : `<button class="ghost" type="button" data-rate="${restaurant.id}">Add your rating</button>`}
          <button class="link" type="button" data-edit-restaurant="${restaurant.id}">Edit restaurant</button>
          ${iRated ? '' : wishToggleHtml(restaurant.id)}
        </div>
      </div>` : ''}
    </article>`;
}

function unratedHtml(restaurant) {
  const dish = DISHES[state.dish];
  return `
    <div class="unrated">
      <span class="place">
        <span class="place-name">${esc(restaurant.name)}</span>
        ${restaurant.area ? `<span class="place-meta">${esc(locationLabel(restaurant))}</span>` : ''}
      </span>
      <button class="ghost" type="button" data-rate="${restaurant.id}" aria-label="Rate the ${esc(dish.one)} at ${esc(restaurant.name)}">Rate it</button>
    </div>`;
}

function emptyHtml() {
  const dish = DISHES[state.dish];
  if (state.person || state.area) {
    return `
      <div class="empty">
        <h2>Nothing matches</h2>
        <p>No ${esc(dish.plural)} fit those filters yet.</p>
        <button class="primary" type="button" data-clear>Clear filters</button>
      </div>`;
  }
  if (state.query.trim()) {
    return `
      <div class="empty">
        <h2>No "${esc(state.query.trim())}" yet</h2>
        <p>Nobody has rated anything there. You could be first.</p>
        <button class="primary" type="button" data-new="${esc(state.query.trim())}">Add it and rate it</button>
      </div>`;
  }
  return `
    <div class="empty">
      <h2>The board is empty</h2>
      <p>Rate the first ${esc(dish.one)} and start the argument.</p>
    </div>`;
}

function renderMasthead(rated) {
  const dish = DISHES[state.dish];
  const onMap = state.view === 'map';
  const onTry = state.view === 'try';
  const activeTab = state.view === 'board' ? state.dish : state.view;
  document.body.dataset.dish = activeTab;
  $('boardTitle').textContent = onMap ? 'The Map' : onTry ? 'Want to Try' : dish.board;
  $('rateButton').textContent = onTry ? 'Save a place' : onMap ? 'Add a rating' : `Rate a ${dish.one}`;
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.setAttribute('aria-pressed', String(tab.dataset.dish === activeTab));
  });
  if (onTry) {
    const saved = wishGroups().length;
    $('boardStat').textContent = saved === 1 ? '1 place on the list.' : `${saved} places on the list.`;
  } else if (onMap) {
    const pinned = mapEntries().filter((e) => hasCoords(e.restaurant)).length;
    $('boardStat').textContent = pinned === 1 ? '1 spot on the map.' : `${pinned} spots on the map.`;
  } else if (rated.length) {
    const leader = rated[0];
    const count = rated.length === 1 ? '1 spot' : `${rated.length} spots`;
    const who = state.person ? ` for ${state.person}` : '';
    $('boardStat').textContent = `${leader.restaurant.name} leads${who} at ${fmt(leader.avg)} · ${count}`;
  } else {
    $('boardStat').textContent = state.person || state.area ? `No ${dish.plural} rated with those filters.` : `No ${dish.plural} rated yet.`;
  }
  $('whoButton').innerHTML = state.me
    ? `<span class="avatar" aria-hidden="true">${initials(state.me)}</span>${esc(state.me)}`
    : 'Set your name';
  $('whoButton').setAttribute('aria-label', state.me ? `Rating as ${state.me}. Change name` : 'Set your name');
}

// Only rebuild the options when they change, so a background refresh can't close an open dropdown.
function setOptions(select, html, value) {
  if (select.dataset.html !== html) {
    select.innerHTML = html;
    select.dataset.html = html;
  }
  select.value = value;
  select.classList.toggle('active', Boolean(value));
}

function renderFilters() {
  if (!state.people.includes(state.person)) state.person = '';
  setOptions(
    $('personFilter'),
    `<option value="">Everyone</option>${state.people.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join('')}`,
    state.person,
  );

  const areas = new Map();
  for (const restaurant of state.restaurants) {
    if (restaurant.area && !areas.has(areaKey(restaurant))) areas.set(areaKey(restaurant), restaurant.area);
  }
  const sorted = [...areas].sort((a, b) => a[1].localeCompare(b[1]));
  const hasNoArea = state.restaurants.some((r) => !r.area);
  if (state.area && !areas.has(state.area) && !(state.area === NO_AREA && hasNoArea)) state.area = '';
  setOptions(
    $('areaFilter'),
    `<option value="">All locations</option>${sorted.map(([key, label]) => `<option value="${esc(key)}">${esc(label)}</option>`).join('')}${hasNoArea ? `<option value="${NO_AREA}">No location set</option>` : ''}`,
    state.area,
  );
  $('areaOptions').innerHTML = sorted.map(([, label]) => `<option value="${esc(label)}"></option>`).join('');

  const active = [state.person, state.area].filter(Boolean).length;
  $('filterToggle').textContent = active ? `Filters (${active})` : 'Filters';
  $('filterToggle').classList.toggle('active', active > 0);
  $('filterToggle').setAttribute('aria-expanded', String(state.filtersOpen));
  $('filters').classList.toggle('open', state.filtersOpen);
}

function render() {
  renderFilters();
  const { rated, unrated } = buildBoard();
  renderMasthead(rated);
  const onMap = state.view === 'map';
  $('board').hidden = onMap;
  $('mapView').hidden = !onMap;
  if (onMap) {
    renderMap();
    return;
  }
  if (state.view === 'try') {
    $('board').innerHTML = wishListHtml();
    return;
  }
  const shownRated = sortEntries(rated.filter((e) => matches(e.restaurant, state.query)));
  const shownUnrated = unrated.filter((r) => matches(r, state.query)).sort(byName);

  let html = shownRated.map(rowHtml).join('');
  if (shownUnrated.length) {
    html += foldHtml('untried', `Haven't tried the ${esc(DISHES[state.dish].one)} (${shownUnrated.length})`, shownUnrated.map(unratedHtml).join(''));
  }
  const extras = criticsHtml(rated.filter((e) => !state.area || areaKey(e.restaurant) === state.area)) + picksHtml(state.dish);
  $('board').innerHTML = (html || emptyHtml()) + extras;
}

/* Published "best of" lists. Burgers only for now, kept in public/lists.json. */
const listKey = (name) => norm(name).replace(/^the\s+/, '').replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
const entryKeys = (entry) => [entry.name, ...(entry.aliases || [])].map(listKey);

function listsFor(restaurant, dish) {
  const key = listKey(restaurant.name);
  return state.lists.filter((list) => list.dish === dish && list.entries.some((e) => entryKeys(e).includes(key)));
}

function listTagsHtml(restaurant, dish) {
  const lists = listsFor(restaurant, dish);
  if (!lists.length) return '';
  return `<span class="list-tags">${lists.map((l) => `<span class="list-tag">${esc(l.tag)}</span>`).join('')}</span>`;
}

function listLinksHtml(restaurant, dish) {
  const lists = listsFor(restaurant, dish);
  if (!lists.length) return '';
  const links = lists.map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.name)}</a>`);
  return `<p class="list-links">On the lists: ${links.join(' · ')}</p>`;
}

function foldHtml(fold, summary, body) {
  // Searching should reveal what's inside, so a search opens every section.
  const open = state.folds[fold] || state.query.trim();
  return `<details class="untried" data-fold="${fold}"${open ? ' open' : ''}>
    <summary>${summary}</summary>
    ${body}
  </details>`;
}

// Lists rank burgers but don't score them, so "agree" means: on a list, and above
// this board's own average.
function criticsHtml(rated) {
  if (state.dish !== 'burger' || !state.lists.length || rated.length < 2 || state.query.trim()) return '';
  const mean = average(rated.map((entry) => ({ score: entry.avg })));
  const line = (entry) => `
    <li><span>${esc(entry.restaurant.name)}</span><span class="critic-score">${fmt(entry.avg)}</span></li>`;
  const group = (title, entries) => (entries.length
    ? `<h3>${title}</h3><ul>${entries.map(line).join('')}</ul>`
    : '');
  const listed = (entry) => listsFor(entry.restaurant, 'burger').length > 0;
  const body = [
    group('You and the critics agree', rated.filter((e) => listed(e) && e.avg >= mean)),
    group("You're less sold", rated.filter((e) => listed(e) && e.avg < mean)),
    group('Your hidden gems', rated.filter((e) => !listed(e) && e.avg >= mean)),
  ].join('');
  if (!body) return '';
  return foldHtml('critics', 'You vs. the critics', `<div class="critics">${body}
    <p class="critics-note">Compared with your board's average of ${fmt(mean)}. The lists don't score burgers, so this only shows who made the cut.</p></div>`);
}

function picksHtml(dish) {
  const picks = new Map();
  for (const list of state.lists.filter((l) => l.dish === dish)) {
    for (const entry of list.entries) {
      const key = listKey(entry.name);
      if (!picks.has(key)) picks.set(key, { entry, lists: [] });
      picks.get(key).lists.push(list);
    }
  }
  const rows = [...picks.values()].filter(({ entry }) => {
    const keys = entryKeys(entry);
    const known = state.restaurants.find((r) => keys.includes(listKey(r.name)));
    if (known && ratingsFor(known.id, dish).length) return false;
    if (state.area && entry.area.toLowerCase() !== state.area) return false;
    return matches({ name: entry.name, area: entry.area }, state.query);
  }).sort((a, b) => b.lists.length - a.lists.length || a.entry.name.localeCompare(b.entry.name)).map(({ entry, lists }) => {
    const keys = entryKeys(entry);
    const known = state.restaurants.find((r) => keys.includes(listKey(r.name)));
    const saved = known && state.wishes.some((w) => w.restaurantId === known.id && isMe(w.person));
    const where = [entry.address, entry.area].filter(Boolean).join(', ');
    return `
      <div class="unrated">
        <span class="place">
          <span class="place-name">${esc(entry.name)}</span>
          <span class="place-meta">${esc(where)}</span>
          <span class="list-tags">${lists.map((l) => `<span class="list-tag">${esc(l.tag)}</span>`).join('')}</span>
        </span>
        <span class="wish-actions">
          ${saved ? '<span class="place-meta">Saved</span>' : `<button class="link" type="button" data-pick-save="${esc(entry.name)}" aria-label="Save ${esc(entry.name)} to Want to Try">Save</button>`}
          <button class="ghost" type="button" data-pick-rate="${esc(entry.name)}" aria-label="Rate ${esc(entry.name)}">Rate it</button>
        </span>
      </div>`;
  });
  if (!rows.length) return '';
  return foldHtml('picks', `Critics' picks you haven't tried (${rows.length})`, rows.join(''));
}

/* Want to try */
const isMe = (name) => Boolean(state.me) && name.toLowerCase() === state.me.toLowerCase();

function wishesFor(restaurantId) {
  return state.wishes.filter((w) => w.restaurantId === restaurantId && (!state.person || w.person === state.person));
}

// Newest first, with everyone who wants to try a place grouped together.
function wishGroups() {
  return state.restaurants
    .filter((r) => (!state.area || areaKey(r) === state.area) && matches(r, state.query))
    .map((restaurant) => ({ restaurant, wishes: wishesFor(restaurant.id) }))
    .filter((group) => group.wishes.length)
    .sort((a, b) => {
      const latest = (group) => group.wishes.map((w) => w.addedAt).sort().pop();
      return latest(b).localeCompare(latest(a));
    });
}

function wishRowHtml({ restaurant, wishes }) {
  const mine = wishes.find((w) => isMe(w.person));
  const who = wishes.map((w) => w.person).join(' & ');
  const notes = wishes.filter((w) => w.note)
    .map((w) => `<span class="wish-note">${esc(w.person)}: ${esc(w.note)}</span>`).join('');
  const meta = [locationLabel(restaurant), `${who} ${wishes.length === 1 ? 'wants' : 'want'} to try it`].filter(Boolean).map(esc).join(' · ');
  return `
    <div class="unrated">
      <span class="place">
        <span class="place-name">${esc(restaurant.name)}</span>
        <span class="place-meta">${meta}</span>
        ${notes}
      </span>
      <span class="wish-actions">
        ${mine ? `<button class="link" type="button" data-unwish="${mine.id}">Remove</button>` : ''}
        ${mine ? '' : `<button class="link" type="button" data-wish="${restaurant.id}">Me too</button>`}
        <button class="ghost" type="button" data-rate="${restaurant.id}" aria-label="Rate ${esc(restaurant.name)}">Rate it</button>
      </span>
    </div>`;
}

function wishListHtml() {
  const groups = wishGroups();
  if (groups.length) return groups.map(wishRowHtml).join('');
  if (state.person || state.area || state.query.trim()) {
    return `
      <div class="empty">
        <h2>Nothing matches</h2>
        <p>No saved places fit that search and those filters.</p>
      </div>`;
  }
  return `
    <div class="empty">
      <h2>Nowhere saved yet</h2>
      <p>Heard about a great burger? Save it here so you don't forget.</p>
    </div>`;
}

// One person's list, reachable from anywhere a restaurant is shown.
function wishToggleHtml(restaurantId) {
  const mine = state.wishes.find((w) => w.restaurantId === restaurantId && isMe(w.person));
  return mine
    ? `<button class="link" type="button" data-unwish="${mine.id}">Remove from Want to Try</button>`
    : `<button class="link" type="button" data-wish="${restaurantId}">Save to Want to Try</button>`;
}

async function addWish(restaurantId) {
  if (!state.me) {
    askName(() => addWish(restaurantId));
    return;
  }
  try {
    applyData(await api('/api/wishes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ restaurant: { id: restaurantId }, person: state.me, note: '' }),
    }));
    toast('Saved to Want to Try.');
  } catch (err) {
    toast(err.message);
  }
}

async function removeWish(id) {
  try {
    applyData(await api(`/api/wishes/${encodeURIComponent(id)}`, { method: 'DELETE' }));
    toast('Removed from Want to Try.');
  } catch (err) {
    toast(err.message);
    refresh();
  }
}

/* Map */
const hasCoords = (restaurant) => Number.isFinite(restaurant.lat) && Number.isFinite(restaurant.lon);

// The map follows the same search, person and location filters as the boards.
function mapEntries() {
  return state.restaurants
    .filter((r) => (!state.area || areaKey(r) === state.area) && matches(r, state.query))
    .map((restaurant) => ({
      restaurant,
      burger: ratingsFor(restaurant.id, 'burger'),
      caesar: ratingsFor(restaurant.id, 'caesar'),
      wishes: wishesFor(restaurant.id),
    }))
    .filter((e) => e.burger.length || e.caesar.length || e.wishes.length);
}

const leaflet = { map: null, pins: null, fittedTo: null };

function pinHtml(entry) {
  const part = (emoji, ratings) => (ratings.length ? `<span>${emoji} ${fmt(average(ratings))}</span>` : '');
  if (!entry.burger.length && !entry.caesar.length) return '<div class="pin try"><span>⭐ Try</span></div>';
  return `<div class="pin">${part('🍔', entry.burger)}${part('🥗', entry.caesar)}</div>`;
}

function setupMap() {
  if (leaflet.map || !window.L) return;
  leaflet.map = L.map('map', { worldCopyJump: true, attributionControl: false }).setView([39.5, -98.35], 4);
  // Top corner, so the required credit can't end up under the fixed rating button.
  L.control.attribution({ position: 'topright' }).addTo(leaflet.map);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(leaflet.map);
  leaflet.pins = L.layerGroup().addTo(leaflet.map);
}

function selectOnMap(id) {
  state.mapSelected = id;
  render();
  loadWebsite(id);
  if (window.innerWidth <= 900) $('mapPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderPins(entries) {
  leaflet.map.invalidateSize();
  leaflet.pins.clearLayers();
  const pinned = entries.filter((e) => hasCoords(e.restaurant));
  for (const entry of pinned) {
    const { restaurant } = entry;
    const selected = restaurant.id === state.mapSelected;
    const marker = L.marker([restaurant.lat, restaurant.lon], {
      title: restaurant.name,
      alt: restaurant.name,
      riseOnHover: true,
      icon: L.divIcon({ className: `pin-anchor${selected ? ' selected' : ''}`, html: pinHtml(entry), iconSize: null }),
    });
    marker.on('click', () => selectOnMap(restaurant.id));
    leaflet.pins.addLayer(marker);
  }
  // Only reframe when the set of pins changes, so a background refresh doesn't move the map.
  const key = pinned.map((e) => e.restaurant.id).sort().join();
  if (pinned.length && key !== leaflet.fittedTo) {
    const bounds = L.latLngBounds(pinned.map((e) => [e.restaurant.lat, e.restaurant.lon]));
    leaflet.map.fitBounds(bounds, { padding: [70, 70], maxZoom: 15 });
  }
  leaflet.fittedTo = key;
}

function dishBlockHtml(dishKey, ratings, restaurant) {
  const emoji = dishKey === 'burger' ? '🍔' : '🥗';
  const label = dishKey === 'burger' ? 'Burger' : 'Caesar';
  const iRated = state.me && allRatingsFor(restaurant.id, dishKey)
    .some((r) => r.rater.toLowerCase() === state.me.toLowerCase());
  return `
    <section class="dish-block">
      <div class="dish-head">
        <span>${emoji} ${label}</span>
        ${ratings.length
    ? `<span class="score" aria-label="${label} grade ${fmt(average(ratings))} out of 10">${fmt(average(ratings))}</span>`
    : '<span class="dish-none">Not rated yet</span>'}
      </div>
      ${ratings.map(reviewHtml).join('')}
      ${iRated ? '' : `<button class="ghost" type="button" data-rate="${restaurant.id}" data-rate-dish="${dishKey}">Rate the ${dishKey === 'burger' ? 'burger' : 'Caesar'}</button>`}
    </section>`;
}

function panelHtml(entry) {
  const { restaurant } = entry;
  const search = encodeURIComponent(`${restaurant.name} ${restaurant.area}`.trim());
  const links = [
    restaurant.website
      ? `<a href="${esc(restaurant.website)}" target="_blank" rel="noopener noreferrer">Website</a>`
      : `<a href="https://www.google.com/search?q=${search}" target="_blank" rel="noopener noreferrer">Search the web</a>`,
    hasCoords(restaurant)
      ? `<a href="https://www.google.com/maps/dir/?api=1&amp;destination=${restaurant.lat},${restaurant.lon}" target="_blank" rel="noopener noreferrer">Directions</a>`
      : '',
    `<button class="link" type="button" data-edit-restaurant="${restaurant.id}">Edit restaurant</button>`,
  ];
  const where = [restaurant.address, restaurant.area].filter(Boolean).map(esc).join(', ');
  return `
    <article class="panel">
      <h2>${esc(restaurant.name)}</h2>
      ${where ? `<p class="place-address">${where}</p>` : ''}
      <div class="panel-links">${links.join('')}</div>
      <p class="wish-line">
        ${entry.wishes.length ? `⭐ ${esc(entry.wishes.map((w) => w.person).join(' & '))} ${entry.wishes.length === 1 ? 'wants' : 'want'} to try it.` : ''}
        ${wishToggleHtml(restaurant.id)}
      </p>
      ${listLinksHtml(restaurant, 'burger')}
      ${dishBlockHtml('burger', entry.burger, restaurant)}
      ${dishBlockHtml('caesar', entry.caesar, restaurant)}
    </article>`;
}

function renderMap() {
  setupMap();
  const entries = mapEntries();
  if (leaflet.map) renderPins(entries);
  else $('map').innerHTML = '<p class="map-message">The map needs an internet connection. Refresh to try again.</p>';

  const selected = entries.find((e) => e.restaurant.id === state.mapSelected);
  const unpinned = entries.filter((e) => !hasCoords(e.restaurant)).map((e) => e.restaurant).sort(byName);
  let html = selected
    ? panelHtml(selected)
    : `<div class="panel"><h2>${entries.length ? 'Click a pin' : 'Nothing to show'}</h2><p class="place-address">${entries.length ? 'See every grade and note, and find the restaurant\'s website.' : 'No rated restaurants match those filters.'}</p></div>`;
  if (unpinned.length) {
    html += '<h2 class="section-label">Not on the map yet</h2>';
    html += unpinned.map((r) => `
      <div class="unrated">
        <span class="place">
          <span class="place-name">${esc(r.name)}</span>
          ${r.area ? `<span class="place-meta">${esc(r.area)}</span>` : ''}
        </span>
        <button class="ghost" type="button" data-edit-restaurant="${r.id}" aria-label="Find ${esc(r.name)} on the map">Find it</button>
      </div>`).join('');
  }
  $('mapPanel').innerHTML = html;
}

async function loadWebsite(id) {
  const restaurant = state.restaurants.find((r) => r.id === id);
  if (!restaurant || !restaurant.placeId || restaurant.website !== undefined) return;
  try {
    const { website } = await api(`/api/restaurants/${encodeURIComponent(id)}/website`);
    const current = state.restaurants.find((r) => r.id === id);
    if (current && website) {
      current.website = website;
      lastSnapshot = '';
      render();
    }
  } catch {
    // The panel already offers a web search instead.
  }
}

/* Toast */
let toastTimer;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

/* Who's rating */
let afterName = null;

function askName(then) {
  afterName = then || null;
  $('people').innerHTML = state.people
    .map((name) => `<button class="person" type="button" data-person="${esc(name)}">${esc(name)}</button>`)
    .join('');
  $('nameInput').value = '';
  $('nameError').textContent = '';
  $('nameDialog').showModal();
}

function setName(name) {
  state.me = name;
  store('me', name);
  $('nameDialog').close();
  render();
  const next = afterName;
  afterName = null;
  if (next) next();
}

/* Rating form */
const form = {
  picked: null, // a restaurant already on the board
  place: null, // a place found through the lookup, not yet on the board
  manual: false, // typed by hand because the lookup didn't have it
  wish: false, // saving to Want to Try rather than rating
  prefilled: false,
  activeOption: -1,
  places: [],
  nearby: [],
  photoPending: null, // the newly chosen photo while it's being shrunk
  photoBlob: null, // a newly chosen photo, shrunk and ready to upload
  photoExisting: null, // the photo already on this person's rating
  photoRemoved: false,
  searchTimer: null,
  searchToken: 0,
  coords: null,
};

function verdictFor(score) {
  return VERDICTS.find(([floor]) => score >= floor)[1];
}

function updateSubmitLabel() {
  if (form.wish) return;
  const score = parseScore($('scoreInput').value);
  if (score === null) $('rateSubmit').textContent = 'Post my rating';
  else $('rateSubmit').textContent = existingRating() ? `Update to ${fmt(score)}` : `Post my ${fmt(score)}`;
}

function setScore(score, fromTyping) {
  if (!fromTyping) $('scoreInput').value = fmt(score);
  $('scoreSlider').value = score;
  $('verdict').textContent = verdictFor(score);
  $('scoreCard').classList.remove('blank');
  updateSubmitLabel();
}

// Grades start blank so a default number can't nudge everyone toward the same score.
function clearScore() {
  $('scoreInput').value = '';
  $('scoreSlider').value = 5.5;
  $('verdict').textContent = 'Slide, tap or type your grade';
  $('scoreCard').classList.add('blank');
  updateSubmitLabel();
}

function themeRateDialog() {
  const dish = form.wish ? 'try' : currentDish();
  $('rateDialog').dataset.dish = dish;
  $('rateTitle').textContent = form.wish ? 'Save a place' : `Rate a ${DISHES[dish].one}`;
}

function stepScore(change) {
  const current = parseScore($('scoreInput').value) ?? Number($('scoreSlider').value);
  // Whole tenths, so repeated taps can't drift to 8.500000001.
  const next = (Math.round(current * 10) + change) / 10;
  setScore(Math.min(10, Math.max(1, next)));
}

function parseScore(text) {
  const value = Number(text.trim());
  if (!/^\d{1,2}(\.\d)?$/.test(text.trim()) || value < 1 || value > 10) return null;
  return value;
}

function currentDish() {
  return document.querySelector('input[name="dish"]:checked').value;
}

function existingRating() {
  if (!form.picked) return null;
  return state.ratings.find((r) => r.restaurantId === form.picked.id
    && r.dish === currentDish()
    && r.rater.toLowerCase() === state.me.toLowerCase()) || null;
}

// When you've already rated this dish here, the form loads that rating to update it.
function syncExisting() {
  if (form.wish) {
    $('rateHint').textContent = `Saving for ${state.me}.`;
    $('rateSubmit').textContent = 'Save to Want to Try';
    return;
  }
  const existing = existingRating();
  form.photoExisting = existing && existing.photo ? existing.photo : null;
  form.photoRemoved = false;
  renderPhotoField();
  if (existing) {
    setScore(existing.score);
    $('noteInput').value = existing.note;
    form.prefilled = true;
    $('rateHint').textContent = 'You already rated this, so saving will update your grade.';
  } else {
    // Don't carry an old grade over to a different dish or restaurant.
    if (form.prefilled) {
      clearScore();
      $('noteInput').value = '';
      form.prefilled = false;
    }
    $('rateHint').textContent = `Rating as ${state.me}.`;
    updateSubmitLabel();
  }
}

/* Photos: shrunk in the browser, so a phone's 8 MB picture uploads quickly over cell service. */
const MAX_PHOTO_SIDE = 1600;

async function shrinkPhoto(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, MAX_PHOTO_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('empty'))), 'image/jpeg', 0.82);
  });
}

let photoPreviewUrl = null;

function renderPhotoField() {
  if (photoPreviewUrl) {
    URL.revokeObjectURL(photoPreviewUrl);
    photoPreviewUrl = null;
  }
  let src = null;
  if (form.photoBlob) {
    photoPreviewUrl = URL.createObjectURL(form.photoBlob);
    src = photoPreviewUrl;
  } else if (form.photoExisting && !form.photoRemoved) {
    src = `/photos/${form.photoExisting}.jpg`;
  }
  $('photoPreview').hidden = !src;
  if (src) $('photoPreview').src = src;
  else $('photoPreview').removeAttribute('src');
  $('photoRemove').hidden = !src;
  $('photoPickText').textContent = src ? 'Change photo' : 'Add a photo';
}

async function choosePhoto(event) {
  const [file] = event.target.files;
  event.target.value = '';
  if (!file) return;
  $('rateError').textContent = '';
  // Posting waits on this, so a quick tap can't save the rating without its photo.
  const pending = shrinkPhoto(file).then((blob) => {
    if (form.photoPending === pending) {
      form.photoBlob = blob;
      renderPhotoField();
    }
  }).catch(() => {
    if (form.photoPending === pending) $('rateError').textContent = "That photo couldn't be read. Try a JPEG or PNG.";
  });
  form.photoPending = pending;
}

async function uploadPhoto(blob) {
  const { id } = await api('/api/photos', { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
  return id;
}

function showPickedLocation(place) {
  const text = [place.address, place.area].filter(Boolean).join(', ');
  $('pickedLocation').textContent = text;
  $('pickedLocation').hidden = !text;
}

function pickRestaurant(restaurant) {
  form.picked = restaurant;
  form.place = null;
  form.manual = false;
  $('restaurantInput').value = restaurant.name;
  $('areaField').hidden = true;
  showPickedLocation(restaurant);
  closeOptions();
  syncExisting();
}

function pickPlace(place) {
  const known = state.restaurants.find((r) => r.placeId === place.placeId);
  if (known) {
    pickRestaurant(known);
    return;
  }
  form.picked = null;
  form.place = place;
  form.manual = false;
  $('restaurantInput').value = place.name;
  $('areaField').hidden = true;
  showPickedLocation(place);
  closeOptions();
  syncExisting();
}

function chooseManual() {
  form.picked = null;
  form.place = null;
  form.manual = true;
  $('areaField').hidden = false;
  showPickedLocation({});
  closeOptions();
  syncExisting();
  $('areaInput').focus();
}

function chooseOption(option) {
  const { kind, id } = option.dataset;
  if (kind === 'restaurant') pickRestaurant(state.restaurants.find((r) => r.id === id));
  else if (kind === 'place') pickPlace([...form.places, ...form.nearby].find((p) => p.placeId === id));
  else if (kind === 'manual') chooseManual();
  else if (kind === 'locate') locateNearby();
}

function closeOptions() {
  clearTimeout(form.searchTimer);
  form.searchToken += 1;
  $('restaurantList').hidden = true;
  $('restaurantInput').setAttribute('aria-expanded', 'false');
  $('restaurantInput').removeAttribute('aria-activedescendant');
  form.activeOption = -1;
}

function optionHtml(kind, id, name, place, suffix) {
  const location = [place.address, place.area].filter(Boolean).join(', ');
  return `
    <li role="option" data-kind="${kind}" data-id="${esc(id)}" aria-selected="false">
      ${esc(name)}${suffix}${location ? `<small>${esc(location)}</small>` : ''}
    </li>`;
}

// Restaurants on the board come first, then lookup results, with typing it by hand as the last resort.
function renderOptions(query, status) {
  const list = $('restaurantList');
  const local = state.restaurants.filter((r) => matches(r, query)).sort(byName).slice(0, 5);
  const localIds = new Set(local.map((r) => r.placeId).filter(Boolean));
  const places = form.places.filter((p) => !localIds.has(p.placeId));
  list.innerHTML = [
    ...local.map((r) => optionHtml('restaurant', r.id, r.name, r, ' <em>on the board</em>')),
    ...places.map((p) => optionHtml('place', p.placeId, p.name, p, '')),
    status ? `<li class="status" role="presentation">${esc(status)}</li>` : '',
    optionHtml('manual', 'manual', `Can't find it? Add "${query.trim()}" by hand`, {}, '').replace('<li ', '<li class="manual" '),
    places.length ? '<li class="attribution" role="presentation">Places © OpenStreetMap contributors</li>' : '',
  ].join('');
  [...list.querySelectorAll('[role="option"]')].forEach((option, i) => { option.id = `option-${i}`; });
  list.hidden = false;
  form.activeOption = -1;
  $('restaurantInput').setAttribute('aria-expanded', 'true');
  $('restaurantInput').removeAttribute('aria-activedescendant');
}

function showOptions() {
  const query = $('restaurantInput').value;
  if (!query.trim()) {
    form.places = [];
    closeOptions();
    showNearby();
    return;
  }
  clearTimeout(form.searchTimer);
  form.searchToken += 1;
  const token = form.searchToken;
  renderOptions(query, query.trim().length >= 2 ? 'Searching…' : '');
  if (query.trim().length < 2) return;
  form.searchTimer = setTimeout(async () => {
    let status = '';
    try {
      const params = new URLSearchParams({ q: query });
      if (form.coords) {
        params.set('lat', form.coords.lat);
        params.set('lon', form.coords.lon);
      }
      form.places = await api(`/api/places?${params}`);
    } catch {
      form.places = [];
      status = 'Restaurant search is unavailable right now.';
    }
    // Ignore answers to anything but the latest thing typed.
    if (token === form.searchToken) renderOptions(query, status);
  }, 250);
}

/* Nearby: an empty restaurant box suggests what's around you. Browsers only share
   location over https or on localhost, so phones get this once the app is online. */
const canLocate = () => window.isSecureContext && Boolean(navigator.geolocation);

function formatDistance(meters) {
  const feet = meters * 3.28084;
  return feet < 1000 ? `${Math.round(feet / 10) * 10} ft` : `${(meters / 1609.34).toFixed(1)} mi`;
}

function renderNearby(html) {
  const list = $('restaurantList');
  list.innerHTML = html;
  [...list.querySelectorAll('[role="option"]')].forEach((option, i) => { option.id = `option-${i}`; });
  list.hidden = false;
  form.activeOption = -1;
  $('restaurantInput').setAttribute('aria-expanded', 'true');
  $('restaurantInput').removeAttribute('aria-activedescendant');
}

function renderNearbyResults() {
  const places = form.nearby.map((place) => {
    const known = state.restaurants.find((r) => r.placeId === place.placeId);
    const distance = ` <em>· ${esc(formatDistance(place.meters))}${known ? ' · on the board' : ''}</em>`;
    return optionHtml('place', place.placeId, place.name, place, distance);
  });
  renderNearby(places.length
    ? `${places.join('')}<li class="attribution" role="presentation">Places © OpenStreetMap contributors</li>`
    : '<li class="status" role="presentation">Nothing listed nearby. Try typing the name.</li>');
}

async function showNearby() {
  if ($('restaurantInput').value.trim() || !canLocate()) return;
  if (form.nearby.length) {
    renderNearbyResults();
    return;
  }
  let granted = false;
  try {
    granted = (await navigator.permissions.query({ name: 'geolocation' })).state === 'granted';
  } catch {
    // Some browsers can't report this, so they get the button instead.
  }
  if ($('restaurantInput').value.trim() || document.activeElement !== $('restaurantInput')) return;
  if (granted) locateNearby();
  else renderNearby(optionHtml('locate', 'locate', '📍 Show places near me', {}, ''));
}

function locateNearby() {
  clearTimeout(form.searchTimer);
  form.searchToken += 1;
  const token = form.searchToken;
  renderNearby('<li class="status" role="presentation">Finding places near you…</li>');
  const stop = (message) => {
    if (token === form.searchToken) renderNearby(`<li class="status" role="presentation">${esc(message)}</li>`);
  };
  navigator.geolocation.getCurrentPosition(async ({ coords }) => {
    form.coords = { lat: coords.latitude, lon: coords.longitude };
    try {
      const params = new URLSearchParams({ lat: coords.latitude, lon: coords.longitude });
      const nearby = await api(`/api/nearby?${params}`);
      if (token !== form.searchToken) return;
      form.nearby = nearby;
      renderNearbyResults();
    } catch (err) {
      stop(err.message);
    }
  }, () => stop("Couldn't get your location. Try typing the name."), { timeout: 8000, maximumAge: 60000 });
}

// Results are worldwide until a restaurant with a known location is on the board,
// so ask the browser for a starting point. Phones refuse this over plain http.
function requestCoords() {
  if (form.coords || !window.isSecureContext || !navigator.geolocation) return;
  if (state.restaurants.some((r) => Number.isFinite(r.lat))) return;
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => { form.coords = { lat: coords.latitude, lon: coords.longitude }; },
    () => {},
    { timeout: 8000, maximumAge: 3600000 },
  );
}

function moveOption(step) {
  const options = [...$('restaurantList').querySelectorAll('[role="option"]')];
  if (!options.length) return;
  form.activeOption = (form.activeOption + step + options.length) % options.length;
  options.forEach((option, i) => option.setAttribute('aria-selected', String(i === form.activeOption)));
  options[form.activeOption].scrollIntoView({ block: 'nearest' });
  $('restaurantInput').setAttribute('aria-activedescendant', options[form.activeOption].id);
}

function openRate({ restaurantId = null, name = '', dish = state.dish, wish = false } = {}) {
  if (!state.me) {
    askName(() => openRate({ restaurantId, name, dish, wish }));
    return;
  }
  form.wish = wish;
  form.nearby = [];
  form.photoPending = null;
  form.photoBlob = null;
  form.photoExisting = null;
  form.photoRemoved = false;
  $('dishField').hidden = wish;
  $('gradeField').hidden = wish;
  $('photoField').hidden = wish;
  $('noteInput').placeholder = wish ? 'Who recommended it? What should we order?' : 'Crispy edges? Too much dressing?';
  form.picked = null;
  form.place = null;
  form.manual = false;
  form.places = [];
  form.prefilled = false;
  $('rateForm').reset();
  $('rateError').textContent = '';
  $('restaurantInput').value = name;
  $('areaField').hidden = true;
  showPickedLocation({});
  closeOptions();
  document.querySelector(`input[name="dish"][value="${dish}"]`).checked = true;
  clearScore();
  const restaurant = state.restaurants.find((r) => r.id === restaurantId);
  themeRateDialog();
  if (restaurant) pickRestaurant(restaurant);
  else syncExisting();
  $('rateDialog').showModal();
  if (!restaurant) {
    $('restaurantInput').focus();
    if (name) showOptions();
    else showNearby();
  }
}

async function submitWish(typed, area) {
  const submit = $('rateSubmit');
  submit.disabled = true;
  try {
    const data = await api('/api/wishes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        restaurant: form.picked ? { id: form.picked.id } : form.place || { name: typed, area },
        person: state.me,
        note: $('noteInput').value,
      }),
    });
    $('rateDialog').close();
    state.query = '';
    $('search').value = '';
    state.person = '';
    state.area = '';
    applyData(data);
    toast('Saved to Want to Try.');
  } catch (err) {
    $('rateError').textContent = err.message;
  } finally {
    submit.disabled = false;
  }
}

async function submitRating(event) {
  event.preventDefault();
  const typed = $('restaurantInput').value.trim();
  const area = $('areaInput').value.trim();
  const score = parseScore($('scoreInput').value);
  $('rateError').textContent = '';

  // Typing a full name without clicking the suggestion shouldn't create a duplicate.
  if (!form.picked && !form.place && !form.manual) {
    const sameName = state.restaurants.filter((r) => norm(r.name) === norm(typed));
    if (sameName.length === 1) pickRestaurant(sameName[0]);
  }
  if (!form.picked && !form.place && !form.manual) {
    $('rateError').textContent = typed
      ? 'Choose a restaurant from the suggestions, or add it by hand.'
      : 'Pick a restaurant.';
    $('restaurantInput').focus();
    return;
  }
  if (form.wish) {
    await submitWish(typed, area);
    return;
  }
  if (score === null) {
    $('rateError').textContent = $('scoreInput').value.trim() ? 'Grades go from 1.0 to 10.0, with one decimal.' : 'Pick a grade first.';
    $('scoreInput').focus();
    return;
  }

  const dish = currentDish();
  const restaurant = form.picked ? { id: form.picked.id } : form.place || { name: typed, area };
  const submit = $('rateSubmit');
  submit.disabled = true;
  try {
    await form.photoPending;
    const photoChange = {};
    if (form.photoBlob) photoChange.photo = await uploadPhoto(form.photoBlob);
    else if (form.photoRemoved) photoChange.photo = null;
    const data = await api('/api/ratings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        restaurant,
        dish,
        rater: state.me,
        score,
        note: $('noteInput').value,
        ...photoChange,
      }),
    });
    $('rateDialog').close();
    state.dish = dish;
    store('dish', dish);
    state.query = '';
    $('search').value = '';
    // Make sure the rating you just posted is visible.
    state.person = '';
    state.area = '';
    applyData(data);
    form.photoBlob = null;
    toast(`Posted your ${fmt(score)}.`);
  } catch (err) {
    $('rateError').textContent = err.message;
  } finally {
    submit.disabled = false;
  }
}

/* Editing a restaurant */
let editingId = null;
const editPlace = { chosen: null, found: [], timer: null, token: 0 };

function openEditRestaurant(id) {
  const restaurant = state.restaurants.find((r) => r.id === id);
  if (!restaurant) return;
  editingId = id;
  editPlace.chosen = null;
  editPlace.found = [];
  editPlace.token += 1;
  clearTimeout(editPlace.timer);
  $('editName').value = restaurant.name;
  $('editArea').value = restaurant.area;
  $('editPlaceSearch').value = '';
  $('editPlaceResults').innerHTML = '';
  $('editPlaceStatus').textContent = hasCoords(restaurant)
    ? `Pinned at ${[restaurant.address, restaurant.area].filter(Boolean).join(', ')}`
    : 'Not on the map yet. If the name finds nothing, try the street address.';
  $('editError').textContent = '';
  requestCoords();
  $('editDialog').showModal();
  if (!hasCoords(restaurant)) $('editPlaceSearch').focus();
}

function searchEditPlaces() {
  clearTimeout(editPlace.timer);
  editPlace.token += 1;
  const token = editPlace.token;
  const query = $('editPlaceSearch').value.trim();
  $('editPlaceResults').innerHTML = '';
  if (query.length < 2) return;
  editPlace.timer = setTimeout(async () => {
    try {
      const params = new URLSearchParams({ q: query, addresses: '1' });
      if (form.coords) {
        params.set('lat', form.coords.lat);
        params.set('lon', form.coords.lon);
      }
      const found = await api(`/api/places?${params}`);
      if (token !== editPlace.token) return;
      editPlace.found = found;
      $('editPlaceStatus').textContent = found.length ? '' : 'Nothing found. Try the street address and city.';
      $('editPlaceResults').innerHTML = found.map((p) => `
        <li><button class="place-result" type="button" data-place="${esc(p.placeId)}">
          ${esc(p.name)}<small>${esc([p.isVenue ? p.address : '', p.area].filter(Boolean).join(', '))}</small>
        </button></li>`).join('');
    } catch (err) {
      if (token === editPlace.token) $('editPlaceStatus').textContent = err.message;
    }
  }, 250);
}

function chooseEditPlace(placeId) {
  const place = editPlace.found.find((p) => p.placeId === placeId);
  if (!place) return;
  editPlace.chosen = place;
  // A street address pins the spot but shouldn't replace the restaurant's name.
  if (place.isVenue) $('editName').value = place.name;
  $('editArea').value = place.area;
  $('editPlaceResults').innerHTML = '';
  $('editPlaceSearch').value = '';
  $('editPlaceStatus').textContent = `Will pin at ${[place.address, place.area].filter(Boolean).join(', ')}. Save to confirm.`;
}

async function submitRestaurantEdit(event) {
  event.preventDefault();
  const submit = $('editSubmit');
  submit.disabled = true;
  try {
    const data = await api(`/api/restaurants/${encodeURIComponent(editingId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: $('editName').value, area: $('editArea').value, place: editPlace.chosen }),
    });
    $('editDialog').close();
    applyData(data);
    toast('Restaurant updated.');
  } catch (err) {
    $('editError').textContent = err.message;
  } finally {
    submit.disabled = false;
  }
}

async function deleteRating(id) {
  if (!confirm('Delete your rating?')) return;
  try {
    applyData(await api(`/api/ratings/${encodeURIComponent(id)}`, { method: 'DELETE' }));
    toast('Rating deleted.');
  } catch (err) {
    toast(err.message);
    refresh();
  }
}

/* Events */
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    state.view = ['map', 'try'].includes(tab.dataset.dish) ? tab.dataset.dish : 'board';
    store('view', state.view);
    if (state.view === 'board') {
      state.dish = tab.dataset.dish;
      store('dish', state.dish);
    }
    render();
  });
});

$('filterToggle').addEventListener('click', () => {
  state.filtersOpen = !state.filtersOpen;
  render();
});

$('search').addEventListener('input', (event) => {
  state.query = event.target.value;
  render();
});
$('personFilter').addEventListener('change', (event) => {
  state.person = event.target.value;
  render();
});
$('areaFilter').addEventListener('change', (event) => {
  state.area = event.target.value;
  render();
});
$('sort').addEventListener('change', (event) => {
  state.sort = event.target.value;
  render();
});
$('rateButton').addEventListener('click', () => openRate({ wish: state.view === 'try' }));
$('whoButton').addEventListener('click', () => askName());

function handleBoardClick(event) {
  const target = event.target.closest('button');
  if (!target) return;
  const { toggle, rate, edit, new: newName } = target.dataset;
  if (toggle) {
    if (state.open.has(toggle)) state.open.delete(toggle);
    else state.open.add(toggle);
    render();
    document.querySelector(`[data-toggle="${toggle}"]`).focus();
  } else if (rate) {
    openRate({ restaurantId: rate, dish: target.dataset.rateDish || state.dish });
  } else if (edit) {
    const rating = state.ratings.find((r) => r.id === edit);
    if (rating) openRate({ restaurantId: rating.restaurantId, dish: rating.dish });
  } else if (target.dataset.delete) {
    deleteRating(target.dataset.delete);
  } else if (target.dataset.pickSave) {
    openRate({ wish: true, name: target.dataset.pickSave });
  } else if (target.dataset.pickRate) {
    openRate({ name: target.dataset.pickRate, dish: state.dish });
  } else if (target.dataset.wish) {
    addWish(target.dataset.wish);
  } else if (target.dataset.unwish) {
    removeWish(target.dataset.unwish);
  } else if (target.dataset.editRestaurant) {
    openEditRestaurant(target.dataset.editRestaurant);
  } else if (target.dataset.clear !== undefined) {
    state.person = '';
    state.area = '';
    render();
  } else if (newName !== undefined) {
    openRate({ name: newName });
  }
}
$('board').addEventListener('click', handleBoardClick);
// Remembered because the board redraws whenever a friend's new rating arrives.
$('board').addEventListener('toggle', (event) => {
  const { fold } = event.target.dataset || {};
  if (fold && !state.query.trim()) state.folds[fold] = event.target.open;
}, true);
$('mapPanel').addEventListener('click', handleBoardClick);

$('editPlaceSearch').addEventListener('input', searchEditPlaces);
$('editPlaceResults').addEventListener('click', (event) => {
  const button = event.target.closest('[data-place]');
  if (button) chooseEditPlace(button.dataset.place);
});

$('restaurantInput').addEventListener('input', () => {
  form.picked = null;
  form.place = null;
  form.manual = false;
  $('areaField').hidden = true;
  showPickedLocation({});
  showOptions();
  syncExisting();
});
$('restaurantInput').addEventListener('keydown', (event) => {
  const listOpen = !$('restaurantList').hidden;
  if (event.key === 'ArrowDown' && listOpen) {
    event.preventDefault();
    moveOption(1);
  } else if (event.key === 'ArrowUp' && listOpen) {
    event.preventDefault();
    moveOption(-1);
  } else if (event.key === 'Enter' && listOpen && form.activeOption >= 0) {
    event.preventDefault();
    chooseOption($('restaurantList').querySelectorAll('[role="option"]')[form.activeOption]);
  } else if (event.key === 'Escape' && listOpen) {
    event.preventDefault();
    closeOptions();
  }
});
$('restaurantInput').addEventListener('blur', () => setTimeout(closeOptions, 120));
$('restaurantInput').addEventListener('focus', showNearby);
$('photoInput').addEventListener('change', choosePhoto);
$('photoPick').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    $('photoInput').click();
  }
});
$('photoRemove').addEventListener('click', () => {
  form.photoPending = null;
  form.photoBlob = null;
  form.photoRemoved = Boolean(form.photoExisting);
  renderPhotoField();
});
$('restaurantList').addEventListener('mousedown', (event) => {
  event.preventDefault();
  const option = event.target.closest('[role="option"]');
  if (option) chooseOption(option);
});

document.querySelectorAll('input[name="dish"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    themeRateDialog();
    syncExisting();
  });
});
$('scoreDown').addEventListener('click', () => stepScore(-1));
$('scoreUp').addEventListener('click', () => stepScore(1));
const useSlider = (event) => setScore(Number(event.target.value));
$('scoreSlider').addEventListener('input', useSlider);
// A tap right on the untouched thumb fires no input event, but still means that grade.
$('scoreSlider').addEventListener('click', useSlider);
$('scoreInput').addEventListener('input', (event) => {
  const score = parseScore(event.target.value);
  if (score !== null) setScore(score, true);
});
$('scoreInput').addEventListener('blur', (event) => {
  const score = parseScore(event.target.value);
  if (score !== null) setScore(score);
});

$('rateForm').addEventListener('submit', submitRating);
$('editForm').addEventListener('submit', submitRestaurantEdit);
document.querySelectorAll('[data-close]').forEach((button) => {
  button.addEventListener('click', () => button.closest('dialog').close());
});

$('nameForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const name = $('nameInput').value.trim();
  if (!name) {
    $('nameError').textContent = 'Enter a name so friends know who rated what.';
    return;
  }
  const known = state.people.find((person) => person.toLowerCase() === name.toLowerCase());
  setName(known || name);
});
$('people').addEventListener('click', (event) => {
  const person = event.target.closest('[data-person]');
  if (person) setName(person.dataset.person);
});

// Friends' new ratings show up without a reload.
setInterval(refresh, 15000);
window.addEventListener('focus', refresh);

render();
fetch('lists.json')
  .then((res) => res.json())
  .then((lists) => {
    state.lists = lists;
    render();
  })
  .catch(() => {
    // The app works fine without the lists.
  });
refresh().then(() => {
  if (!state.me) askName();
});
