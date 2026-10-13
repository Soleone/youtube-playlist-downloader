// Stand-in for ffprobe in the browser demo: reads the duration the yt-dlp stand-in wrote into its placeholder MP3.
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args.includes('-version')) {
  console.log('ffprobe version 7.1.1 (demo stand-in)');
  process.exit(0);
}
const file = args.at(-1);
try {
  console.log(String(JSON.parse(readFileSync(file, 'utf8')).duration));
} catch {
  console.error(`${file}: Invalid data found when processing input`);
  process.exit(1);
}
