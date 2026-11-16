/** Permission only; callers must independently validate URLs and enforce public-fetch safety. */
export interface SourceFallbackPermission {
  resolveForArticle(articleId: string, originalHostname: string): Promise<boolean | null>;
  resolveHost(hostname: string): Promise<boolean>;
}
