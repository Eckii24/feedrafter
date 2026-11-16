import { describe, expect, it } from 'vitest';
import { normalizeTranscriptCues, type TimestampedTranscript, type TranscriptCue } from '../../src/server/domain/transcript-cues.js';

const transcript = (cues: TranscriptCue[]): TimestampedTranscript => ({
  language: 'de-CH', method: 'automatic-subtitles:source-v1', duration: 30, cues,
});

describe('normalizeTranscriptCues', () => {
  it('orders by start, end and text deterministically without mutating input', () => {
    const input = transcript([
      { start: 5, end: 7, text: 'later' },
      { start: 1, end: 4, text: 'z' },
      { start: 1, end: 3, text: 'b' },
      { start: 1, end: 3, text: 'a' },
    ]);
    const before = structuredClone(input);
    const expected = [input.cues[3], input.cues[2], input.cues[1], input.cues[0]];
    expect(normalizeTranscriptCues(input).cues).toEqual(expected);
    expect(normalizeTranscriptCues({ ...input, cues: [...input.cues].reverse() }).cues).toEqual(expected);
    expect(input).toEqual(before);
  });

  it('unions exact and partially overlapping identical text, even across other cues', () => {
    const input = transcript([
      { start: 2, end: 5, text: ' hello\n world ' },
      { start: 2, end: 5, text: 'hello world' },
      { start: 3, end: 4, text: 'different' },
      { start: 4, end: 8, text: 'hello\tworld' },
      { start: 7, end: 9, text: 'hello world' },
    ]);
    const result = normalizeTranscriptCues(input);
    expect(result.cues).toEqual([
      { start: 2, end: 9, text: 'hello world' },
      { start: 3, end: 4, text: 'different' },
    ]);
    expect(normalizeTranscriptCues(result)).toEqual(result);
  });

  it('keeps distinct overlapping speech, repeated speech without overlap, and gaps', () => {
    const result = normalizeTranscriptCues(transcript([
      { start: 0, end: 2, text: 'one two' },
      { start: 1, end: 3, text: 'two three' },
      { start: 2, end: 4, text: 'one two' },
      { start: 6, end: 8, text: 'one two' },
    ]));
    expect(result.cues).toEqual([
      { start: 0, end: 2, text: 'one two' },
      { start: 1, end: 3, text: 'two three' },
      { start: 2, end: 4, text: 'one two' },
      { start: 6, end: 8, text: 'one two' },
    ]);
  });

  it('preserves language, method, duration and non-ASCII whitespace', () => {
    const input = transcript([{ start: 0, end: 30, text: '\u00a0Guten  Tag\u00a0' }]);
    expect(normalizeTranscriptCues(input)).toEqual({
      language: input.language, method: input.method, duration: input.duration,
      cues: [{ start: 0, end: 30, text: '\u00a0Guten Tag\u00a0' }],
    });
    expect(normalizeTranscriptCues(transcript([])).cues).toEqual([]);
  });

  it.each([
    [-1, 1], [1, 1], [2, 1], [0, 31], [NaN, 1], [0, NaN], [Infinity, Infinity], [0, Infinity],
  ])('rejects invalid interval [%s, %s)', (start, end) => {
    expect(() => normalizeTranscriptCues(transcript([{ start, end, text: 'speech' }]))).toThrow(RangeError);
  });

  it.each([0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid duration %s', duration => {
    expect(() => normalizeTranscriptCues({ ...transcript([]), duration })).toThrow(RangeError);
  });

  it.each(['', ' \t\r\n', '\u00a0', null])('rejects empty or non-string text %s', text => {
    expect(() => normalizeTranscriptCues(transcript([{ start: 0, end: 1, text: text as string }]))).toThrow(TypeError);
  });
});
