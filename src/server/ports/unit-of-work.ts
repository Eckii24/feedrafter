/** Opaque transaction handle; only the owning adapter may unwrap it. */
export interface UnitOfWork {
  readonly unitOfWork: 'unit-of-work';
}
