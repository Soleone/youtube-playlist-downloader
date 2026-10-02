import assert from 'node:assert/strict';
import { test } from 'node:test';
import { descriptionMarkers, formatTimestamp, readMetadata, timestampSegments, trackFilename, type VideoMetadata } from '../src/timestamps.js';

const video: VideoMetadata = { filepath: '/music/Album.mp3', title: 'Album', description: '', chapters: [] };

function fromDescription(description: string, duration = 200) {
  return timestampSegments({ ...video, description }, duration).segments;
}

test('parses common timestamp/label formats, including hours and numbered track lists', () => {
  assert.deepEqual(descriptionMarkers(`Tracklist\n00:00 - Opening Theme\n2. [03:12] Second Track\n• 1:02:03 | Third Track\n4) Final Track [1:06:00]\nhttps://example.com/?t=1:30`), [
    { start: 0, title: 'Opening Theme' }, { start: 192, title: 'Second Track' },
    { start: 3723, title: 'Third Track' }, { start: 3960, title: 'Final Track' },
  ]);
});

test('prefers chapters over description timestamps', () => {
  const result = timestampSegments({ ...video, chapters: [{ start: 0, title: 'Chapter A' }, { start: 90, title: 'Chapter B' }], description: '00:00 Wrong\n01:00 Wrong too' }, 200);
  assert.equal(result.source, 'chapters');
  assert.deepEqual(result.segments, [{ start: 0, end: 90, title: 'Chapter A' }, { start: 90, end: 200, title: 'Chapter B' }]);
});

test('falls back to description if chapters are invalid', () => {
  const result = timestampSegments({ ...video, chapters: [{ start: -1, title: 'Bad' }, { start: 90, title: 'Bad' }], description: '00:00 A\n01:00 B' }, 200);
  assert.equal(result.source, 'description timestamps');
  assert.equal(result.segments.length, 2);
});

test('covers the intro and final tail without dropping short tracks', () => {
  assert.deepEqual(fromDescription('00:10 One\n00:15 Two', 20), [
    { start: 0, end: 10, title: 'Intro' }, { start: 10, end: 15, title: 'One' }, { start: 15, end: 20, title: 'Two' },
  ]);
});

test('uses timestamps as names for unlabeled tracks', () => {
  const segments = fromDescription('00:00\n01:30');
  assert.equal(segments[0]!.title, '00:00');
  assert.equal(trackFilename(segments[1]!, 1, 2), '02 - 01-30.mp3');
  assert.equal(formatTimestamp(3723), '1:02:03');
});

test('rejects duplicate, reversed, out-of-range and malformed timelines', () => {
  for (const description of ['00:00 A\n00:00 B', '01:00 A\n00:00 B', '00:00 A\n03:20 B', '00:00 A\n00:61 B', '00:00 A\n1:60:01 B', '00:00 A\n00:10:20:30', '00:00 A\n00:10 B\n00:20:30:40', '00:00stuff\n00:10stuff']) {
    assert.deepEqual(fromDescription(description), [], description);
  }
  assert.deepEqual(fromDescription('Nothing here'), []);
  assert.deepEqual(fromDescription('00:00 Only one'), []);
  assert.deepEqual(fromDescription('00:00 A\n01:00 B', NaN), []);
});

test('sanitizes titles, prevents path traversal, and numbers duplicate labels uniquely', () => {
  const segment = { start: 0, end: 60, title: '../../Song: "Hello"?\u0000' };
  assert.equal(trackFilename(segment, 0, 2), '01 - ..-..-Song- -Hello---.mp3');
  assert.equal(trackFilename(segment, 1, 2), '02 - ..-..-Song- -Hello---.mp3');
  assert.equal(trackFilename({ ...segment, title: '.' }, 0, 101), '001 - Untitled.mp3');
  assert.ok(Buffer.byteLength(trackFilename({ ...segment, title: '🎵'.repeat(200) }, 0, 2)) < 255);
});

test('validates metadata and rejects partial chapter lists', () => {
  for (const invalid of [null, [], {}, { title: 'Album' }, { title: 'Album', filepath: '' }]) {
    assert.throws(() => readMetadata(invalid), /metadata/);
  }
  const parsed = readMetadata({ title: 'Album', filepath: '/music/a.mp3', chapters: [{ start_time: 0, title: 'Good' }, { start_time: 'bad' }] });
  assert.deepEqual(parsed.chapters, []);
  assert.equal(parsed.description, '');
});
