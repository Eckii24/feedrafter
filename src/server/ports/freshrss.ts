export interface FreshRssEntry {
  id: string;
  title: string | null;
  url: string | null;
  author: string | null;
  publishedAt: Date | null;
  feedId: string | null;
  feedTitle: string | null;
}

export interface FreshRssPage {
  items: FreshRssEntry[];
  continuation: string | null;
}

export interface FreshRssPort {
  listUnreadPage(continuation?: string, signal?: AbortSignal): Promise<FreshRssPage>;
  markRead(ids: readonly string[], signal: AbortSignal): Promise<void>;
  getReadState(ids: readonly string[], signal: AbortSignal): Promise<ReadonlyMap<string, boolean>>;
}
