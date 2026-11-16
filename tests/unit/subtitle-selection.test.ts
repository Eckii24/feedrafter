import { describe, expect, it } from 'vitest';
import { selectSubtitleTracks, type SubtitleTrack } from '../../src/server/domain/subtitle-selection.js';
import { parseWebVtt } from '../../src/server/domain/webvtt.js';

const track = (id: string, language: string, provenance: SubtitleTrack['provenance'], format = 'vtt'): SubtitleTrack =>
  ({ id, language, provenance, format });

describe('selectSubtitleTracks', () => {
  it('prefers human tracks, falls back to automatic, and preserves original metadata', () => {
    const de = track('de-human', 'DE-ch', 'human', 'VTT');
    const en = track('en-auto', 'en-US', 'automatic');
    const input = [track('de-auto', 'de', 'automatic'), en, de];
    const before = structuredClone(input);
    expect(selectSubtitleTracks(input)).toEqual({
      selected: [{ language: 'de', track: de }, { language: 'en', track: en }], missing: [],
    });
    expect(input).toEqual(before);
    const transcript = parseWebVtt('WEBVTT', { language: en.language, method: en.provenance, duration: 1, maxInputBytes: 100 });
    expect(transcript).toMatchObject({ language: 'en-US', method: 'automatic' });
  });

  it('breaks ties by opaque ID regardless of candidate order or language variant', () => {
    const input = [track('z', 'de', 'human'), track('a', 'de-AT', 'human'), track('b', 'EN-gb', 'automatic'), track('a-en', 'en', 'automatic')];
    const expected = { selected: [{ language: 'de', track: input[1] }, { language: 'en', track: input[3] }], missing: [] };
    expect(selectSubtitleTracks(input)).toEqual(expected);
    expect(selectSubtitleTracks([...input].reverse())).toEqual(expected);
  });

  it('reports unsupported languages and formats as missing rather than translating or guessing', () => {
    expect(selectSubtitleTracks([track('fr', 'fr', 'human'), track('srt', 'de-DE', 'human', 'srt'), track('other', 'eng', 'human')]))
      .toEqual({ selected: [], missing: ['de', 'en'] });
    expect(selectSubtitleTracks([track('one', 'en-Latn-US', 'human')]))
      .toEqual({ selected: [{ language: 'en', track: track('one', 'en-Latn-US', 'human') }], missing: ['de'] });
    const fallback = track('auto', 'de', 'automatic');
    expect(selectSubtitleTracks([track('human', 'de', 'human', 'srt'), fallback]))
      .toEqual({ selected: [{ language: 'de', track: fallback }], missing: ['en'] });
    expect(selectSubtitleTracks([])).toEqual({ selected: [], missing: ['de', 'en'] });
  });

  it.each([
    null, {}, [null], [42], [track('', 'de', 'human')], [track('https://example.com/vtt', 'de', 'human')],
    [track('path/file', 'de', 'human')], [track('a', '', 'human')], [track('a', 'en_US', 'human')],
    [track('a', 'de-', 'human')], [track('a', 'de', 'human', '')],
    [{ ...track('a', 'de', 'human'), provenance: 'generated' }],
    [{ ...track('a', 'de', 'human'), url: 'https://example.com' }],
    [{ ...track('a', 'de', 'human'), endpoint: 'example' }],
    [{ id: 'a', language: 'de', format: 'vtt' }],
    [track('same', 'de', 'human'), track('same', 'en', 'human')],
    [track('valid', 'de', 'human'), { ...track('bad', 'fr', 'human'), url: 'x' }],
    new Array(1),
  ])('rejects malformed input %# even when a candidate is unsupported', input => {
    expect(() => selectSubtitleTracks(input)).toThrow(TypeError);
  });

  it('rejects extra symbol keys and accessor properties', () => {
    const withSymbol = { ...track('a', 'de', 'human'), [Symbol('extra')]: 'x' };
    const withGetter = { ...track('a', 'de', 'human'), get id() { throw new Error('must not read getter'); } };
    expect(() => selectSubtitleTracks([withSymbol])).toThrow(TypeError);
    expect(() => selectSubtitleTracks([withGetter])).toThrow(TypeError);
  });
});
