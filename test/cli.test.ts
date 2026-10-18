import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cli = join(root, 'bin', 'yt-download');
const hasAudioTools = ['ffmpeg', 'ffprobe'].every((tool) => spawnSync(tool, ['-version']).status === 0);
const realFfmpeg = (process.env.PATH ?? '').split(delimiter).map((path) => join(path, 'ffmpeg')).find(existsSync);

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'yt-cli-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  const output = join(root, 'output with spaces');
  const source = join(root, 'source.mp3');
  await mkdir(bin);
  await execute('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-q:a', '2', source]);
  await writeFile(join(bin, 'yt-dlp'), `#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('2026.03.17'); process.exit(0); }
writeFileSync(process.env.FAKE_ARGUMENTS, JSON.stringify(args));
if (process.env.FAKE_FAIL) { console.error('simulated download failure'); process.exit(8); }
let records = JSON.parse(process.env.FAKE_METADATA).map((record, index) => ({ ...record, playlist_index: index + 1 }));
const selection = args.indexOf('--playlist-items');
if (selection !== -1) {
  const range = args[selection + 1];
  if (!/^-[1-9]\\d*:$/.test(range)) throw new Error('Unexpected playlist selection: ' + range);
  records = records.slice(Number(range.slice(0, -1)));
}
for (const record of records) {
  const index = record.playlist ? String(record.playlist_index).padStart(2, '0') : '01';
  record.filepath = join(args[args.indexOf('--paths') + 1], record.playlist ?? record.title, index + ' - ' + record.title + '.mp3');
  mkdirSync(dirname(record.filepath), { recursive: true });
  if (!existsSync(record.filepath) || args.includes('--force-overwrites')) copyFileSync(process.env.FAKE_SOURCE, record.filepath);
}
const print = args.indexOf('--print-to-file');
if (print !== -1) writeFileSync(args[print + 2], records.map(record => JSON.stringify(record)).join('\\n') + '\\n');
`, { mode: 0o755 });
  const metadata = [{ title: 'Album', description: '00:00 - Opening\n00:02 - Song / Two\n00:04 - Finale', chapters: [] }];
  const env = {
    ...process.env, HOME: root, PATH: `${bin}${delimiter}${process.env.PATH}`,
    FAKE_ARGUMENTS: join(root, 'arguments.json'), FAKE_SOURCE: source, FAKE_METADATA: JSON.stringify(metadata),
  };
  const run = (args = ['--timestamp-split'], overrides = {}) => execute(process.execPath, [cli, ...args, 'https://www.youtube.com/watch?v=offline', output], { env: { ...env, ...overrides } });
  const original = join(output, 'Album', '01 - Album.mp3');
  const tracks = join(output, 'Album', '01 - Album - tracks');
  return { root, bin, source, output, original, tracks, env, run };
}

async function installFailingFfmpeg(bin: string) {
  await writeFile(join(bin, 'ffmpeg'), `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args.at(-1)?.includes('02 -')) { console.error('simulated second cut failure'); process.exit(9); }
const result = spawnSync(${JSON.stringify(realFfmpeg)}, args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
`, { mode: 0o755 });
}

test('help and invalid options do not launch a downloader', async () => {
  const { stdout } = await execute(process.execPath, [cli, '--help'], { env: { ...process.env, PATH: '' } });
  assert.match(stdout, /--timestamp-split/);
  assert.match(stdout, /--last N/);
  await assert.rejects(execute(process.execPath, [cli, '--unknown']), /Unknown option/);
  await assert.rejects(execute(process.execPath, [cli, '--timestamp-split', '--split', 'https://youtube.com/']), /Choose --split or --timestamp-split/);
  await assert.rejects(execute(process.execPath, [cli], { env: { ...process.env, PATH: '' } }), /Provide a YouTube URL/);
  await assert.rejects(execute(process.execPath, [cli, 'file:\/\/tmp\/audio.mp3']), /URL must start/);
});

test('--last rejects missing, non-positive, fractional, and unsafe counts before launching tools', async () => {
  for (const count of ['0', '-1', '1.5', 'abc', 'Infinity', '9007199254740992']) {
    await assert.rejects(execute(process.execPath, [cli, `--last=${count}`, 'https://youtube.com/'], { env: { ...process.env, PATH: '' } }), /--last must be a positive whole number/);
  }
  await assert.rejects(execute(process.execPath, [cli, '--last']), /argument missing|requires an argument/);
});

test('--last appends selected songs with original numbering and preserves existing songs', { skip: !hasAudioTools }, async (t) => {
  const f = await fixture(t);
  const records = Array.from({ length: 8 }, (_, index) => ({ title: `Song ${index + 1}`, playlist: 'Playlist' }));
  const overrides = { FAKE_METADATA: JSON.stringify(records) };
  const folder = join(f.output, 'Playlist');
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, '01 - Song 1.mp3'), 'older song');
  await writeFile(join(folder, '07 - Song 7.mp3'), 'existing song');
  await f.run(['--last', '5'], overrides);
  const args = JSON.parse(await readFile(f.env.FAKE_ARGUMENTS, 'utf8'));
  assert.equal(args[args.indexOf('--playlist-items') + 1], '-5:');
  assert.deepEqual(await readdir(folder), ['01 - Song 1.mp3', ...records.slice(-5).map((record, index) => `0${index + 4} - ${record.title}.mp3`)]);
  assert.equal(await readFile(join(folder, '01 - Song 1.mp3'), 'utf8'), 'older song');
  assert.equal(await readFile(join(folder, '07 - Song 7.mp3'), 'utf8'), 'existing song');
  await writeFile(join(folder, '08 - Song 8.mp3'), 'replace me');
  await f.run(['--last', '1', '--force'], overrides);
  assert.deepEqual(await readFile(join(folder, '08 - Song 8.mp3')), await readFile(f.source));
  await f.run(['--last', '20'], overrides);
  assert.equal((await readdir(folder)).length, 8);
});

test('--last works with timestamp splitting and skips unselected recordings', { skip: !hasAudioTools }, async (t) => {
  const f = await fixture(t);
  await f.run(['--last', '1', '--timestamp-split'], { FAKE_METADATA: JSON.stringify([
    { title: 'Unselected' },
    { title: 'Album', description: '00:00 Opening\n00:03 Finale' },
  ]) });
  assert.deepEqual(await readdir(f.output), ['Album']);
  assert.deepEqual(await readdir(f.tracks), ['01 - Opening.mp3', '02 - Finale.mp3']);
});

test('downloads, splits with sequential names and ID3 tags, and preserves the source', { skip: !hasAudioTools }, async (t) => {
  const f = await fixture(t);
  const { stdout } = await f.run();
  assert.match(stdout, /description timestamps/);
  assert.deepEqual(await readdir(f.tracks), ['01 - Opening.mp3', '02 - Song - Two.mp3', '03 - Finale.mp3']);
  assert.deepEqual(await readFile(f.original), await readFile(f.source));
  const { stdout: metadata } = await execute('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:format_tags=title,track,album', '-of', 'json', join(f.tracks, '02 - Song - Two.mp3')]);
  const info = JSON.parse(metadata).format;
  assert.ok(Math.abs(Number(info.duration) - 2) < 0.15);
  assert.deepEqual(info.tags, { title: 'Song / Two', track: '2/3', album: 'Album' });
  const args = JSON.parse(await readFile(f.env.FAKE_ARGUMENTS, 'utf8'));
  assert.ok(args.includes(`node:${process.execPath}`));
  assert.ok(args.includes('--no-overwrites'));
  assert.equal(args[args.indexOf('--print-to-file') + 1], 'after_move:%()j');
  assert.ok(!args.includes('--split-chapters'));
});

test('skips existing track folders, and force replaces generated tracks without deleting unrelated files', { skip: !hasAudioTools }, async (t) => {
  const f = await fixture(t);
  await f.run();
  const track = join(f.tracks, '01 - Opening.mp3');
  await writeFile(track, 'existing track');
  await writeFile(join(f.tracks, 'notes.txt'), 'keep me');
  const { stdout } = await f.run();
  assert.match(stdout, /Skipping existing track folder/);
  assert.equal(await readFile(track, 'utf8'), 'existing track');
  await f.run(['--force', '--timestamp-split']);
  assert.notEqual(await readFile(track, 'utf8'), 'existing track');
  assert.equal(await readFile(join(f.tracks, 'notes.txt'), 'utf8'), 'keep me');
});

test('chapters take priority and separate videos cannot overwrite each other', { skip: !hasAudioTools }, async (t) => {
  const f = await fixture(t);
  const records = ['First album', 'Second album'].map((title) => ({ title, description: '00:00 Wrong\n00:03 Wrong too', chapters: [{ start_time: 0, end_time: 3, title: 'Same name' }, { start_time: 3, end_time: 6, title: 'Same name' }] }));
  const { stdout } = await f.run([], { FAKE_METADATA: JSON.stringify(records) });
  assert.match(stdout, /Done/);
  // Plain downloads do not split at all.
  assert.deepEqual(await readdir(join(f.output, 'First album')), ['01 - First album.mp3']);
  await f.run(['--timestamp-split'], { FAKE_METADATA: JSON.stringify(records) });
  for (const title of ['First album', 'Second album']) {
    assert.deepEqual(await readdir(join(f.output, title, `01 - ${title} - tracks`)), ['01 - Same name.mp3', '02 - Same name.mp3']);
  }
});

test('no usable timestamps leaves the full recording untouched', { skip: !hasAudioTools }, async (t) => {
  const f = await fixture(t);
  const { stdout } = await f.run(['--timestamp-split'], { FAKE_METADATA: JSON.stringify([{ title: 'Album', description: 'No timestamps here' }]) });
  assert.match(stdout, /No usable timestamps/);
  assert.deepEqual(await readdir(join(f.output, 'Album')), ['01 - Album.mp3']);
  assert.deepEqual(await readFile(f.original), await readFile(f.source));
});

test('failed cuts clean up staging, retain originals, and leave existing tracks unchanged', { skip: !hasAudioTools }, async (t) => {
  const f = await fixture(t);
  await installFailingFfmpeg(f.bin);
  await assert.rejects(f.run(), /simulated second cut failure/);
  assert.deepEqual(await readdir(join(f.output, 'Album')), ['01 - Album.mp3']);
  assert.deepEqual(await readFile(f.original), await readFile(f.source));
  await rm(join(f.bin, 'ffmpeg'));
  await f.run();
  const before = await readFile(join(f.tracks, '01 - Opening.mp3'));
  await installFailingFfmpeg(f.bin);
  await assert.rejects(f.run(['--force', '--timestamp-split']), /simulated second cut failure/);
  assert.deepEqual(await readFile(join(f.tracks, '01 - Opening.mp3')), before);
  assert.ok(!(await readdir(join(f.output, 'Album'))).some((name) => name.startsWith('.yt-tracks-')));
});

test('download failures return a nonzero exit without splitting', { skip: !hasAudioTools }, async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.run(['--timestamp-split'], { FAKE_FAIL: '1' }), /yt-dlp failed \(8\)/);
  await assert.rejects(access(f.original));
  assert.deepEqual(await readdir(f.output), []);
});

test('timestamp mode never uses silence; --split preserves short tails when using silence', { skip: !hasAudioTools }, async (t) => {
  const f = await fixture(t);
  await execute('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=8000:duration=901', '-af', "volume=0:enable='between(t,100,102)+between(t,150,152)+between(t,860,862)'", '-b:a', '8k', f.source]);
  const overrides = { FAKE_METADATA: JSON.stringify([{ title: 'Album', description: 'No timestamps' }]) };
  const strict = await f.run(['--timestamp-split'], overrides);
  assert.match(strict.stdout, /No usable timestamps/);
  await assert.rejects(access(f.tracks));
  const automatic = await f.run(['--split'], overrides);
  assert.match(automatic.stdout, /silence detection/);
  assert.deepEqual(await readdir(f.tracks), ['01 - Part 01.mp3', '02 - Part 02.mp3', '03 - Part 03.mp3']);
  const { stdout } = await execute('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', join(f.tracks, '03 - Part 03.mp3')]);
  assert.ok(Number(stdout.trim()) > 740, 'Short final fragment must be retained, not discarded');
  assert.deepEqual(await readFile(f.original), await readFile(f.source));
});

test('rejects symlink track folders rather than overwriting their targets', { skip: !hasAudioTools }, async (t) => {
  const f = await fixture(t);
  await f.run([]);
  const unrelated = join(f.root, 'unrelated');
  await mkdir(unrelated);
  await writeFile(join(unrelated, '01 - Opening.mp3'), 'keep me');
  await symlink(unrelated, f.tracks, 'dir');
  await assert.rejects(f.run(['--force', '--timestamp-split']), /not a regular directory/);
  assert.equal(await readFile(join(unrelated, '01 - Opening.mp3'), 'utf8'), 'keep me');
});

test('bin executable works from another directory and is registered as the npm command', async () => {
  const { stdout } = await execute(cli, ['--help'], { cwd: tmpdir() });
  assert.match(stdout, /Usage: yt-download/);
  assert.match(stdout, /--timestamp-split/);
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.bin['yt-download'], 'bin/yt-download');
});

test('npm start exposes the same CLI', async () => {
  const { stdout } = await execute('npm', ['start', '--', '--help'], { cwd: root });
  assert.match(stdout, /Usage: yt-download/);
});

test('real yt-dlp after_move metadata is compatible (local HTTP fixture, no YouTube access)', { skip: !hasAudioTools || spawnSync('yt-dlp', ['--version']).status !== 0 }, async (t) => {
  const f = await fixture(t);
  const bytes = await readFile(f.source);
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': bytes.length });
    response.end(bytes);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const { stdout } = await execute(process.execPath, [cli, '--timestamp-split', `http://127.0.0.1:${address.port}/fixture.mp3`, f.output]);
  assert.match(stdout, /No usable timestamps/);
  const files = await readdir(f.output, { recursive: true });
  assert.ok(files.some((file) => file.endsWith('.mp3')));
  const repeated = await execute(process.execPath, [cli, '--timestamp-split', `http://127.0.0.1:${address.port}/fixture.mp3`, f.output]);
  assert.match(repeated.stdout, /No usable timestamps/, 'Already downloaded files must still provide metadata for splitting');
  assert.deepEqual(await readdir(f.output, { recursive: true }), files);
});
