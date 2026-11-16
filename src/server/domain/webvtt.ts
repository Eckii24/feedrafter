import { normalizeTranscriptCues, type TimestampedTranscript, type TranscriptCue } from './transcript-cues.js';

type WebVttOptions = { language: string; method: string; duration: number; maxInputBytes: number };

const timestampPattern = '(?:[0-9]{2,}:)?[0-9]{2}:[0-9]{2}\\.[0-9]{3}';
const timingLine = new RegExp(`^(${timestampPattern})[ \\t]+-->[ \\t]+(${timestampPattern})(?:[ \\t]+(.*))?$`);

function timestamp(value: string): number {
  const parts = value.split(':');
  const seconds = parts.pop()!;
  const minutes = Number(parts.pop());
  const hours = parts.length ? Number(parts[0]) : 0;
  const [wholeSeconds, milliseconds] = seconds.split('.').map(Number) as [number, number];
  const total = ((hours * 60 + minutes) * 60 + wholeSeconds) * 1000 + milliseconds;
  if (minutes > 59 || wholeSeconds > 59 || !Number.isSafeInteger(total)) throw new RangeError('Invalid WebVTT timestamp');
  return total / 1000;
}

function validateSettings(settings: string): void {
  const seen = new Set<string>();
  const percent = '(?:100(?:\\.0+)?|(?:[0-9]|[1-9][0-9])(?:\\.[0-9]+)?)%';
  const patterns: Record<string, RegExp> = {
    vertical: /^(?:rl|lr)$/,
    line: new RegExp(`^(?:auto|-?[0-9]+|${percent})(?:,(?:start|center|end))?$`),
    position: new RegExp(`^${percent}(?:,(?:line-left|center|line-right|auto))?$`),
    size: new RegExp(`^${percent}$`),
    align: /^(?:start|center|end|left|right)$/,
    region: /^[^\s:]+$/,
  };
  for (const setting of settings.split(/[ \t]+/)) {
    const match = /^([a-z]+):([^\s]+)$/.exec(setting);
    if (!match) throw new SyntaxError('Invalid WebVTT cue setting');
    const name = match[1]!;
    const value = match[2]!;
    if (!Object.hasOwn(patterns, name) || seen.has(name) || !patterns[name]!.test(value)) {
      throw new SyntaxError('Invalid WebVTT cue setting');
    }
    seen.add(name);
  }
}

function cueText(input: string): string {
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', nbsp: '\u00a0', lrm: '\u200e', rlm: '\u200f' };
  const stack: string[] = [];
  let result = '';
  for (let i = 0; i < input.length;) {
    if (input[i] === '&') {
      const match = /^&([a-z]+);/.exec(input.slice(i));
      if (!match || !Object.hasOwn(entities, match[1]!)) throw new SyntaxError('Unsupported WebVTT entity');
      result += entities[match[1]!]!;
      i += match[0].length;
    } else if (input[i] === '<') {
      const match = /^<([^<>\n]*)>/.exec(input.slice(i));
      if (!match) throw new SyntaxError('Invalid WebVTT markup');
      const tag = match[1]!;
      if (/^\/(?:b|i|u|c|v|lang|ruby|rt)$/.test(tag)) {
        if (stack.pop() !== tag.slice(1)) throw new SyntaxError('Unbalanced WebVTT markup');
      } else {
        const open = /^(b|i|u|ruby|rt|c(?:\.[A-Za-z0-9_-]+)*|v[ \t]+[^<>&\s][^<>&\n]*|lang[ \t]+[A-Za-z0-9-]+)$/.exec(tag);
        if (!open) throw new SyntaxError('Unsupported WebVTT markup');
        stack.push(tag.split(/[. \t]/)[0]!);
      }
      i += match[0].length;
    } else {
      if (input[i] === '>') throw new SyntaxError('Invalid WebVTT markup');
      result += input[i++];
    }
  }
  if (stack.length) throw new SyntaxError('Unbalanced WebVTT markup');
  return result;
}

// Parses supplied text only. Empty transcripts require a valid WEBVTT header.
export function parseWebVtt(input: string, options: WebVttOptions): TimestampedTranscript {
  const { language, method, duration, maxInputBytes } = options;
  if (!Number.isSafeInteger(maxInputBytes) || maxInputBytes < 0) throw new RangeError('Invalid WebVTT byte limit');
  if (typeof input !== 'string') throw new TypeError('Invalid WebVTT input');
  if (Buffer.byteLength(input, 'utf8') > maxInputBytes) throw new RangeError('WebVTT input exceeds byte limit');
  // Validate duration even when there are no cues.
  normalizeTranscriptCues({ language, method, duration, cues: [] });
  for (const character of input) {
    const code = character.charCodeAt(0);
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) {
      throw new SyntaxError('Invalid WebVTT control character');
    }
  }
  const lines = input.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
  const header = lines[0]!;
  if (!/^WEBVTT(?:[ \t]+[^\r\n]*)?$/.test(header) || header.includes('-->')) throw new SyntaxError('Invalid WebVTT header');
  if (lines.length > 1 && lines[1] !== '') throw new SyntaxError('Invalid WebVTT header separator');
  const cues: TranscriptCue[] = [];
  let index = 1;
  let seenCue = false;
  while (index < lines.length) {
    while (index < lines.length && lines[index] === '') index++;
    if (index === lines.length) break;
    const block: string[] = [];
    while (index < lines.length && lines[index] !== '') block.push(lines[index++]!);
    if (/^NOTE(?:[ \t].*)?$/.test(block[0]!) || block[0] === 'STYLE' || block[0] === 'REGION') {
      if ((block[0] === 'STYLE' || block[0] === 'REGION') && seenCue) throw new SyntaxError('WebVTT metadata after cue');
      if (block.some(line => line.includes('-->'))) throw new SyntaxError('Invalid WebVTT metadata');
      continue;
    }
    seenCue = true;
    const timingIndex = block[0]!.includes('-->') ? 0 : 1;
    if (timingIndex === 1 && block[0]!.trim() === '') throw new SyntaxError('Invalid WebVTT cue identifier');
    const match = timingLine.exec(block[timingIndex] ?? '');
    if (!match || block.length <= timingIndex + 1) throw new SyntaxError('Invalid WebVTT cue');
    const settings = match[3]?.replace(/^[ \t]+|[ \t]+$/g, '');
    if (settings) validateSettings(settings);
    const text = block.slice(timingIndex + 1);
    if (text.some(line => line.includes('-->'))) throw new SyntaxError('Invalid WebVTT cue text');
    cues.push({ start: timestamp(match[1]!), end: timestamp(match[2]!), text: cueText(text.join('\n')) });
  }
  return normalizeTranscriptCues({ language, method, duration, cues });
}
