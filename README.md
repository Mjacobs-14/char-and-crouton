# Char & Crouton

Rate burgers and Caesar salads with your friends, on a 1.0 to 10.0 scale.

## Run it

Double-click `start.bat`, or run `node server.js`. It needs [Node.js](https://nodejs.org) 18 or newer and nothing else.

The window that opens lists two addresses: one for this computer and one for friends on the same Wi-Fi. If Windows asks about the firewall, allow access on private networks so they can connect. The app is only available while that window is open.

To check that everything is working and saving correctly, run `npm run check`. It only reads your real data and does its testing on a throwaway copy.

## Accounts

Everyone signs in. To add someone, or reset a forgotten password, run this on the computer running the app and send them the code privately:

```
npm run invite -- Sam
```

The code works once, for 7 days. They choose "I have an invite code", then pick their own password. If the name already has ratings, those ratings become theirs, so only send a code to the right person.

## Burger lists

The critics' lists live in `public/lists.json`. To add or refresh one, edit that file with each restaurant's name and a link to the source. Keep to names and addresses rather than copying reviews.

## Your data

Ratings are saved in `data/ratings.json` and photos in `data/photos`. Back up the `data` folder to back up everything.

Restaurant suggestions come from [Photon](https://photon.komoot.io), a free search over OpenStreetMap, so what you type in the restaurant box is sent there. If it's unavailable, you can still add restaurants by hand. The Map tab uses OpenStreetMap's map images and looks up restaurant websites there, so it needs an internet connection.

## Backups

The app makes a dated copy of your ratings and photos in `data/backups` once a day, keeping the last 14. Run `npm run backup` for one that's kept until you delete it. To restore, stop the app and copy a backup's `ratings.json` and `photos` back into `data`.

## Going online

The app can run on any host with permanent storage. On Railway:

1. Create a project from this GitHub repository, and generate a public domain under **Settings > Networking**.
2. Add a volume to the service, mounted at `/data`.
3. Run `node scripts/host.js token` on your computer, and keep the result somewhere private.
4. Set these variables on the service:
   - `DATA_FILE` = `/data/ratings.json`
   - `TRUST_PROXY` = `1`
   - `AUTO_BACKUP_PHOTOS` = `0`
   - `ADMIN_TOKEN` = the token from step 3
5. Freeze and back up your computer's copy, then upload it to the empty host:

   ```
   node scripts/freeze.js "We've moved: https://your-link"
   node scripts/backup.js
   node scripts/host.js push
   ```

The upload checks that the host's copy matches, and it refuses to run if the host already has data. Everyone signs in again at the new link with their existing password.

On the host, invite people with `node scripts/host.js invite Name`, and save a backup to your computer with `node scripts/host.js pull`. Run the pull regularly, since the host's own automatic backups live on the same disk.

On iPhone, install it from Safari with **Share > Add to Home Screen**. On Android, use **Install app** or **Add to Home screen** in Chrome's menu.

## Moving the app

To keep one live copy, run `npm run freeze -- "We've moved: <new link>"` before copying your data. Nobody can change anything from that moment, and everyone sees the message. Undo it with `npm run freeze -- off`.

Local connections aren't encrypted, so only run the app on networks you trust until it's online with https.
