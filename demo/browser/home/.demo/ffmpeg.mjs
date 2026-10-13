// Stand-in for ffmpeg in the browser demo. It answers the two jobs the CLI gives it, using the placeholder MP3s the
// yt-dlp stand-in wrote: silence detection (from the sample's listed silences) and cutting a track (a smaller placeholder).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

if (args.includes('-version')) {
  console.log('ffmpeg version 7.1.1 (demo stand-in)');
  process.exit(0);
}

const input = option('-i');
let audio;
try {
  audio = JSON.parse(readFileSync(input, 'utf8'));
} catch {
  console.error(`${input}: Invalid data found when processing input`);
  process.exit(1);
}

if (args.includes('-af')) {
  await sleep(600);
  for (const [start, end] of audio.silences ?? []) {
    console.error(`[silencedetect @ 0x5f3c2a1b8e40] silence_start: ${start}`);
    console.error(`[silencedetect @ 0x5f3c2a1b8e40] silence_end: ${end} | silence_duration: ${(end - start).toFixed(3)}`);
  }
  process.exit(0);
}

const output = args.at(-1);
if (args.includes('-n') && existsSync(output)) {
  console.error(`File '${output}' already exists. Exiting.`);
  process.exit(1);
}
const metadata = Object.fromEntries(
  args.flatMap((value, index) => (args[index - 1] === '-metadata' ? [value.split(/=(.*)/s).slice(0, 2)] : [])),
);
await sleep(80);
writeFileSync(output, JSON.stringify({
  placeholder: audio.placeholder,
  duration: Number(option('-t')),
  ...metadata,
}) + '\n');
