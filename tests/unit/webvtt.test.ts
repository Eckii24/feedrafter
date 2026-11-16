import { describe, expect, it } from 'vitest';
import { parseWebVtt } from '../../src/server/domain/webvtt.js';

const options = { language: 'de-CH', method: 'automatic-subtitles:source-v1', duration: 4000, maxInputBytes: 10000 };
const parse = (text: string) => parseWebVtt(text, options);

describe('parseWebVtt', () => {
  it('accepts a header-only empty transcript and retains supplied metadata', () => {
    expect(parse('\uFEFFWEBVTT description\r\n\r\n')).toEqual({
      language: options.language, method: options.method, duration: options.duration, cues: [],
    });
    expect(parse('WEBVTT').cues).toEqual([]);
  });

  it('parses identifiers, settings, multiline text, both timestamp forms and line endings', () => {
    const input = '\uFEFFWEBVTT subtitles\r\n\r\nfirst cue\r\n00:01.125 --> 00:03.500 line:10%,start position:50%,center size:80% align:start vertical:rl region:main\r\nHallo\r\nWelt\r\n\r\n01:00:00.000 --> 01:00:01.250\r\nlast';
    expect(parse(input)).toEqual({
      language: options.language, method: options.method, duration: options.duration,
      cues: [{ start: 1.125, end: 3.5, text: 'Hallo Welt' }, { start: 3600, end: 3601.25, text: 'last' }],
    });
  });

  it.each([
    '00:00.000 --> 00:01.000 ',
    '00:00.000 --> 00:01.000 align:start\t',
  ])('accepts trailing horizontal whitespace on timing line %j', timing => {
    expect(parse(`WEBVTT\n\n${timing}\nspeech`).cues).toEqual([{ start: 0, end: 1, text: 'speech' }]);
  });

  it('skips NOTE, STYLE and REGION blocks without hiding subsequent cues', () => {
    expect(parse('WEBVTT\n\nNOTE heading\ncomment\n\nSTYLE\n::cue { color: red; }\n\nREGION\nid:main\n\n00:00.000 --> 00:01.000\nhello\n\nNOTE\nend').cues)
      .toEqual([{ start: 0, end: 1, text: 'hello' }]);
  });

  it('strips supported balanced presentation markup and decodes WebVTT entities once', () => {
    const result = parse('WEBVTT\n\n00:00.000 --> 00:01.000\n<v Alice><c.green><b>Hello</b> <i>world</i></c></v> &amp; &lt;b&gt; &gt; &nbsp; &lrm;&rlm;\n<lang de><u>ja</u></lang> <ruby>字<rt>ji</rt></ruby>');
    expect(result.cues[0]!.text).toBe('Hello world & <b> > \u00a0 \u200e\u200f ja 字ji');
  });

  it('normalizes duplicate overlaps but preserves distinct speech, touching cues and gaps', () => {
    expect(parse('WEBVTT\n\n00:04.000 --> 00:05.000\nsame\n\n00:00.000 --> 00:02.000\n<b>same</b>\n\n00:01.000 --> 00:03.000\nsame\n\n00:01.000 --> 00:02.000\nother\n\n00:05.000 --> 00:06.000\nsame').cues).toEqual([
      { start: 0, end: 3, text: 'same' }, { start: 1, end: 2, text: 'other' },
      { start: 4, end: 5, text: 'same' }, { start: 5, end: 6, text: 'same' },
    ]);
  });

  it.each([
    '', 'webvtt\n\n', 'WEBVTTx\n\n', ' WEBVTT\n\n', 'WEBVTT --> bad\n\n',
    'WEBVTT\n00:00.000 --> 00:01.000\nspeech', 'WEBVTT\nheader metadata\n\n',
    'WEBVTT\n\nidentifier', 'WEBVTT\n\n00:00.000 --> 00:01.000',
    'WEBVTT\n\n00:00.000 --> 00:01.000\nspeech\n00:01.000 --> 00:02.000\nmore',
    'WEBVTT\n\nNOTE\n00:00.000 --> 00:01.000\nspeech',
    'WEBVTT\n\n00:00.000 --> 00:01.000\nspeech\n\nSTYLE\n::cue {}',
    'WEBVTT\n\n00:00.000 --> 00:01.000\n\u0000',
  ])('rejects invalid document structure %#', input => {
    expect(() => parse(input)).toThrow();
  });

  it.each([
    '0:01.000 --> 00:02.000', '00:60.000 --> 01:01.000', '60:00.000 --> 61:00.000',
    '00:00:60.000 --> 00:01:01.000', '00:00.00 --> 00:01.000',
    '00:00,000 --> 00:01,000', '00:00.000 --> 00:00.000',
    '00:02.000 --> 00:01.000', '00:00.000 --> 01:06:41.000',
    '99999999999999999999:00:00.000 --> 99999999999999999999:00:01.000',
    '00:00.000 --> 00:01.000 bogus:x', '00:00.000 --> 00:01.000 size:101%',
    '00:00.000 --> 00:01.000 align:start align:end', '00:00.000 --> 00:01.000 line:oops',
    '00:00.000 --> 00:01.000 bogus:x ', '00:00.000 --> 00:01.000 align:bad\t',
    '00:00.000 --> 00:01.000 align:start\u00a0',
  ])('rejects invalid timing or settings %s', timing => {
    expect(() => parse(`WEBVTT\n\n${timing}\nspeech`)).toThrow();
  });

  it.each(['<script>speech</script>', '<b>speech</i>', '<b>speech', '<00:00:00.500>speech', '<v A&copy;>speech</v>', 'speech &copy;', 'speech &#65;', 'speech &', 'speech > text', '<br>speech', '<b> </b>'])('rejects unsupported or malformed markup/entity %s', text => {
      expect(() => parse(`WEBVTT\n\n00:00.000 --> 00:01.000\n${text}`)).toThrow();
    });

  it('validates duration and UTF-8 byte limit, including on an empty transcript', () => {
    for (const duration of [0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => parseWebVtt('WEBVTT', { ...options, duration })).toThrow(RangeError);
    }
    for (const maxInputBytes of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => parseWebVtt('WEBVTT', { ...options, maxInputBytes })).toThrow(RangeError);
    }
    const text = 'WEBVTT\n\n00:00.000 --> 00:01.000\né';
    const bytes = Buffer.byteLength(text);
    expect(parseWebVtt(text, { ...options, maxInputBytes: bytes }).cues[0]!.text).toBe('é');
    expect(() => parseWebVtt(text, { ...options, maxInputBytes: bytes - 1 })).toThrow(RangeError);
  });
});
