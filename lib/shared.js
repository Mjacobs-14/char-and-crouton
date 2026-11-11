// Rules and place lookups used by both the home server (server.js) and the Cloudflare version (worker/).
// Only plain JavaScript and fetch, so it runs in both.
const PLACES_URL = 'https://photon.komoot.io/api/';
const PLACES_REVERSE_URL = 'https://photon.komoot.io/reverse';
const PHOTON_HEADERS = { 'User-Agent': 'CharAndCrouton/1.0' };
const PLACE_TAGS = ['restaurant', 'fast_food', 'pub', 'bar', 'cafe', 'food_court', 'biergarten'];
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
    isVenue: p.osm_key === 'amenity',
    address,
    area: [p.city || p.town || p.district || p.county || p.name, state].filter(Boolean).join(', '),
    lat: feature.geometry.coordinates[1],
    lon: feature.geometry.coordinates[0],
  };
}

async function photon(url) {
  const response = await fetch(url, { headers: PHOTON_HEADERS, signal: AbortSignal.timeout(4000) });
  if (!response.ok) throw new Error(`Place search returned ${response.status}`);
  return (await response.json()).features;
}

// Without a location, results are worldwide. Use where the person is right now
// if the browser shared it, otherwise where this group's restaurants are.
async function searchPlaces(params, fallbackCenter) {
  const query = clean(params.get('q'), 80);
  if (query.length < 2) return [];
  const url = new URL(PLACES_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('limit', '6');
  // Addresses are allowed when pinning a restaurant OpenStreetMap doesn't list.
  if (params.get('addresses') !== '1') {
    for (const tag of PLACE_TAGS) url.searchParams.append('osm_tag', `amenity:${tag}`);
  }
  const center = coordsFrom(params) || fallbackCenter;
  if (center) {
    url.searchParams.set('lat', center.lat);
    url.searchParams.set('lon', center.lon);
  }
  const features = await photon(url);
  return features.filter((f) => f.properties.name || f.properties.street).map(toPlace);
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
  DISHES, BadRequest, clean, isValidScore, placeDetails, groupCenter, searchPlaces, searchNearby, fetchWebsite,
};
