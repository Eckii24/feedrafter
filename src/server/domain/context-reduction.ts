export type ChunkEvidence = { questionId: string; polarity: 'support' | 'counter' | 'uncertain'; text: string; refs: { chunkId: string; start: number; end: number; quote: string }[] };
export type ChunkCompletion = { chunkId: string; evidence: ChunkEvidence[] };
