# Browser demo

The live demo at https://yt-download.soleone.xyz: the real CLI in a WebContainers sandbox, with stand-ins for yt-dlp, ffmpeg and ffprobe (`home/.demo`) that know one invented sample playlist (`home/.demo/catalog.json`). Nothing is downloaded and the MP3s are placeholders without sound.

```sh
npm run build   # the sandbox runs the compiled CLI from dist/src
npm run demo    # builds this folder into dist/browser and serves it at http://127.0.0.1:4321
```

Deploy `dist/browser` as a static site; it includes the `vercel.json` with the COOP/COEP headers the sandbox needs.
