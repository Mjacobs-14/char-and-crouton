# Char & Crouton

Friends rate burgers and Caesar salads from 1.0 to 10.0, in tenths. A restaurant's score is the average of each person's rating.

The focus is deliberately narrow: only burgers and Caesar salads, for one group of friends. Don't add other dishes or turn this into general restaurant rating.

## Layout

- `server.js`: the Node server and API, with no dependencies. All data lives in memory and in `data/ratings.json`.
- `public/`: the page, styles and client code, in plain JavaScript with no build step.
- `public/lists.json`: published burger lists, entered by hand. Facts only (names, addresses, links), never review text. Lists don't give burger scores, so never present them as comparable numbers.
- `lib/`: accounts and sessions (`auth.js`), invite codes (`invites.js`), backups (`backup.js`) and owner tools for a hosted copy (`admin.js`).
- `public/sw.js`, `public/manifest.webmanifest`: make the app installable. The service worker must never store `/api/` or `/photos/`.
- `lib/shared.js`: rules and place lookups used by both versions. Plain JavaScript and `fetch` only.
- `worker/`, `wrangler.jsonc`: the Cloudflare version, with data in D1 (`DB` for everything, `PHOTOS` for photo bytes). Same API and response shapes as `server.js`, so `public/` and `scripts/host.js` work with either. Change one version, change both.
- `scripts/check.js`: checks the real data read-only, then tests saving on a throwaway copy.
- `scripts/check-worker.js`: runs the Cloudflare version locally on a throwaway D1 database and tests it end to end.

## Commands

- `npm start` runs the app on port 4173. `PORT` and `DATA_FILE` override the defaults.
- `npm run check` and `npm run check:worker` must both pass before a change is finished. The running app needs a restart to pick up `server.js` changes.
- `npm` scripts are blocked in this computer's PowerShell, so the user runs `node scripts/<name>.js` instead.

## Cloudflare free plan

- Stay within it: 10 ms of CPU per request, so password hashing uses PBKDF2 with `PASSWORD_ITERATIONS` from `wrangler.jsonc`. Lower it if sign-ins fail with error 1102.
- Never add R2 or anything billed. Photos live in the `PHOTOS` D1 database, under 1.9 MB each.
- Each data change runs as one `env.DB.batch`, which D1 applies all-or-nothing. Delete photos only after it succeeds.
- A schema change is a new file in `worker/migrations` or `worker/migrations-photos`. Apply it to the live database before deploying the code that needs it.

## Photos

- The browser shrinks each photo, then makes a small copy for the board (`data/thumbs`, or the `thumbs` table in `PHOTOS`). `/photos/<id>.thumb.jpg` serves it, or the full photo until one exists.
- Small copies can always be remade, so backups and the move to a host leave them out.
- A photo uploads before its rating is saved. Each upload clears photos over a day old that no rating uses (the `uploads` table records when each arrived on Cloudflare).

## Rules

- `data/` holds real ratings and photos. It is ignored by Git. Never overwrite it, and test against a copy using `DATA_FILE`.
- Every data change in `server.js` goes through `commit()`, so a failed save leaves everything as it was.
- Delete photo files only after a successful save, by returning a function from the change passed to `commit()`.
- Escape anything people typed with `esc()` before putting it in HTML.

## Accounts

- A person's identity comes only from their session, never from a request body.
- Responses use `view()`. Never send password hashes or sessions.
- Sign-ins last 90 days from the last use, renewed at most once a day.
- Wrong passwords lock out a name from one address (5 tries in 15 minutes), so a guesser can't lock the real person out. A name is only locked everywhere after 50.
- `ADMIN_TOKEN` is the key to all data. It belongs only in the host's settings (a Wrangler secret on Cloudflare), and the admin routes don't exist without it.
- Never ask for, print or commit a real password, invite code or admin token. Test with `DATA_FILE` and generated values.

## Outside services

- Photon (OpenStreetMap) provides restaurant search and nearby places. What people type in the restaurant box is sent there.
- The OpenStreetMap API provides restaurant websites, and its map images are loaded by the Map tab through Leaflet.
- Browsers only share location over https or on localhost, so nearby suggestions need the app to be online before they work on phones.

## Plan

Move to Cloudflare's free plan using the steps in the README, then keep the home version working as a fallback.
