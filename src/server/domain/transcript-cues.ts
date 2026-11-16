export type TranscriptCue = { start: number; end: number; text: string };

export type TimestampedTranscript = {
  language: string;
  method: string;
  duration: number;
  cues: readonly TranscriptCue[];
};

// Times are seconds, in half-open intervals bounded by the supplied duration.
export function normalizeTranscriptCues(transcript: TimestampedTranscript): TimestampedTranscript {
  const { duration } = transcript;
  if (!Number.isFinite(duration) || duration <= 0 || duration > Number.MAX_SAFE_INTEGER) {
    throw new RangeError('Invalid transcript duration');
  }

  const cues = transcript.cues.map(({ start, end, text }) => {
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= end || end > duration) {
      throw new RangeError('Invalid cue interval');
    }
    if (typeof text !== 'string') throw new TypeError('Invalid cue text');
    const normalized = text.replace(/[ \t\r\n]+/g, ' ').replace(/^ | $/g, '');
    if (!normalized.trim()) throw new TypeError('Invalid cue text');
    return { start, end, text: normalized };
  });

  const compare = (a: TranscriptCue, b: TranscriptCue): number =>
    a.start - b.start || a.end - b.end || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0);
  cues.sort(compare);

  const result: TranscriptCue[] = [];
  const lastByText = new Map<string, TranscriptCue>();
  for (const cue of cues) {
    const previous = lastByText.get(cue.text);
    if (previous && cue.start < previous.end) {
      previous.end = Math.max(previous.end, cue.end);
    } else {
      result.push(cue);
      lastByText.set(cue.text, cue);
    }
  }
  result.sort(compare);
  return { ...transcript, cues: result };
}
