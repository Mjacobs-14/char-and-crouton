// Rules and place lookups used by both the home server (server.js) and the Cloudflare version (worker/).
// Only plain JavaScript and fetch, so it runs in both.
const PLACES_URL = 'https://photon.komoot.io/api/';
const PLACES_REVERSE_URL = 'https://photon.komoot.io/reverse';
const PHOTON_HEADERS = { 'User-Agent': 'CharAndCrouton/1.0' };
const PLACE_TAGS = ['restaurant', 'fast_food', 'pub', 'bar', 'cafe', 'food_court', 'biergarten'];
// Typing a name also finds these, since a burger can come from a taproom, a hotel or a ballpark.
const OTHER_VENUE_TAGS = [
  'amenity:ice_cream', 'amenity:nightclub', 'amenity:events_venue', 'amenity:social_club', 'amenity:casino',
  'craft:brewery', 'craft:winery', 'craft:distillery', 'tourism:hotel', 'shop:deli', 'shop:bakery', 'shop:butcher',
  'leisure:golf_course', 'leisure:bowling_alley', 'leisure:stadium', 'leisure:resort',
];
const VENUE_KEYS = new Set(['amenity', 'craft', 'tourism', 'shop', 'leisure', 'club']);
const SEARCH_RESULTS = 10;
const SEARCH_LOOKUP_SIZE = 15;
const LOCAL_METERS = 50000;
const SAME_PLACE_METERS = 75;
const PER_NAME = 3;
const FAR_RESULTS = 3;
const LOOSE_RESULTS = 5;
const RETRY_AFTER_MS = 300;
const CACHE_MS = 10 * 60 * 1000;
const CACHE_SIZE = 200;
const DISHES = ['burger', 'caesar'];
const US_STATES = {
  Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA', Colorado: 'CO', Connecticut: 'CT',
  Delaware: 'DE', 'District of Columbia': 'DC', Florida: 'FL', Georgia: 'GA', Hawaii: 'HI', Idaho: 'ID', Illinois: 'IL',
  Indiana: 'IN', Iowa: 'IA', Kansas: 'KS', Kentucky: 'KY', Louisiana: 'LA', Maine: 'ME', Maryland: 'MD',
  Massachusetts: 'MA', Michigan: 'MI', Minnesota: 'MN', Mississippi: 'MS', Missouri: 'MO', Montana: 'MT', Nebraska: 'NE',
  Nevada: 'NV', 'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY', 'North Carolina': 'NC',
  'North Dakota': 'ND', Ohio: 'OH', Oklahoma: 'OK', Oregon: 'OR', Pennsylvania: 'PA', 'Rhode Island': 'RI',
  'South Carolina': 'SC', 'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX', Utah: 'UT', Vermont: 'VT', Virginia: 'VA',
  Washington: 'WA', 'West Virginia': 'WV', Wisconsin: 'WI', Wyoming: 'WY',
};

const clean = (value, max) => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '');

function isValidScore(score) {
  if (typeof score !== 'number' || score < 1 || score > 10) return false;
  return Math.abs(score * 10 - Math.round(score * 10)) < 1e-9;
}

class BadRequest extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function placeDetails(input) {
  const placeId = clean(input.placeId, 40);
  if (!placeId) return {};
  const lat = Number(input.lat);
  const lon = Number(input.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new BadRequest('That place has no location.');
  return { placeId, address: clean(input.address, 120), lat, lon };
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

// Where this group's restaurants are, so searches favor places nearby.
function groupCenter(restaurants) {
  const located = restaurants.filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon));
  return located.length ? { lat: median(located.map((r) => r.lat)), lon: median(located.map((r) => r.lon)) } : null;
}

function coordsFrom(params) {
  const lat = Number(params.get('lat'));
  const lon = Number(params.get('lon'));
  return params.has('lat') && params.has('lon') && Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

function metersBetween(a, b) {
  const rad = (degrees) => (degrees * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(h));
}

function toPlace(feature) {
  const p = feature.properties;
  const address = [p.housenumber, p.street].filter(Boolean).join(' ');
  // OpenStreetMap mixes "IL" and "Illinois"; one spelling keeps the location filter tidy.
  const state = p.countrycode === 'US' ? US_STATES[p.state] || p.state : p.state;
  return {
    placeId: `osm:${p.osm_type}${p.osm_id}`,
    name: p.name || address,
    isVenue: Boolean(p.name) && VENUE_KEYS.has(p.osm_key),
    address,
    area: [p.city || p.town || p.district || p.county || p.name, state].filter(Boolean).join(', '),
    lat: feature.geometry.coordinates[1],
    lon: feature.geometry.coordinates[0],
  };
}

async function photonOnce(url) {
  const response = await fetch(url, { headers: PHOTON_HEADERS, signal: AbortSignal.timeout(4000) });
  if (!response.ok) {
    const err = new Error(`Place search returned ${response.status}`);
    // Asking again only helps when the service was busy, not when it disliked the question.
    err.final = response.status < 500 && response.status !== 429;
    throw err;
  }
  return (await response.json()).features;
}

// Recent answers, so retyping or backspacing doesn't ask the free service again.
const recent = new Map();

// The free service is shared and sometimes slow or busy, so each lookup gets a second try.
async function photon(url) {
  const key = String(url);
  const hit = recent.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.features;
  let features;
  try {
    features = await photonOnce(url);
  } catch (err) {
    if (err.final) throw err;
    await new Promise((resolve) => { setTimeout(resolve, RETRY_AFTER_MS); });
    features = await photonOnce(url);
  }
  recent.delete(key);
  recent.set(key, { at: Date.now(), features });
  if (recent.size > CACHE_SIZE) recent.delete(recent.keys().next().value);
  return features;
}

// "Mother's" and "mothers", or "J.M." and "jm", should count as the same word.
const words = (text) => String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ'’.]/g, '')
  .split(/[^a-z0-9]+/).filter(Boolean);

// How many of the typed words a place's name and address account for.
function wordsMatched(asked, feature) {
  const p = feature.properties;
  const known = words([p.name, p.housenumber, p.street, p.district, p.locality, p.city, p.town, p.county, p.state,
    p.countrycode === 'US' ? US_STATES[p.state] : '', p.postcode].filter(Boolean).join(' '));
  return asked.filter((word) => known.some((have) => have.startsWith(word) || oneTypoApart(word, have))).length;
}

// "tasti" for "tasty", or "shak" for "shack": one letter wrong, missing or extra in a longer word.
function oneTypoApart(a, b) {
  if (a.length < 4 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  const rest = (word, from) => word.slice(from);
  if (a.length === b.length) return rest(a, i + 1) === rest(b, i + 1);
  return a.length < b.length ? rest(a, i) === rest(b, i + 1) : rest(a, i + 1) === rest(b, i);
}

// The places that cover the most of what was typed: those around here first, then an exact
// name, then the nearest.
function rankPlaces(features, query, center, addresses, measured) {
  const asked = words(query);
  const scored = [];
  features.forEach((feature, order) => {
    const p = feature.properties;
    if (addresses ? !(p.name || p.street) : !p.name) return;
    const place = toPlace(feature);
    const meters = center ? metersBetween(center, place) : 0;
    // A distance only means something from a spot the person chose.
    if (measured) place.meters = Math.round(meters);
    scored.push({
      place, order, meters, hits: wordsMatched(asked, feature), local: meters <= LOCAL_METERS, exact: words(p.name).join(' ') === asked.join(' '),
    });
  });
  const best = Math.max(0, ...scored.map((item) => item.hits));
  const complete = best === asked.length;
  // Only the closest matches are worth showing; the rest bury "add it by hand".
  const top = scored.filter((item) => item.hits === best);
  // When nothing covers everything typed (a typo, say), the search service's own order is the better guide.
  top.sort((a, b) => (complete ? b.local - a.local || b.exact - a.exact || a.meters - b.meters : 0) || a.order - b.order);
  // OpenStreetMap often lists one restaurant twice, as a point and as its building.
  const distinct = [];
  for (const item of top) {
    const name = item.place.name.toLowerCase();
    const repeat = distinct.some(({ place }) => place.placeId === item.place.placeId
      || (place.name.toLowerCase() === name && metersBetween(place, item.place) < SAME_PLACE_METERS));
    if (!repeat) distinct.push(item);
  }
  let kept = distinct;
  if (!complete) {
    kept = distinct.slice(0, LOOSE_RESULTS);
  } else if (center && distinct.some((item) => item.local)) {
    // With matches around here, a few from elsewhere are plenty.
    let far = 0;
    kept = distinct.filter((item) => item.local || (far += 1) <= FAR_RESULTS);
  }
  // A chain's branches shouldn't push everything else off the list, so extra ones go last.
  const seen = new Map();
  const first = [];
  const later = [];
  for (const { place } of kept) {
    const name = place.name.toLowerCase();
    seen.set(name, (seen.get(name) || 0) + 1);
    (seen.get(name) <= PER_NAME ? first : later).push(place);
  }
  return [...first, ...later];
}

// Without a location, results are worldwide. Use where the person is right now
// if the browser shared it, otherwise where this group's restaurants are.
async function searchPlaces(params, fallbackCenter) {
  const query = clean(params.get('q'), 80);
  if (query.length < 2) return [];
  // Addresses are allowed when pinning a restaurant OpenStreetMap doesn't list.
  const addresses = params.get('addresses') === '1';
  const chosen = coordsFrom(params);
  const center = chosen || fallbackCenter;
  const lookup = (near) => {
    const url = new URL(PLACES_URL);
    url.searchParams.set('q', query);
    url.searchParams.set('limit', String(SEARCH_LOOKUP_SIZE));
    if (!addresses) {
      for (const tag of PLACE_TAGS) url.searchParams.append('osm_tag', `amenity:${tag}`);
      for (const tag of OTHER_VENUE_TAGS) url.searchParams.append('osm_tag', tag);
    }
    if (near) {
      url.searchParams.set('lat', near.lat);
      url.searchParams.set('lon', near.lon);
    }
    return photon(url);
  };
  const asked = words(query);
  const features = [...await lookup(center)];
  // Favoring nearby places can bury one in another city ("red robin chicago"), so when nothing
  // covers everything typed, look everywhere as well.
  if (center && !features.some((feature) => wordsMatched(asked, feature) === asked.length)) {
    features.push(...await lookup(null).catch(() => []));
  }
  return rankPlaces(features, query, center, addresses, Boolean(chosen)).slice(0, SEARCH_RESULTS);
}

// Cities and neighborhoods by name, for choosing where a restaurant search looks.
async function searchAreas(params, fallbackCenter) {
  const query = clean(params.get('q'), 60);
  if (query.length < 2) return [];
  const url = new URL(PLACES_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('limit', '8');
  for (const layer of ['city', 'district']) url.searchParams.append('layer', layer);
  if (fallbackCenter) {
    url.searchParams.set('lat', fallbackCenter.lat);
    url.searchParams.set('lon', fallbackCenter.lon);
  }
  const areas = new Map();
  for (const feature of await photon(url)) {
    const p = feature.properties;
    if (!p.name) continue;
    const american = p.countrycode === 'US';
    const state = american ? US_STATES[p.state] || p.state : p.state;
    const name = [...new Set([p.name, p.city, state, american ? '' : p.country].filter(Boolean))].join(', ');
    if (!areas.has(name)) areas.set(name, { name, lat: feature.geometry.coordinates[1], lon: feature.geometry.coordinates[0] });
  }
  return [...areas.values()].slice(0, 5);
}

async function searchNearby(params) {
  const here = coordsFrom(params);
  if (!here) throw new BadRequest('Nearby search needs a location.');
  const url = new URL(PLACES_REVERSE_URL);
  url.searchParams.set('lat', here.lat);
  url.searchParams.set('lon', here.lon);
  url.searchParams.set('limit', '8');
  url.searchParams.set('radius', '1');
  for (const tag of PLACE_TAGS) url.searchParams.append('osm_tag', `amenity:${tag}`);
  const features = await photon(url);
  return features
    .filter((f) => f.properties.name)
    .map(toPlace)
    .map((place) => ({ ...place, meters: Math.round(metersBetween(here, place)) }))
    .sort((a, b) => a.meters - b.meters);
}

const EXPLORE_MIN_METERS = 100;
const EXPLORE_MAX_METERS = 1609;
const EXPLORE_MAX_RESULTS = 80;

// Places inside a circle. The free search returns at most 50 places per lookup, nearest first,
// so bigger circles also look around four points inside the edge to reach the rest. That's a
// separate request (part=edge), so the nearest places can show up while the rest load.
async function exploreArea(params) {
  const center = coordsFrom(params);
  if (!center) throw new BadRequest('Exploring needs a location.');
  const radius = Math.min(EXPLORE_MAX_METERS, Math.max(EXPLORE_MIN_METERS, Number(params.get('radius')) || 805));
  const offset = (radius * 0.55) / 111320;
  const lonScale = Math.cos((center.lat * Math.PI) / 180) || 1;
  const edges = radius <= 450 ? [] : [
    { lat: center.lat + offset, lon: center.lon },
    { lat: center.lat - offset, lon: center.lon },
    { lat: center.lat, lon: center.lon + offset / lonScale },
    { lat: center.lat, lon: center.lon - offset / lonScale },
  ];
  const lookup = (point) => {
    const url = new URL(PLACES_REVERSE_URL);
    url.searchParams.set('lat', point.lat);
    url.searchParams.set('lon', point.lon);
    url.searchParams.set('limit', '50');
    url.searchParams.set('radius', String(radius / 1000));
    for (const tag of PLACE_TAGS) url.searchParams.append('osm_tag', `amenity:${tag}`);
    // An edge lookup failing just means fewer results.
    return photon(url).catch(() => []);
  };
  const features = [];
  if (params.get('part') === 'edge') {
    // Two at a time: the free service turns away bigger bursts.
    for (let i = 0; i < edges.length; i += 2) {
      for (const found of await Promise.all(edges.slice(i, i + 2).map(lookup))) features.push(...found);
    }
  } else {
    const url = new URL(PLACES_REVERSE_URL);
    url.searchParams.set('lat', center.lat);
    url.searchParams.set('lon', center.lon);
    url.searchParams.set('limit', '50');
    url.searchParams.set('radius', String(radius / 1000));
    for (const tag of PLACE_TAGS) url.searchParams.append('osm_tag', `amenity:${tag}`);
    features.push(...await photon(url));
  }
  const found = new Map();
  for (const feature of features) {
    if (!feature.properties.name) continue;
    const place = toPlace(feature);
    const meters = Math.round(metersBetween(center, place));
    if (meters <= radius && !found.has(place.placeId)) found.set(place.placeId, { ...place, meters });
  }
  const places = [...found.values()].sort((a, b) => a.meters - b.meters);
  return { radius, places: places.slice(0, EXPLORE_MAX_RESULTS), hasEdges: edges.length > 0 };
}

function normalizeWebsite(raw) {
  if (!raw) return '';
  const first = raw.split(';')[0].trim();
  try {
    const url = new URL(/^https?:\/\//i.test(first) ? first : `https://${first}`);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href.slice(0, 300) : '';
  } catch {
    return '';
  }
}

// A restaurant's website from OpenStreetMap, or '' when it has none listed.
async function fetchWebsite(placeId) {
  const match = /^osm:([NWR])(\d+)$/.exec(placeId || '');
  if (!match) return '';
  const type = { N: 'node', W: 'way', R: 'relation' }[match[1]];
  const response = await fetch(`https://api.openstreetmap.org/api/0.6/${type}/${match[2]}.json`, {
    headers: PHOTON_HEADERS,
    signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) throw new Error(`OpenStreetMap returned ${response.status}`);
  const { elements } = await response.json();
  const tags = (elements[0] && elements[0].tags) || {};
  return normalizeWebsite(tags.website || tags['contact:website'] || tags.url);
}

module.exports = {
  DISHES, BadRequest, clean, isValidScore, placeDetails, groupCenter, searchPlaces, searchAreas, searchNearby, exploreArea, fetchWebsite,
};
