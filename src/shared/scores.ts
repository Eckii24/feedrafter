export type ScoreContext = { includeTitle: boolean; includeContent: boolean; includeCategory: boolean; includeTagWeights: boolean; includeSourceWeight: boolean };
export type ScoreDefinitionInput = ScoreContext & { name: string; description: string; prompt: string; active: boolean };
export type ScoreDefinition = ScoreDefinitionInput & { id: string; deletedAt: Date | null };
export type ArticleScore = { articleId: string; scoreId: string; value: number; calculatedAt: Date; contentRevision: number; assignmentRevision: number; condensed: boolean; limited: boolean };

export function validateScore(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) throw new RangeError("score must be a finite number between 0 and 100");
  return value;
}

export function validateScoreDefinition(input: ScoreDefinitionInput): ScoreDefinitionInput {
  if (!input || typeof input.name !== "string" || !input.name.trim() || typeof input.prompt !== "string" || !input.prompt.trim() || typeof input.description !== "string" || [input.active, input.includeTitle, input.includeContent, input.includeCategory, input.includeTagWeights, input.includeSourceWeight].some(value => typeof value !== "boolean")) throw new RangeError("invalid score definition");
  return input;
}
