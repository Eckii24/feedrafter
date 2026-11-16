import { createHash } from "node:crypto";

export type ArticleBasis = { contentRevision: number; assignmentRevision: number; articleInputHash: string };
export type HandoffRef = { taskId: string; generation: number; action: "category" | "tags" };
export type HandoffReceiptV1 = {
  version: 1; taskId: string; generation: number; action: "category" | "tags"; articleId: string;
  prerequisiteId: string | null; categoryId: string; basis: ArticleBasis; catalogEpoch: number;
};
export type ChainMetadataV1 = {
  version: 1; rootTaskId: string; prepareTaskId: string;
} & (
  | { requiredHandoff: null; requiredBasis: ArticleBasis; targetCount: number; tagsTaskId: string }
  | { requiredHandoff: HandoffRef; requiredBasis: ArticleBasis | null; targetCount?: never; tagsTaskId?: never }
);
export type PreparationReceiptV1 = {
  version: 1; taskId: string; articleId: string; action: "prepare"; generation: number; contentRevision: number;
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hashPattern = /^[0-9a-f]{64}$/;
const uuid = (value: unknown): value is string => typeof value === "string" && uuidPattern.test(value);
const int32 = (value: unknown, min = 0): value is number => typeof value === "number" && Number.isInteger(value) && value >= min && value <= 2147483647;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, required: string[], optional: string[] = []) =>
  required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function articleFingerprint(title: string | null, sourceId: string | null): string {
  return createHash("sha256").update(JSON.stringify([title, sourceId]), "utf8").digest("hex");
}

export function decodeArticleBasis(value: unknown): ArticleBasis | null {
  if (!object(value) || !keys(value, ["contentRevision", "assignmentRevision", "articleInputHash"]) ||
      !int32(value.contentRevision, 1) || !int32(value.assignmentRevision) ||
      typeof value.articleInputHash !== "string" || !hashPattern.test(value.articleInputHash)) return null;
  return { contentRevision: value.contentRevision, assignmentRevision: value.assignmentRevision, articleInputHash: value.articleInputHash };
}

export function decodeHandoffRef(value: unknown): HandoffRef | null {
  if (!object(value) || !keys(value, ["taskId", "generation", "action"]) || !uuid(value.taskId) ||
      !int32(value.generation, 1) || (value.action !== "category" && value.action !== "tags")) return null;
  return { taskId: value.taskId, generation: value.generation, action: value.action };
}

export function decodeHandoffReceiptV1(value: unknown): HandoffReceiptV1 | null {
  if (!object(value) || !keys(value, ["version", "taskId", "generation", "action", "articleId", "prerequisiteId", "categoryId", "basis", "catalogEpoch"]) ||
      value.version !== 1 || !uuid(value.taskId) || !uuid(value.articleId) || !uuid(value.categoryId) ||
      !int32(value.generation) || !int32(value.catalogEpoch) ||
      (value.action !== "category" && value.action !== "tags") ||
      !(value.prerequisiteId === null || uuid(value.prerequisiteId)) ||
      (value.action === "tags" && value.prerequisiteId === null) ||
      (value.prerequisiteId !== null && sameId(value.taskId, value.prerequisiteId))) return null;
  const basis = decodeArticleBasis(value.basis);
  if (!basis) return null;
  return { version: 1, taskId: value.taskId, generation: value.generation, action: value.action, articleId: value.articleId,
    prerequisiteId: value.prerequisiteId, categoryId: value.categoryId, basis, catalogEpoch: value.catalogEpoch };
}

// The task action supplies the discriminator absent from the stored namespace.
export function decodeChainMetadataV1(value: unknown, action: "category" | "tags" | "scores"): ChainMetadataV1 | null {
  if (!object(value) || !keys(value, action === "category"
      ? ["version", "rootTaskId", "prepareTaskId", "requiredHandoff", "requiredBasis", "targetCount", "tagsTaskId"]
      : ["version", "rootTaskId", "prepareTaskId", "requiredHandoff", "requiredBasis"]) ||
      value.version !== 1 || !uuid(value.rootTaskId) || !uuid(value.prepareTaskId) || sameId(value.rootTaskId, value.prepareTaskId)) return null;
  const basis = value.requiredBasis === null ? null : decodeArticleBasis(value.requiredBasis);
  const handoff = value.requiredHandoff === null ? null : decodeHandoffRef(value.requiredHandoff);
  if ((value.requiredBasis !== null && !basis) || (value.requiredHandoff !== null && !handoff)) return null;
  if (action === "category") {
    if (handoff || !basis || !int32(value.targetCount) || !uuid(value.tagsTaskId) ||
        sameId(value.tagsTaskId, value.rootTaskId) || sameId(value.tagsTaskId, value.prepareTaskId)) return null;
    return { version: 1, rootTaskId: value.rootTaskId, prepareTaskId: value.prepareTaskId, tagsTaskId: value.tagsTaskId, requiredHandoff: null, requiredBasis: basis, targetCount: value.targetCount };
  }
  if ((action !== "tags" && action !== "scores") || Object.hasOwn(value, "targetCount") || Object.hasOwn(value, "tagsTaskId") || !handoff ||
      (action === "tags" && (handoff.action !== "category" || !sameId(handoff.taskId, value.rootTaskId))) ||
      (action === "scores" && (handoff.action !== "tags" || sameId(handoff.taskId, value.rootTaskId))) ||
      sameId(handoff.taskId, value.prepareTaskId)) return null;
  return { version: 1, rootTaskId: value.rootTaskId, prepareTaskId: value.prepareTaskId, requiredHandoff: handoff, requiredBasis: basis };
}

export function decodePreparationReceiptV1(value: unknown): PreparationReceiptV1 | null {
  if (!object(value) || !keys(value, ["version", "taskId", "articleId", "action", "generation", "contentRevision"]) ||
      value.version !== 1 || value.action !== "prepare" || !uuid(value.taskId) || !uuid(value.articleId) ||
      !int32(value.generation, 1) || !int32(value.contentRevision, 1)) return null;
  return { version: 1, taskId: value.taskId, articleId: value.articleId, action: "prepare", generation: value.generation, contentRevision: value.contentRevision };
}

// Task result may contain unrelated namespaces, but missing/malformed namespaces fail closed.
export function readPreparationReceipt(result: unknown): PreparationReceiptV1 | null {
  return object(result) && Object.hasOwn(result, "preparationReceipt") ? decodePreparationReceiptV1(result.preparationReceipt) : null;
}
export function readHandoffReceipt(result: unknown): HandoffReceiptV1 | null {
  return object(result) && Object.hasOwn(result, "handoffReceipt") ? decodeHandoffReceiptV1(result.handoffReceipt) : null;
}
export function readChainMetadata(result: unknown, action: "category" | "tags" | "scores"): ChainMetadataV1 | null {
  return object(result) && Object.hasOwn(result, "articleChain") ? decodeChainMetadataV1(result.articleChain, action) : null;
}
