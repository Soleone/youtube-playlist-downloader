// Stand-in for yt-dlp in the browser demo: nothing is fetched from YouTube. It knows the sample playlist in
// catalog.json, prints yt-dlp-style progress and writes small placeholder MP3s that the ffmpeg and ffprobe stand-ins read.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const catalog = JSON.parse(readFileSync(new URL('./catalog.json', import.meta.url), 'utf8'));
const args = process.argv.slice(2);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const sample = `https://www.youtube.com/playlist?list=${catalog.playlist.id}`;

if (args.includes('--version')) {
  console.log('2026.08.19 (demo stand-in)');
  process.exit(0);
}

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

const url = args[args.indexOf('--') + 1] ?? args.at(-1);
let parsed;
try { parsed = new URL(url); } catch { fail(`'${url}' is not a valid URL.`); }
if (!/(^|\.)youtube\.com$|^youtu\.be$/.test(parsed.hostname)) fail(`Unsupported URL: ${url}`);
const listId = parsed.searchParams.get('list');
const videoId = parsed.hostname === 'youtu.be' ? parsed.pathname.slice(1) : parsed.searchParams.get('v');
const offline = 'This demo runs offline in your browser and only knows the sample playlist and its videos.';
if (listId && listId !== catalog.playlist.id) fail(`[youtube:tab] ${listId}: ${offline} Try ${sample}`);
if (!listId && !catalog.videos[videoId]) fail(`[youtube] ${videoId ?? url}: ${offline} Try ${sample}`);

const output = resolve(option('--paths') ?? '.');
const force = args.includes('--force-overwrites');
const printTo = args.includes('--print-to-file') ? args[args.indexOf('--print-to-file') + 2] : undefined;
const playlist = listId ? catalog.playlist : undefined;
const ids = playlist ? playlist.videos : [videoId];

async function progress(sizeMiB) {
  const seconds = Math.max(2, Math.round(sizeMiB / 9.5));
  for (let step = 1; step <= 12; step++) {
    const percent = (step / 12) * 100;
    const eta = Math.round(seconds * (1 - step / 12));
    process.stdout.write(`\r[download] ${percent.toFixed(1).padStart(5)}% of ${sizeMiB.toFixed(2).padStart(7)}MiB at  ${(9 + step / 6).toFixed(2)}MiB/s ETA 00:0${eta}`);
    await sleep(90);
  }
  process.stdout.write(`\r[download] 100% of ${sizeMiB.toFixed(2).padStart(7)}MiB in 00:00:0${seconds} at 9.71MiB/s          \n`);
}

if (playlist) {
  console.log(`[youtube:tab] Extracting URL: ${url}`);
  await sleep(150);
  console.log(`[youtube:tab] ${playlist.id}: Downloading webpage`);
  await sleep(200);
  console.log(`[download] Downloading playlist: ${playlist.title}`);
  console.log(`[youtube:tab] Playlist ${playlist.title}: Downloading ${ids.length} items of ${ids.length}`);
}

for (const [index, id] of ids.entries()) {
  const video = catalog.videos[id];
  if (playlist) console.log(`[download] Downloading item ${index + 1} of ${ids.length}`);
  console.log(`[youtube] Extracting URL: https://www.youtube.com/watch?v=${id}`);
  await sleep(120);
  console.log(`[youtube] ${id}: Downloading webpage`);
  await sleep(120);
  console.log(`[info] ${id}: Downloading 1 format(s): 251`);
  // The CLI's output template: %(playlist,title)s/%(playlist_index,autonumber)02d - %(title)s.%(ext)s
  const filepath = join(output, playlist?.title ?? video.title, `${String(index + 1).padStart(2, '0')} - ${video.title}.mp3`);
  if (existsSync(filepath) && !force) {
    console.log(`[download] ${filepath} has already been downloaded`);
  } else {
    console.log(`[download] Destination: ${filepath.replace(/\.mp3$/, '.webm')}`);
    await progress(video.sizeMiB);
    console.log(`[ExtractAudio] Destination: ${filepath}`);
    await sleep(250);
    mkdirSync(dirname(filepath), { recursive: true });
    writeFileSync(filepath, JSON.stringify({
      placeholder: 'Demo audio: nothing was downloaded, so there is no sound.',
      duration: video.duration,
      silences: video.silences ?? [],
    }) + '\n');
    console.log(`Deleting original file ${filepath.replace(/\.mp3$/, '.webm')} (pass -k to keep)`);
    console.log(`[Metadata] Adding metadata to "${filepath}"`);
    console.log(`[EmbedThumbnail] ffmpeg: Adding thumbnail to "${filepath}"`);
  }
  if (printTo) {
    const chapters = video.chapters.map((chapter, number) => ({
      ...chapter,
      end_time: video.chapters[number + 1]?.start_time ?? video.duration,
    }));
    const info = { id, title: video.title, description: video.description, duration: video.duration, chapters, filepath };
    appendFileSync(printTo, JSON.stringify(info) + '\n');
  }
}
if (playlist) console.log(`[download] Finished downloading playlist: ${playlist.title}`);
