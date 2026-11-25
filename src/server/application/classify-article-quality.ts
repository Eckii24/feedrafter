import type { AiPort, ClassificationRequest } from '../ports/ai.js';
import type { ArticleQualityClassifier } from './prepare-article.js';
import { copyRequestModel, measureRequest, validateRequestModel, type RequestModel } from './score-context-request.js';

export class QualityClassifierPause extends Error {
  readonly kind: 'paused_budget' | 'paused_auth' | 'paused_configuration';
  readonly reason: 'daily_limit' | 'concurrency_limit' | 'auth_required' | 'configuration_required';
  constructor(outcome: { kind: 'paused_budget'; reason: 'daily_limit' | 'concurrency_limit' } | { kind: 'paused_auth' } | { kind: 'paused_configuration' }) {
    super('Quality classifier paused');
    this.name = 'QualityClassifierPause';
    this.kind = outcome.kind;
    this.reason = outcome.kind === 'paused_budget' ? outcome.reason : outcome.kind === 'paused_auth' ? 'auth_required' : 'configuration_required';
  }
}

/** Explicit seam only: the caller must supply a request sizing policy for the actual classifier. */
export function createArticleQualityClassifier(ai: Pick<AiPort, 'classify'>, policy: RequestModel): ArticleQualityClassifier {
  validateRequestModel(policy);
  const model = copyRequestModel(policy);
  return Object.freeze({
    async classify(input: { text: string; sourceUrl: string }, signal: AbortSignal, taskId: string) {
      if (!input || typeof input.text !== 'string' || !input.text.trim() || typeof taskId !== 'string' || !taskId.trim()) throw new RangeError('Invalid quality input');
      signal.throwIfAborted();
      const request: ClassificationRequest = {
        model: { ...model.model }, role: 'quality', state: { text: input.text },
        questions: { usable: { type: 'bool', instructions: 'Is this extracted text usable as the main content of an article?', criteria: { true: 'Usable article content', false: 'Missing or unusable article content' } } },
      };
      let sampled = false;
      if (!measureRequest(model, request).fits) {
        sampled = true;
        // Sample only with the byte-based policy, whose serialized size is monotonic.
        // A verified tokenizer need not be monotonic, so retain its fail-closed behavior.
        if (!('kind' in model)) throw new RangeError('Quality request exceeds verified limits');
        const points = Array.from(input.text);
        request.questions.usable = { type: 'bool', instructions: 'Are these excerpts from the beginning, middle and end usable as article content? These are samples, not the complete text; do not assume omitted content is usable.', criteria: { true: 'Usable article content in the excerpts', false: 'Missing or unusable article content in the excerpts' } };
        const sample = (length: number) => {
          const first = Math.ceil(length / 3);
          const middle = Math.floor((length - first) / 2);
          const last = length - first - middle;
          const middleStart = Math.floor((points.length - middle) / 2);
          return points.slice(0, first).join('') + '\n[... omitted ...]\n' + points.slice(middleStart, middleStart + middle).join('') + '\n[... omitted ...]\n' + points.slice(points.length - last).join('');
        };
        let low = 0;
        let high = points.length - 1;
        while (low < high) {
          const mid = Math.ceil((low + high) / 2);
          request.state.text = sample(mid);
          if (measureRequest(model, request).fits) low = mid;
          else high = mid - 1;
        }
        request.state.text = sample(low);
        // Do not dispatch a token fragment as if it were meaningful evidence.
        if (low < 600 || !measureRequest(model, request).fits) throw new RangeError('Quality request exceeds unverified local limits');
      }
      signal.throwIfAborted();
      const outcome = await ai.classify(request, { bucket: 'classifier', taskId, signal });
      if (outcome.kind !== 'completed') throw new QualityClassifierPause(outcome);
      const answers = outcome.value.answers;
      const answer = answers?.usable;
      if (!answers || Object.keys(answers).length !== 1 || !answer || answer.type !== 'bool' || !Number.isFinite(answer.probability) || answer.probability < 0 || answer.probability > 1) throw new Error('Invalid quality response');
      return { usable: answer.probability >= 0.5, probability: answer.probability,
        ...(sampled ? { provenance: { coverage: 'sampled' as const, method: 'beginning_middle_end' as const } } : {}) };
    },
  });
}
