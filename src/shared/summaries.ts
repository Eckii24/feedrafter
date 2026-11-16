/** Last successful summary and the content basis used to produce it. */
export type ArticleSummary = {
  articleId: string;
  text: string;
  contentRevision: number;
  limitation: string | null;
  completedAt: Date;
};

export function validSummaryString(value: string): boolean {
  return !/\0|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(value);
}

export function validSummaryText(value: unknown): value is string {
  return typeof value === 'string' && !!value.trim() && validSummaryString(value) && new TextEncoder().encode(value).length <= 16384;
}
