import { measureRequest, type RequestModel } from './score-context-request.js';

/** Preserve complete content when it fits. Otherwise sample only byte-sized local
 * requests: tokenizer-based limits can be non-monotonic and remain fail-closed. */
export function boundedArticleRequest<T extends object>(model: RequestModel, content: string, render: (text: string, sampled: boolean) => T): T | null {
  const full = render(content, false);
  if (measureRequest(model, full).fits) return full;
  if (!('kind' in model)) return null;
  const points = Array.from(content);
  const sample = (length: number) => {
    const first = Math.ceil(length / 3);
    const middle = Math.floor((length - first) / 2);
    const last = length - first - middle;
    const start = Math.floor((points.length - middle) / 2);
    return points.slice(0, first).join('') + '\n[... omitted ...]\n' + points.slice(start, start + middle).join('') + '\n[... omitted ...]\n' + (last ? points.slice(-last).join('') : '');
  };
  let low = 0, high = points.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (measureRequest(model, render(sample(mid), true)).fits) low = mid;
    else high = mid - 1;
  }
  const request = render(sample(low), true);
  return low >= 600 && measureRequest(model, request).fits ? request : null;
}
