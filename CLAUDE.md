# Char & Crouton

Friends rate burgers and Caesar salads from 1.0 to 10.0, in tenths. A restaurant's score is the average of each person's rating.

The focus is deliberately narrow: only burgers and Caesar salads, for one group of friends. Don't add other dishes or turn this into general restaurant rating.

## Layout

- `server.js`: the Node server and API, with no dependencies. All data lives in memory and in `data/ratings.json`.
- `public/`: the page, styles and client code, in plain JavaScript with no build step.
- `public/lists.json`: published burger lists, entered by hand. Facts only (names, addresses, links), never review text. Lists don't give burger scores, so never present them as comparable numbers.
- `scripts/check.js`: checks the real data read-only, then tests saving on a throwaway copy.

## Commands

- `npm start` runs the app on port 4173. `PORT` and `DATA_FILE` override the defaults.
- `npm run check` must pass before a change is finished. The running app needs a restart to pick up `server.js` changes.

## Rules

- `data/` holds real ratings and photos. It is ignored by Git. Never overwrite it, and test against a copy using `DATA_FILE`.
- Every data change in `server.js` goes through `commit()`, so a failed save leaves everything as it was.
- Delete photo files only after a successful save, by returning a function from the change passed to `commit()`.
- Escape anything people typed with `esc()` before putting it in HTML.

## Outside services

- Photon (OpenStreetMap) provides restaurant search and nearby places. What people type in the restaurant box is sent there.
- The OpenStreetMap API provides restaurant websites, and its map images are loaded by the Map tab through Leaflet.
- Browsers only share location over https or on localhost, so nearby suggestions need the app to be online before they work on phones.

## Plan

Add the remaining features first, then put the app online with accounts and a real database, moving photos to online storage.
