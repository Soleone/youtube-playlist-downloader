#!/usr/bin/env node
// Records the browser demo (demo/browser) as the README loop, and the hero from the track listing.
// Usage: npm run media:capture. Needs agent-browser (with its browser installed) and FFmpeg on the PATH.
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { record } from '@soleone/showcase/capture';

const exec = promisify(execFile);
const media = path.resolve('docs/media');
const viewport = { width: 960, height: 720 };
// Everything below the page title: the hint buttons and the terminal. The hero is the terminal only.
const crop = 'iw:ih*29/36:0:ih*7/36';
const heroCrop = 'iw:ih*22/36:0:ih*14/36';
const playlist = 'https://www.youtube.com/playlist?list=PL-sample-mixes';
const commands = [
  [`yt-download --timestamp-split "${playlist}"`, `window.terminalText().includes('Done!')`],
  ['ls -R downloads', `window.terminalText().includes('07 - Fog Lifts.mp3')`],
];

const out = await mkdtemp(path.join(os.tmpdir(), 'yt-download-demo-'));
const port = String(4400 + (process.pid % 500));
const server = spawn('node_modules/.bin/showcase', ['terminal', '--out', path.join(out, 'browser'), '--serve', '--port', port], {
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve, reject) => {
  createInterface({ input: server.stdout }).on('line', (line) => line.startsWith('Serving at') && resolve());
  server.once('exit', (code) => reject(new Error(`showcase terminal exited with status ${code}`)));
});
const shot = path.join(out, 'last.png');
try {
  const { frames, durationMs, grid } = await record({
    url: `http://127.0.0.1:${port}/`,
    out: path.join(media, 'demo.webp'),
    viewport,
    width: viewport.width,
    crop,
    attempts: 3,
    async start(page) {
      await page.waitFor(`!document.querySelector("#hints button").disabled`, { timeoutMs: 60_000 });
      await page.run('eval', `document.querySelector("textarea").focus()`);
      await page.run('keyboard', 'type', 'clear');
      await page.run('press', 'Enter');
      await page.sleep(800);
    },
    async drive(page) {
      await page.sleep(700);
      for (const [index, [command, done]] of commands.entries()) {
        // Ctrl-L clears the screen without a visible command, so each output starts at the top.
        if (index) await page.run('press', 'Control+l');
        // A script click: the accessibility lookup cannot match the quotes in the hint's name.
        await page.run('eval', `[...document.querySelectorAll('#hints button')].find((button) => button.textContent === ${JSON.stringify(command)}).click()`);
        await page.waitFor(done, { timeoutMs: 60_000 });
        await page.sleep(2500);
      }
      // The hero is the last output: the named tracks.
      await page.run('screenshot', shot);
    },
  });
  await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', shot, '-vf', `crop=${heroCrop}`, path.join(media, 'hero.png')]);
  console.log(`Wrote docs/media/demo.webp (${frames} frames, ${(durationMs / 1000).toFixed(1)} s) and docs/media/hero.png. Check the frames in ${grid}.`);
} finally {
  server.kill();
  await rm(out, { recursive: true, force: true });
}
