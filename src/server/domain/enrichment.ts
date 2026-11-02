// Re-export shared validation for existing server callers.
export { validateScore } from "../../shared/scores.js";
export { modelRoleNames, validateModelRoleSettings } from "../../shared/settings.js";
export type { ModelRole, ModelReference, ModelRoleSettings } from "../../shared/settings.js";
