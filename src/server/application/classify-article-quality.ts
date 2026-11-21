import type { AiPort, ClassificationRequest } from '../ports/ai.js';
import type { ArticleQualityClassifier } from './prepare-article.js';
import { copyRequestModel, measureRequest, validateRequestModel, type RequestModel } from './score-context-request.js';

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
      if (!measureRequest(model, request).fits) throw new RangeError(`Quality request exceeds ${'kind' in model ? 'unverified local' : 'verified'} limits`);
      const outcome = await ai.classify(request, { bucket: 'classifier', taskId, signal });
      if (outcome.kind !== 'completed') throw new Error('Quality classifier unavailable');
      const answers = outcome.value.answers;
      const answer = answers?.usable;
      if (!answers || Object.keys(answers).length !== 1 || !answer || answer.type !== 'bool' || !Number.isFinite(answer.probability) || answer.probability < 0 || answer.probability > 1) throw new Error('Invalid quality response');
      return { usable: answer.probability >= 0.5, probability: answer.probability };
    },
  });
}
