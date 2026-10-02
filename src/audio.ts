import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { trackFilename, type Segment, type VideoMetadata } from './timestamps.js';

export function runCommand(command: string, args: string[], capture = false): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code !== 0) reject(new Error(`${command} failed (${signal ?? code})${stderr ? `: ${stderr.slice(-3000).trim()}` : ''}`));
      else resolve({ stdout, stderr });
    });
  });
}

export async function audioDuration(file: string): Promise<number> {
  const { stdout } = await runCommand('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file], true);
  const duration = Number(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Cannot determine audio duration: ${file}`);
  return duration;
}

export async function silenceSegments(file: string, duration: number): Promise<Segment[]> {
  if (duration < 900) return [];
  const { stderr } = await runCommand('ffmpeg', ['-nostdin', '-hide_banner', '-i', file, '-af', 'silencedetect=noise=-35dB:d=1.2', '-f', 'null', '-'], true);
  const boundaries = [0];
  for (const match of stderr.matchAll(/silence_end:\s*([0-9.]+)/g)) {
    const cut = Number(match[1]);
    if (cut - boundaries.at(-1)! >= 45 && duration - cut >= 45) boundaries.push(cut);
  }
  if (boundaries.length < 2) return [];
  return boundaries.map((start, index) => ({ start, end: boundaries[index + 1] ?? duration, title: `Part ${String(index + 1).padStart(2, '0')}` }));
}

async function existingDirectory(path: string): Promise<boolean> {
  const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!stat) return false;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Track output is not a regular directory: ${path}`);
  return true;
}

export async function splitAudio(video: VideoMetadata, segments: Segment[], force: boolean): Promise<boolean> {
  if (segments.length < 2) throw new Error('Splitting requires at least two tracks');
  const directory = join(dirname(video.filepath), `${basename(video.filepath, '.mp3')} - tracks`);
  const exists = await existingDirectory(directory);
  if (exists && !force) {
    console.log(`→ Skipping existing track folder: ${directory} (use --force to overwrite)`);
    return false;
  }
  const staging = await mkdtemp(join(dirname(video.filepath), '.yt-tracks-'));
  let createdDirectory = false;
  const published: string[] = [];
  try {
    for (const [index, segment] of segments.entries()) {
      const output = join(staging, trackFilename(segment, index, segments.length));
      await runCommand('ffmpeg', [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-n',
        '-ss', segment.start.toFixed(3), '-i', video.filepath, '-t', (segment.end - segment.start).toFixed(3),
        '-map', '0:a:0', '-c:a', 'copy', '-map_metadata', '-1',
        '-metadata', `title=${segment.title}`, '-metadata', `track=${index + 1}/${segments.length}`,
        '-metadata', `album=${video.title}`, output,
      ], true);
    }
    // No existing tracks are touched until every ffmpeg cut succeeds.
    if (!exists) {
      await mkdir(directory);
      createdDirectory = true;
    }
    for (const [index, segment] of segments.entries()) {
      const name = trackFilename(segment, index, segments.length);
      await rename(join(staging, name), join(directory, name));
      published.push(join(directory, name));
    }
    console.log(`✓ ${segments.length} tracks → ${directory} (original retained)`);
    return true;
  } catch (error) {
    if (createdDirectory) {
      for (const path of published) await rm(path, { force: true });
      await rm(directory, { recursive: true, force: true });
    }
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
