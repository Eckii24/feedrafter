export interface SearchResult { title: string; url: string; snippet: string }
export interface SearchResponse { provider: 'DuckDuckGo' | 'Bing RSS'; results: SearchResult[] }
export interface WebSearch {
  search(query: string, maxResults?: number, signal?: AbortSignal): Promise<SearchResponse>;
}
