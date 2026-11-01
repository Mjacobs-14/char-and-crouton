# Char & Crouton

Rate burgers and Caesar salads with your friends, on a 1.0 to 10.0 scale.

## Run it

Double-click `start.bat`, or run `node server.js`. It needs [Node.js](https://nodejs.org) 18 or newer and nothing else.

The window that opens lists two addresses: one for this computer and one for friends on the same Wi-Fi. If Windows asks about the firewall, allow access on private networks so they can connect. The app is only available while that window is open.

To check that everything is working and saving correctly, run `npm run check`. It only reads your real data and does its testing on a throwaway copy.

## Burger lists

The critics' lists live in `public/lists.json`. To add or refresh one, edit that file with each restaurant's name and a link to the source. Keep to names and addresses rather than copying reviews.

## Your data

Ratings are saved in `data/ratings.json` and photos in `data/photos`. Back up the `data` folder to back up everything.

Restaurant suggestions come from [Photon](https://photon.komoot.io), a free search over OpenStreetMap, so what you type in the restaurant box is sent there. If it's unavailable, you can still add restaurants by hand. The Map tab uses OpenStreetMap's map images and looks up restaurant websites there, so it needs an internet connection.

There are no passwords: anyone on your network with the link can post under any name, so only run it on networks you trust.
