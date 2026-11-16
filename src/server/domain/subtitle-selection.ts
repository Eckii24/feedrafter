export type SubtitleTrack = {
  id: string;
  language: string;
  format: string;
  provenance: 'human' | 'automatic';
};

export type SupportedSubtitleLanguage = 'de' | 'en';

export type SubtitleSelection = {
  selected: { language: SupportedSubtitleLanguage; track: SubtitleTrack }[];
  missing: SupportedSubtitleLanguage[];
};

const supportedLanguages: readonly SupportedSubtitleLanguage[] = ['de', 'en'];

function validateTrack(value: unknown): SubtitleTrack {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Invalid subtitle track');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError('Invalid subtitle track');
  const fields = Reflect.ownKeys(value);
  if (fields.length !== 4 || !['id', 'language', 'format', 'provenance'].every(field => fields.includes(field))) {
    throw new TypeError('Invalid subtitle track fields');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (fields.some(field => !('value' in descriptors[field as string]!))) throw new TypeError('Invalid subtitle track fields');
  const { id, language, format, provenance } = value as Record<string, unknown>;
  // IDs are opaque tokens, not paths or URLs. They must be unique within a candidate set.
  if (typeof id !== 'string' || !/^[A-Za-z0-9._~-]+$/.test(id)) throw new TypeError('Invalid subtitle track ID');
  if (typeof language !== 'string') throw new TypeError('Invalid subtitle language');
  try {
    if (Intl.getCanonicalLocales(language).length !== 1) throw new TypeError('Invalid subtitle language');
  } catch {
    throw new TypeError('Invalid subtitle language');
  }
  if (typeof format !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(format)) throw new TypeError('Invalid subtitle format');
  if (provenance !== 'human' && provenance !== 'automatic') throw new TypeError('Invalid subtitle provenance');
  return { id, language, format, provenance };
}

// Selection does not inspect content; the chosen VTT must still pass parseWebVtt.
export function selectSubtitleTracks(candidates: unknown): SubtitleSelection {
  if (!Array.isArray(candidates)) throw new TypeError('Invalid subtitle candidates');
  const tracks = Array.from(candidates, validateTrack);
  const ids = new Set<string>();
  for (const track of tracks) {
    if (ids.has(track.id)) throw new TypeError('Duplicate subtitle track ID');
    ids.add(track.id);
  }

  const selected: SubtitleSelection['selected'] = [];
  const missing: SubtitleSelection['missing'] = [];
  for (const language of supportedLanguages) {
    const matching = tracks.filter(track => track.language.split('-')[0]!.toLowerCase() === language && track.format.toLowerCase() === 'vtt');
    matching.sort((a, b) =>
      (a.provenance === b.provenance ? 0 : a.provenance === 'human' ? -1 : 1) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (matching[0]) selected.push({ language, track: matching[0] });
    else missing.push(language);
  }
  return { selected, missing };
}
