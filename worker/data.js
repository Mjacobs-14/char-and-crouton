// Ratings, restaurants and want-to-try lists in D1. Each change runs as one batch, which D1
// applies all-or-nothing, like commit() in the home server.
import shared from '../lib/shared.js';

const { BadRequest, DISHES, clean, isValidScore, placeDetails } = shared;
export const PHOTO_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Rows become the same shapes the home version sends, leaving out empty fields as it does.
export function toRestaurant(row) {
  const restaurant = { id: row.id, name: row.name, area: row.area };
  if (row.place_id !== null) Object.assign(restaurant, { placeId: row.place_id, address: row.address, lat: row.lat, lon: row.lon });
  if (row.website !== null) restaurant.website = row.website;
  return restaurant;
}

export function toRating(row) {
  const rating = {
    id: row.id, restaurantId: row.restaurant_id, dish: row.dish, rater: row.rater, score: row.score, note: row.note, updatedAt: row.updated_at,
  };
  if (row.photo !== null) rating.photo = row.photo;
  return rating;
}

export const toWish = (row) => ({ id: row.id, restaurantId: row.restaurant_id, person: row.person, note: row.note, addedAt: row.added_at });

export async function everything(env) {
  const [restaurants, ratings, people, wishes] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM restaurants ORDER BY rowid'),
    env.DB.prepare('SELECT * FROM ratings ORDER BY rowid'),
    env.DB.prepare('SELECT name FROM people ORDER BY rowid'),
    env.DB.prepare('SELECT * FROM wishes ORDER BY rowid'),
  ]);
  return {
    restaurants: restaurants.results.map(toRestaurant),
    ratings: ratings.results.map(toRating),
    people: people.results.map((row) => row.name),
    wishes: wishes.results.map(toWish),
  };
}

// Finds the restaurant a request means, or describes the one to create. Nothing is written yet.
async function resolveRestaurant(env, input) {
  if (input && input.id) {
    const row = await env.DB.prepare('SELECT * FROM restaurants WHERE id = ?').bind(String(input.id)).first();
    if (!row) throw new BadRequest('That restaurant no longer exists.');
    return { id: row.id, statements: [] };
  }
  const name = clean(input && input.name, 80);
  const area = clean(input && input.area, 60);
  if (!name) throw new BadRequest('Pick or name a restaurant.');
  const details = placeDetails(input);
  if (details.placeId) {
    const samePlace = await env.DB.prepare('SELECT id FROM restaurants WHERE place_id = ?').bind(details.placeId).first();
    if (samePlace) return { id: samePlace.id, statements: [] };
  }
  // Two looked-up places can share a name and city (chains), but a hand-typed entry can't.
  const existing = await env.DB.prepare(`SELECT * FROM restaurants WHERE lower(name) = lower(?) AND lower(area) = lower(?)
    AND (place_id IS NULL OR ? IS NULL) ORDER BY rowid LIMIT 1`).bind(name, area, details.placeId || null).first();
  if (existing) {
    const statements = details.placeId
      ? [env.DB.prepare('UPDATE restaurants SET place_id = ?, address = ?, lat = ?, lon = ? WHERE id = ?')
        .bind(details.placeId, details.address, details.lat, details.lon, existing.id)]
      : [];
    return { id: existing.id, statements };
  }
  const id = crypto.randomUUID();
  return {
    id,
    statements: [env.DB.prepare('INSERT INTO restaurants (id, name, area, place_id, address, lat, lon) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id, name, area, details.placeId || null, details.placeId ? details.address : null, details.lat ?? null, details.lon ?? null)],
  };
}

// Drops a restaurant nobody rates or wants to try, so a typo'd name disappears with its rating.
const removeIfUnused = (env, id) => env.DB.prepare(`DELETE FROM restaurants WHERE id = ?
  AND NOT EXISTS (SELECT 1 FROM ratings WHERE restaurant_id = ?) AND NOT EXISTS (SELECT 1 FROM wishes WHERE restaurant_id = ?)`)
  .bind(id, id, id);

const ORPHAN_MS = 24 * 60 * 60 * 1000;
const DELETE_SIZE = 50;

const deletePhotos = (env, ids) => {
  const marks = ids.map(() => '?').join(', ');
  return env.PHOTOS.batch(['photos', 'thumbs', 'uploads'].map(
    (table) => env.PHOTOS.prepare(`DELETE FROM ${table} WHERE id IN (${marks})`).bind(...ids),
  ));
};

const deletePhoto = (env, id) => deletePhotos(env, [id]);

// A photo uploads before its rating is posted, so a closed tab or a lost race can leave one
// behind. Anything a day old that no rating uses is removed.
export async function removeOrphanPhotos(env) {
  const [, stored] = await env.PHOTOS.batch([
    env.PHOTOS.prepare('DELETE FROM uploads WHERE created < ?').bind(Date.now() - ORPHAN_MS),
    env.PHOTOS.prepare('SELECT id FROM photos WHERE id NOT IN (SELECT id FROM uploads)'),
  ]);
  // Read second, so a photo attached to a rating in between is never missed.
  const used = await env.DB.prepare('SELECT photo FROM ratings WHERE photo IS NOT NULL').all();
  const inUse = new Set(used.results.map((row) => row.photo));
  const orphans = stored.results.map((row) => row.id).filter((id) => !inUse.has(id));
  for (let i = 0; i < orphans.length; i += DELETE_SIZE) await deletePhotos(env, orphans.slice(i, i + DELETE_SIZE));
}

// Each person has one rating per dish per restaurant, so rating again updates it.
export async function saveRating(env, body, rater) {
  const note = clean(body.note, 280);
  if (!DISHES.includes(body.dish)) throw new BadRequest('Dish must be a burger or a caesar.');
  if (!isValidScore(body.score)) throw new BadRequest('Score must be 1.0 to 10.0, in tenths.');
  if (body.photo) {
    const stored = PHOTO_ID.test(body.photo) && await env.PHOTOS.prepare('SELECT 1 FROM photos WHERE id = ?').bind(body.photo).first();
    if (!stored) throw new BadRequest('That photo did not upload. Please try it again.');
  }
  const restaurant = await resolveRestaurant(env, body.restaurant);
  const score = Math.round(body.score * 10) / 10;
  const now = new Date().toISOString();
  const existing = await env.DB.prepare('SELECT * FROM ratings WHERE restaurant_id = ? AND dish = ? AND lower(rater) = lower(?)')
    .bind(restaurant.id, body.dish, rater).first();
  const statements = [...restaurant.statements];
  let replaced = null;
  if (existing) {
    // Leaving photo out keeps the current one; null removes it.
    const photo = body.photo === undefined ? existing.photo : body.photo;
    if (existing.photo && existing.photo !== photo) replaced = existing.photo;
    statements.push(env.DB.prepare('UPDATE ratings SET score = ?, note = ?, photo = ?, updated_at = ? WHERE id = ?')
      .bind(score, note, photo || null, now, existing.id));
  } else {
    // If the same person's rating lands from another tab at this moment, this one updates it.
    statements.push(env.DB.prepare(`INSERT INTO ratings (id, restaurant_id, dish, rater, score, note, photo, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (restaurant_id, dish, lower(rater)) DO UPDATE SET score = excluded.score, note = excluded.note,
        photo = coalesce(excluded.photo, ratings.photo), updated_at = excluded.updated_at`)
      .bind(crypto.randomUUID(), restaurant.id, body.dish, rater, score, note, body.photo || null, now));
  }
  // Having eaten there, it's no longer on this person's want-to-try list.
  statements.push(env.DB.prepare('DELETE FROM wishes WHERE restaurant_id = ? AND person = ?').bind(restaurant.id, rater));
  await env.DB.batch(statements);
  // Only after the rating is safely saved.
  if (replaced) await deletePhoto(env, replaced);
}

export async function deleteRating(env, id, me) {
  const rating = await env.DB.prepare('SELECT * FROM ratings WHERE id = ?').bind(id).first();
  if (!rating) throw new BadRequest('That rating is already gone.', 404);
  if (rating.rater !== me) throw new BadRequest('You can only delete your own ratings.', 403);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM ratings WHERE id = ?').bind(id),
    removeIfUnused(env, rating.restaurant_id),
  ]);
  if (rating.photo) await deletePhoto(env, rating.photo);
}

export async function saveWish(env, body, person) {
  const restaurant = await resolveRestaurant(env, body.restaurant);
  const note = clean(body.note, 280);
  await env.DB.batch([
    ...restaurant.statements,
    env.DB.prepare(`INSERT INTO wishes (id, restaurant_id, person, note, added_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (restaurant_id, person) DO UPDATE SET note = excluded.note`)
      .bind(crypto.randomUUID(), restaurant.id, person, note, new Date().toISOString()),
  ]);
}

export async function deleteWish(env, id, me) {
  const wish = await env.DB.prepare('SELECT * FROM wishes WHERE id = ?').bind(id).first();
  if (!wish) throw new BadRequest('That is already off the list.', 404);
  if (wish.person !== me) throw new BadRequest('You can only change your own list.', 403);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM wishes WHERE id = ?').bind(id),
    removeIfUnused(env, wish.restaurant_id),
  ]);
}

export async function updateRestaurant(env, id, body) {
  const restaurant = await env.DB.prepare('SELECT * FROM restaurants WHERE id = ?').bind(id).first();
  if (!restaurant) throw new BadRequest('That restaurant no longer exists.');
  const name = clean(body.name, 80);
  const area = clean(body.area, 60);
  if (!name) throw new BadRequest('Restaurants need a name.');
  const duplicate = await env.DB.prepare(`SELECT 1 FROM restaurants WHERE id != ? AND lower(name) = lower(?) AND lower(area) = lower(?)
    AND coalesce(address, '') = coalesce(?, '')`).bind(id, name, area, restaurant.address).first();
  if (duplicate) throw new BadRequest('There is already a restaurant with that name and location.');
  const details = placeDetails(body.place || {});
  if (details.placeId && details.placeId !== restaurant.place_id) {
    const taken = await env.DB.prepare('SELECT 1 FROM restaurants WHERE id != ? AND place_id = ?').bind(id, details.placeId).first();
    if (taken) throw new BadRequest('Another restaurant is already pinned to that place.');
    await env.DB.prepare('UPDATE restaurants SET name = ?, area = ?, place_id = ?, address = ?, lat = ?, lon = ?, website = NULL WHERE id = ?')
      .bind(name, area, details.placeId, details.address, details.lat, details.lon, id).run();
  } else {
    await env.DB.prepare('UPDATE restaurants SET name = ?, area = ? WHERE id = ?').bind(name, area, id).run();
  }
}
