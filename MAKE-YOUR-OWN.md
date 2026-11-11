# Make your own version

Char & Crouton rates burgers and Caesar salads. This guide swaps in two foods of your choice: tacos and margaritas, ramen and dumplings, espresso and croissants. It takes about half an hour and needs no programming beyond find-and-replace in a text editor.

The examples below turn the app into "Fold & Salt", for tacos and margaritas.

## 1. Get your own copy

1. On GitHub, press **Fork** (or **Code > Download ZIP**) to get a copy that's yours.
2. Install [Node.js](https://nodejs.org) 18 or newer.
3. In the folder, run `node server.js` and open the address it prints.
4. Make yourself an account: run `node scripts/invite.js YourName` and use the code it prints under "I have an invite code".

Your copy starts with no ratings. Everything people add is saved in a `data` folder that Git ignores, so it never ends up on GitHub.

## 2. The one rule: leave the code names alone

Inside the code, the two foods are called `burger` and `caesar`. Treat those as "food one" and "food two". They are never shown to anyone, and saved ratings, the styles and the built-in checks all rely on them.

So you change the words, emoji and colors people **see**, and leave these alone wherever they appear in lowercase inside quotes or after `data-dish`:

```
'burger'   'caesar'   data-dish="burger"   value="caesar"   entry.burger
```

Decide now which of your foods is food one (it gets the first tab and the main color) and which is food two.

## 3. Change the words

Search each file for the text on the left and replace it.

**`public/app.js`**, the first three lines. Change only the words in quotes after `board`, `plural` and `one`, and the emoji:

```js
const DISHES = {
  burger: { board: 'Tacos', plural: 'tacos', one: 'taco', other: 'caesar', otherEmoji: '🍹' },
  caesar: { board: 'Margaritas', plural: 'margaritas', one: 'margarita', other: 'burger', otherEmoji: '🌮' },
};
```

`otherEmoji` is the *other* food's emoji, so food one's line holds food two's emoji. The app writes "Rate a taco", so if your food starts with a vowel sound ("espresso"), also search for `Rate a $` and make it read naturally.

Further down the same file:

| Search for | Change |
| --- | --- |
| `'🍔'` and `'🥗'` | Your two emoji. There are several of each; change them all. |
| `'Burger' : 'Caesar'` | `'Taco' : 'Margarita'` |
| `'burger' : 'Caesar'` (in "Rate the…") | `'taco' : 'margarita'`. Change only the words after the `?`. |
| `Heard about a great burger?` | Your own line. |
| `The lists don't score burgers` | Your food. |

While you're there, `VERDICTS` just below holds the word shown beside each grade ("Legendary", "Mid", "Call the authorities"). Make them yours.

**`public/index.html`**

| Search for | Change |
| --- | --- |
| `Char &amp; Crouton` (three places) | Your app's name. Write `&` as `&amp;`. |
| `<h1 id="boardTitle">Burgers</h1>` | Food one's board name. |
| `🍔</span> Burgers` and `🥗</span> Caesars` | The two tabs. |
| `Rate a burger` | The main button. |
| `🍔 Burger` and `🥗 Caesar` | The choice in the rating form. |

**`public/manifest.webmanifest`**: `name`, `short_name` and `description`. This is what phones show when the app is installed.

**`server.js` and `worker/data.js`**: search for `Dish must be a burger or a caesar.` and reword it. In `server.js`, also change `Char & Crouton is open.`

**`scripts/check-worker.js`**: search for `Char &amp; Crouton` and put your app's name there too, written the same way as in `index.html`. The check looks for it on the page.

## 4. Change the colors

In `public/styles.css`, near the top, each food has a block of four colors:

```css
body[data-dish='burger'], dialog[data-dish='burger'] {
  --brand: #bd2c16;        /* the header and buttons */
  --brand-deep: #8f1e0d;   /* a darker shade of it */
  --brand-text: #b32812;   /* colored text on the light background */
  --accent: #f4b82e;       /* highlights */
}
```

Change the values in the `burger` and `caesar` blocks. A little lower, inside `@media (prefers-color-scheme: dark)`, each food has one more `--brand-text`: a lighter shade that stays readable on a dark background.

Then put food one's `--brand` color in two more places so the phone's status bar matches: `theme-color` in `public/index.html` and `theme_color` in `public/manifest.webmanifest`.

## 5. Change the icon

Replace the three pictures in `public/icons`, keeping the same file names and sizes:

- `icon-192.png`: 192 × 192
- `icon-512.png`: 512 × 512
- `apple-touch-icon.png`: 180 × 180

## 6. Clear the critics' lists

`public/lists.json` holds Boston burger lists. Replace the whole file with an empty list:

```json
[]
```

To add your own later, copy the shape of the original: a name, a short tag, a link to the source, `"dish": "burger"` or `"dish": "caesar"` (the code names from step 2), and each restaurant's name, address and area. Keep to facts and link to the source; don't copy review text. The "You vs. the critics" comparison only appears for food one.

## 7. Tell the place search who you are

The restaurant box uses [Photon](https://photon.komoot.io), a free search shared by many projects. In `lib/shared.js`:

- Change `CharAndCrouton/1.0` to your app's name, so your lookups aren't mistaken for someone else's.
- `PLACE_TAGS` is the kinds of places suggested nearby (restaurants, pubs, cafés and so on). If your foods come from somewhere else, add its OpenStreetMap name, such as `'bakery'` or `'ice_cream'`.

## 8. Check it

```
node scripts/check.js
```

```
node scripts/check-worker.js
```

Both should finish without failures. They test on throwaway copies and never touch your ratings. Then run `node server.js`, and look at both boards, the map and the rating form to catch any word you missed.

## 9. Put it online (optional)

The README's "Going online (Cloudflare)" section has the steps, and it's free. Two things differ for your copy:

- In `wrangler.jsonc`, change `name` and both `database_name` values to your app's name, and use those names in the README's commands.
- The two `database_id` values in that file belong to the original app and won't work for you. Step 2 of the README prints your own; paste those over them.

## 10. Tidy up (optional)

- `README.md` and `package.json` still describe burgers and Caesars.
- The screenshots in `docs/screenshots` are of the original. `scripts/screenshots.js` retakes them from the made-up restaurants in `scripts/demo-data.json`.
- `CLAUDE.md` tells AI coding assistants what the app is for. Update its first lines if you use one.

## Want more than two foods?

The app is built around exactly two: two tabs, two scores on every map pin, two color themes. A third is a real programming job rather than a find-and-replace.

## License

MIT (see [LICENSE](LICENSE)): use it, change it and share it, as long as the license file stays with it. Map data and place search come from [OpenStreetMap](https://www.openstreetmap.org/copyright) and Photon, which have their own terms.
