import { describe, expect, it } from 'vitest';
import { articleFingerprint, decodeArticleBasis, decodeChainMetadataV1, decodeHandoffReceiptV1, decodeHandoffRef, decodePreparationReceiptV1, readChainMetadata, readHandoffReceipt, readPreparationReceipt } from '../../src/server/domain/article-handoff.js';

const root = '11111111-1111-4111-8111-111111111111';
const prepare = '22222222-2222-4222-8222-222222222222';
const tags = '33333333-3333-4333-8333-333333333333';
const article = '44444444-4444-4444-8444-444444444444';
const category = '55555555-5555-4555-8555-555555555555';
const basis = { contentRevision: 1, assignmentRevision: 0, articleInputHash: articleFingerprint(null, null) };
const ref = { taskId: root, generation: 1, action: 'category' };
const receipt = { version: 1, ...ref, articleId: article, prerequisiteId: null, categoryId: category, basis, catalogEpoch: 0 };
const preparation = { version: 1, taskId: prepare, articleId: article, action: 'prepare', generation: 1, contentRevision: 1 };
const chain = { version: 1, rootTaskId: root, prepareTaskId: prepare, tagsTaskId: tags, requiredHandoff: null, requiredBasis: basis, targetCount: 0 };

describe('article handoff codecs', () => {
  it('fingerprints canonical JSON, preserving null and empty values', () => {
    expect(articleFingerprint(null, null)).toBe('95cb9b4f84ceff132cc7a875d8c192bf4997016a939ee64141c1fd628c0e8738');
    expect(articleFingerprint('', null)).toBe('c3a310bc2a4f31ef2a14e578090bcd65fc95dc82c1eed42ac8c1b35d37dd7789');
    expect(articleFingerprint(null, '')).toBe('5b5566edf47bd4fd3877699da1f2d0318a4bb4a27c138b4cbe27120580b46dd8');
    expect(articleFingerprint('title', 'source')).toBe('446fe527129af8f96c07a6bc5c4548a494e8c4a73638fba4843271a5db00df2c');
    expect(articleFingerprint('title', 'source')).toBe(articleFingerprint('title', 'source'));
    expect(articleFingerprint('other', 'source')).not.toBe(articleFingerprint('title', 'source'));
    expect(articleFingerprint('title', 'other')).not.toBe(articleFingerprint('title', 'source'));
  });

  it('accepts bounded standalone and chain records, including waiting successors and zero targets', () => {
    expect(decodeArticleBasis(basis)).toEqual(basis);
    expect(decodeHandoffRef(ref)).toEqual(ref);
    expect(decodeHandoffReceiptV1(receipt)).toEqual(receipt);
    const tagsReceipt = { ...receipt, taskId: tags, action: 'tags', prerequisiteId: root, catalogEpoch: 1 };
    expect(decodeHandoffReceiptV1(tagsReceipt)).toEqual(tagsReceipt);
    expect(decodePreparationReceiptV1(preparation)).toEqual(preparation);
    expect(readChainMetadata({ unrelated: true, articleChain: chain }, 'category')).toEqual(chain);
    const waiting = { version: 1, rootTaskId: root, prepareTaskId: prepare, requiredHandoff: ref, requiredBasis: null };
    expect(decodeChainMetadataV1(waiting, 'tags')).toEqual(waiting);
    expect(decodeChainMetadataV1({ ...waiting, requiredHandoff: { taskId: tags, generation: 1, action: 'tags' }, requiredBasis: basis }, 'scores')).not.toBeNull();
    expect(readHandoffReceipt({ handoffReceipt: receipt })).toEqual(receipt);
    expect(readPreparationReceipt({ preparationReceipt: preparation })).toEqual(preparation);
  });

  it('keeps receipt generations independent from positive chain references', () => {
    for (const sample of [receipt, { ...receipt, taskId: tags, action: 'tags', prerequisiteId: root }]) {
      for (const generation of [0, 1, 2147483647]) {
        const value = { ...sample, generation };
        expect(decodeHandoffReceiptV1(value)).toEqual(value);
        expect(readHandoffReceipt({ unrelated: true, handoffReceipt: value })).toEqual(value);
      }
      for (const generation of [-1, 0.5, 2147483648, NaN, Infinity, -Infinity, '0', null, undefined]) {
        const value = { ...sample, generation };
        expect(decodeHandoffReceiptV1(value)).toBeNull();
        expect(readHandoffReceipt({ handoffReceipt: value })).toBeNull();
      }
      const missing = { ...sample };
      Reflect.deleteProperty(missing, 'generation');
      expect(decodeHandoffReceiptV1(missing)).toBeNull();
      expect(readHandoffReceipt({ handoffReceipt: missing })).toBeNull();
    }
    expect(decodeHandoffRef({ ...ref, generation: 0 })).toBeNull();
    expect(decodePreparationReceiptV1({ ...preparation, generation: 0 })).toBeNull();
    const waiting = { version: 1, rootTaskId: root, prepareTaskId: prepare, requiredHandoff: { ...ref, generation: 0 }, requiredBasis: null };
    expect(decodeChainMetadataV1(waiting, 'tags')).toBeNull();
    expect(decodeChainMetadataV1({ ...waiting, requiredHandoff: { taskId: tags, generation: 0, action: 'tags' } }, 'scores')).toBeNull();
  });

  it('requires a distinct exact tags anchor only on category roots', () => {
    expect(decodeChainMetadataV1(chain, 'category')).toEqual(chain);
    expect(decodeChainMetadataV1({ ...chain, targetCount: 2 }, 'category')).toEqual({ ...chain, targetCount: 2 });
    const oldRoot = { ...chain };
    Reflect.deleteProperty(oldRoot, 'tagsTaskId');
    expect(decodeChainMetadataV1(oldRoot, 'category')).toBeNull();
    for (const id of [undefined, null, 1, '', 'bad', root, prepare]) {
      expect(decodeChainMetadataV1({ ...chain, tagsTaskId: id }, 'category')).toBeNull();
    }
    const letterId = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
    expect(decodeChainMetadataV1({ ...chain, rootTaskId: letterId, tagsTaskId: letterId.toUpperCase() }, 'category')).toBeNull();
    expect(decodeChainMetadataV1({ ...chain, prepareTaskId: letterId, tagsTaskId: letterId.toUpperCase() }, 'category')).toBeNull();
    const waiting = { version: 1, rootTaskId: root, prepareTaskId: prepare, requiredHandoff: ref, requiredBasis: null };
    for (const id of [tags, null, undefined]) {
      expect(decodeChainMetadataV1({ ...waiting, tagsTaskId: id }, 'tags')).toBeNull();
      expect(decodeChainMetadataV1({ ...waiting, requiredHandoff: { taskId: tags, generation: 1, action: 'tags' }, tagsTaskId: id }, 'scores')).toBeNull();
    }
    for (const [action, handoff] of [['tags', ref], ['scores', { taskId: tags, generation: 1, action: 'tags' }]] as const) {
      const hidden = { ...waiting, requiredHandoff: handoff };
      Object.defineProperty(hidden, 'tagsTaskId', { value: undefined });
      expect(decodeChainMetadataV1(hidden, action)).toBeNull();
    }
    expect(decodeChainMetadataV1({ ...waiting, requiredHandoff: { taskId: tags, generation: 1, action: 'tags' }, targetCount: 0 }, 'scores')).toBeNull();
  });

  it('rejects malformed namespaces and unknown fields, versions, identities and actions', () => {
    for (const value of [null, [], {}, { preparationReceipt: [] }, { preparationReceipt: { ...preparation, extra: 1 } }, { preparationReceipt: { ...preparation, version: 2 } }, { preparationReceipt: { ...preparation, action: 'category' } }, { preparationReceipt: { ...preparation, taskId: 'bad' } }]) expect(readPreparationReceipt(value)).toBeNull();
    for (const value of [null, [], {}, { handoffReceipt: { ...receipt, action: 'score' } }, { handoffReceipt: { ...receipt, prerequisiteId: root } }, { handoffReceipt: { ...receipt, action: 'tags' } }, { handoffReceipt: { ...receipt, basis: { ...basis, extra: true } } }]) expect(readHandoffReceipt(value)).toBeNull();
    for (const value of [null, [], {}, { ...chain, targetCount: undefined }, { ...chain, extra: true }, { ...chain, version: 2 }, { ...chain, prepareTaskId: root }, { ...chain, requiredHandoff: ref }, { ...chain, requiredBasis: null }]) expect(decodeChainMetadataV1(value, 'category')).toBeNull();
    const waiting = { version: 1, rootTaskId: root, prepareTaskId: prepare, requiredHandoff: ref, requiredBasis: null };
    expect(decodeChainMetadataV1({ ...waiting, requiredHandoff: { ...ref, taskId: tags } }, 'tags')).toBeNull();
    expect(decodeChainMetadataV1(waiting, 'scores')).toBeNull();
    expect(decodeChainMetadataV1({ ...waiting, targetCount: 0 }, 'tags')).toBeNull();
    expect(decodeHandoffRef({ ...ref, extra: 1 })).toBeNull();
    expect(readChainMetadata({ articleChain: [] }, 'category')).toBeNull();
  });

  it('rejects invalid int32 boundaries and non-lowercase or malformed hashes', () => {
    for (const n of [-1, 0.5, 2147483648, NaN, Infinity, '1', null]) {
      expect(decodeArticleBasis({ ...basis, assignmentRevision: n })).toBeNull();
      expect(decodeHandoffReceiptV1({ ...receipt, catalogEpoch: n })).toBeNull();
      expect(decodeChainMetadataV1({ ...chain, targetCount: n }, 'category')).toBeNull();
    }
    for (const n of [0, -1, 1.5, 2147483648]) {
      expect(decodeArticleBasis({ ...basis, contentRevision: n })).toBeNull();
      expect(decodeHandoffRef({ ...ref, generation: n })).toBeNull();
      expect(decodePreparationReceiptV1({ ...preparation, generation: n })).toBeNull();
      expect(decodePreparationReceiptV1({ ...preparation, contentRevision: n })).toBeNull();
    }
    for (const hash of ['', 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(63)]) expect(decodeArticleBasis({ ...basis, articleInputHash: hash })).toBeNull();
    expect(decodeArticleBasis({ ...basis, contentRevision: 2147483647, assignmentRevision: 2147483647 })).not.toBeNull();
  });
});
