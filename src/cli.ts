import { createReadStream } from 'node:fs';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { createInterface as createPrompt } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { audioDuration, runCommand, silenceSegments, splitAudio } from './audio.js';
import { readMetadata, timestampSegments } from './timestamps.js';

const HELP = `YouTube Playlist Downloader

Usage: yt-download [options] URL [output_directory]
       ./bin/yt-download [options] URL [output_directory]

Downloads MP3 audio into ./downloads by default.

  --timestamp-split  Split by chapters, then description timestamps. No silence fallback.
  --split            Split by timestamps, then silence detection for recordings >=15 minutes.
  --force            Overwrite downloads and generated tracks.
  --help, -h         Show this help.

Tracks are sequentially numbered using timestamp labels, or the timestamp if unlabeled.
Each recording gets a separate track folder. The original MP3 is always retained.
Requires Node.js 22+, yt-dlp (with EJS support), and ffmpeg. Splitting also needs ffprobe.
`;

async function requireTool(command: string, args: string[], hint: string): Promise<void> {
  try {
    await runCommand(command, args, true);
  } catch (error) {
    throw new Error(`${command} is missing or unusable. ${hint}`, { cause: error });
  }
}

async function splitDownloads(manifest: string, silenceFallback: boolean, force: boolean): Promise<void> {
  const lines = createInterface({ input: createReadStream(manifest), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const video = readMetadata(JSON.parse(line));
      video.filepath = resolve(video.filepath);
      await access(video.filepath);
      const duration = await audioDuration(video.filepath);
      let { segments, source } = timestampSegments(video, duration);
      if (!segments.length && silenceFallback) {
        segments = await silenceSegments(video.filepath, duration);
        source = 'silence detection';
      }
      if (!segments.length) {
        console.log(`→ No usable ${silenceFallback ? 'split points' : 'timestamps'}: ${video.title}. Keeping full MP3.`);
        continue;
      }
      console.log(`→ Splitting ${video.title} by ${source}...`);
      await splitAudio(video, segments, force);
    }
  } finally { lines.close(); }
}

export async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      force: { type: 'boolean' },
      split: { type: 'boolean' },
      'timestamp-split': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(HELP);
    return;
  }
  if (positionals.length > 2) throw new Error('Expected a URL and optional output directory. Use --help for usage.');
  if (values.split && values['timestamp-split']) throw new Error('Choose --split or --timestamp-split, not both.');
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 or newer is required.');
  let url = positionals[0];
  if (!url) {
    if (!process.stdin.isTTY) throw new Error('Provide a YouTube URL. Use --help for usage.');
    const prompt = createPrompt({ input: process.stdin, output: process.stdout });
    try { url = (await prompt.question('YouTube playlist/video URL: ')).trim(); }
    finally { prompt.close(); }
    if (!url) return;
  }
  const parsedUrl = new URL(url);
  if (!['https:', 'http:'].includes(parsedUrl.protocol)) throw new Error('URL must start with https:// or http://');
  const output = resolve(positionals[1] ?? './downloads');
  const split = Boolean(values.split || values['timestamp-split']);
  const force = Boolean(values.force);
  process.env.PATH = `${join(homedir(), '.local', 'bin')}${delimiter}${process.env.PATH ?? ''}`;
  await requireTool('yt-dlp', ['--version'], 'Install with: pipx install "yt-dlp[default]"');
  await requireTool('ffmpeg', ['-version'], 'Install ffmpeg with your system package manager.');
  if (split) await requireTool('ffprobe', ['-version'], 'Install ffmpeg (which includes ffprobe).');
  await mkdir(output, { recursive: true });
  console.log(`→ ${output}`);
  console.log(`→ Downloading (${force ? 'overwrite mode' : 'skipping existing files'})...`);
  const temporary = await mkdtemp(join(tmpdir(), 'yt-download-'));
  try {
    const manifest = join(temporary, 'downloads.jsonl');
    const args = [
      '--ignore-config', '--no-simulate', '--no-split-chapters',
      '-x', '--audio-format', 'mp3', '--audio-quality', '0', '--embed-thumbnail', '--add-metadata',
      '--no-js-runtimes', '--js-runtimes', `node:${process.execPath}`,
      '--paths', output, '--output', '%(playlist,title)s/%(playlist_index,autonumber)02d - %(title)s.%(ext)s',
      force ? '--force-overwrites' : '--no-overwrites',
    ];
    if (split) {
      await writeFile(manifest, '');
      args.push('--print-to-file', 'after_move:%()j', manifest);
    }
    args.push('--', url);
    await runCommand('yt-dlp', args);
    if (split) await splitDownloads(manifest, Boolean(values.split), force);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  console.log(`✓ Done! → ${output}`);
}
