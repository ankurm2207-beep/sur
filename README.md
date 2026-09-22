# Sur: your own ad-free music player

Sur is a web app you can install on your phone and laptop.

- **Your library:** add MP3/M4A/FLAC files you own. Title, artist and cover art are read from the file tags, including Hindi (Devanagari) tags. Songs are stored in the browser on that device, so they play offline.
- **Liked songs, playlists, queue, shuffle, repeat.** Lock-screen and headphone controls work too.
- **Discover:** free, legal music from the Internet Archive (vintage Hindi 78s, Indian classical, ghazals and more) and Jamendo (600k+ Creative Commons songs). Tap ♥ to keep a song. Use ••• > "Save for offline" to download it to the device.
- **Server library (optional):** put MP3s on your own hosting so every device sees the same songs.

## 1. Put it online (5 minutes, free, GitHub Pages)

1. Create a new **public** repo on GitHub, e.g. `sur`.
2. Upload every file in this folder to the repo root (drag and drop in the GitHub web UI works).
3. In the repo, go to **Settings > Pages**. Under "Build and deployment", pick **Deploy from a branch**, then choose `main` / `/ (root)` and click Save.
4. After about a minute, open `https://<your-username>.github.io/sur/`.

Any static host works too (your own server, Netlify, Cloudflare Pages). It must be served over **https**, or the install and offline features won't work.

To install it:

- **Android (Chrome):** open the site, then tap ⋮ > **Install app**.
- **iPhone (Safari):** tap Share > **Add to Home Screen**.
- **Laptop (Chrome/Edge):** click the install icon in the address bar.

## 2. Add your songs

Open Library > **Add songs**, or drag files onto the window.

Songs added this way are stored **on that device only**. Add them separately on your phone and laptop, or use the server library below.

## 3. Optional: one library for all devices

1. Copy your MP3s into the `library/` folder (subfolders are fine; a `cover.jpg` in a folder becomes the album art).
2. Run `pip install mutagen`, then `python3 make_library.py`. This rewrites `library/songs.json`.
3. Upload the `library/` folder along with the app.

Every device then shows these songs under Library > **Server**.

⚠️ Keep your own purchased music **out of a public GitHub repo**, because anyone can download it from there. Use a private host instead (your own server with a password, or a private Netlify/Cloudflare site with access control).

## 4. Optional: Jamendo

Go to Discover > **Jamendo**. Create a free app at https://devportal.jamendo.com/ and paste its Client ID. It is saved in that browser only.

## Customize

- **Greeting name:** change `OWNER` near the top of `app.js`.
- **Colors and fonts:** edit the tokens at the top of `styles.css`.
- **Discover shelves:** edit the `IA_PRESETS` and `JM_PRESETS` lists in `app.js`.
- **After changing files:** bump `CACHE = 'sur-v1'` in `sw.js` so installed copies pick up the update.

## Rights note

Only add music you own or that is licensed for free use. In India, sound recordings enter the public domain 60 years after release. The underlying lyrics and composition can stay protected for longer. Internet Archive items are uploaded by anyone, so modern film songs there are usually not licensed.
