import type { UnitOfWork } from './unit-of-work.js';

export interface TaskQueue {
  enqueueImport(unitOfWork: UnitOfWork, runId: string): Promise<void>;
}
