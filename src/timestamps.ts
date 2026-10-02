export type Segment = { start: number; end: number; title: string };
type Marker = { start: number; title: string };
export type VideoMetadata = {
  filepath: string;
  title: string;
  description: string;
  chapters: Marker[];
};

export function readMetadata(value: unknown): VideoMetadata {
  if (!value || typeof value !== 'object') throw new Error('Invalid yt-dlp metadata');
  const data = value as Record<string, unknown>;
  if (typeof data.filepath !== 'string' || !data.filepath || typeof data.title !== 'string') {
    throw new Error('yt-dlp metadata is missing the final filepath or title');
  }
  const chapters: Marker[] = [];
  if (Array.isArray(data.chapters)) {
    for (const chapter of data.chapters) {
      if (!chapter || typeof chapter !== 'object' || typeof chapter.start_time !== 'number'
          || !Number.isFinite(chapter.start_time)) {
        // Partial chapter lists could omit tracks. Fall back to the description instead.
        chapters.length = 0;
        break;
      }
      chapters.push({ start: chapter.start_time, title: typeof chapter.title === 'string' ? chapter.title.trim() : '' });
    }
  }
  return {
    filepath: data.filepath,
    title: data.title,
    description: typeof data.description === 'string' ? data.description : '',
    chapters,
  };
}

function parseTime(value: string): number | undefined {
  const parts = value.split(':').map(Number);
  const seconds = parts.at(-1)!;
  if (seconds >= 60 || (parts.length === 3 && parts[1]! >= 60)) return undefined;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

function trimLabel(value: string): string {
  return value.replace(/^[\s\-–—|:]+|[\s\-–—|]+$/g, '').trim();
}

export function descriptionMarkers(description: string): Marker[] {
  const markers: Marker[] = [];
  for (const line of description.split(/\r?\n/)) {
    // Accept timestamps at either end of a track-list line, not links or prose mentions.
    const leading = line.match(/^\s*(?:(?:\d+[.)]|[-*•])\s+)?\[?(\d{1,3}:\d{2}(?::\d{2})?)\]?(?:\s+|\s*[-–—|]\s*|$)(.*)$/);
    const trailing = leading ? null : line.match(/^\s*(.+?)\s+\[?(\d{1,3}:\d{2}(?::\d{2})?)\]?\s*$/);
    if (!leading && !trailing) {
      if (/^\s*(?:(?:\d+[.)]|[-*•])\s+)?\[?\d{1,3}:\d/.test(line)) return [];
      continue;
    }
    const time = leading ? leading[1]! : trailing![2]!;
    const start = parseTime(time);
    if (start === undefined) return [];
    const label = leading ? leading[2]! : trailing![1]!;
    markers.push({ start, title: trimLabel(label.replace(/^\d+[.)]\s+/, '')) });
  }
  return markers;
}

export function formatTimestamp(seconds: number): string {
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  const remainder = String(whole % 60).padStart(2, '0');
  return minutes < 60
    ? `${String(minutes).padStart(2, '0')}:${remainder}`
    : `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${remainder}`;
}

function segmentsFromMarkers(markers: Marker[], duration: number): Segment[] {
  if (markers.length < 2 || !Number.isFinite(duration) || duration <= 0) return [];
  if (markers.some((marker, index) => !Number.isFinite(marker.start) || marker.start < 0
      || marker.start >= duration || (index > 0 && marker.start <= markers[index - 1]!.start))) return [];
  const complete = markers[0]!.start > 0 ? [{ start: 0, title: 'Intro' }, ...markers] : markers;
  return complete.map((marker, index) => ({
    start: marker.start,
    end: complete[index + 1]?.start ?? duration,
    title: marker.title || formatTimestamp(marker.start),
  }));
}

export function timestampSegments(video: VideoMetadata, duration: number): { segments: Segment[]; source: string } {
  const chapters = segmentsFromMarkers(video.chapters, duration);
  if (chapters.length) return { segments: chapters, source: 'chapters' };
  return { segments: segmentsFromMarkers(descriptionMarkers(video.description), duration), source: 'description timestamps' };
}

export function trackFilename(segment: Segment, index: number, count: number): string {
  const title = segment.title.replace(/[\x00-\x1f\x7f\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().replace(/[ .]+$/g, '');
  // Stay below common 255-byte filename limits even with multibyte track names.
  let shortened = '';
  for (const character of title) {
    if (Buffer.byteLength(shortened + character) > 180) break;
    shortened += character;
  }
  const number = String(index + 1).padStart(Math.max(2, String(count).length), '0');
  return `${number} - ${shortened || 'Untitled'}.mp3`;
}
