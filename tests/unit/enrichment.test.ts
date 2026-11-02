import { describe, expect, it } from "vitest";
import { validateModelRoleSettings, validateScore } from "../../src/server/domain/enrichment.js";
import { validateBudgetSettings } from "../../src/shared/settings.js";
import { validateScoreDefinition } from "../../src/shared/scores.js";
import { normalizeTagLabel } from "../../src/shared/taxonomy.js";

describe("enrichment domain", () => {
  it("accepts only finite scores on the shared scale", () => {
    for (const value of [0, 42.5, 100]) expect(validateScore(value)).toBe(value);
    for (const value of [null, undefined, -1, 101, NaN, Infinity, -Infinity, "50"]) expect(() => validateScore(value)).toThrow();
  });
  it("normalizes display labels without attempting semantic merges or casefolding", () => {
    expect(normalizeTagLabel("  ＡI\u00a0\tTools  ")).toBe("AI Tools");
    expect(normalizeTagLabel("Straße")).toBe("Straße");
    expect(() => normalizeTagLabel(" \u00a0 ")).toThrow();
  });
  it("validates score configuration and budget limits", () => {
    const score = { name: "Facts", description: "", prompt: "prompt", active: true, includeTitle: true, includeContent: true, includeCategory: true, includeTagWeights: false, includeSourceWeight: false };
    expect(validateScoreDefinition(score)).toEqual(score);
    expect(() => validateScoreDefinition({ ...score, prompt: " " })).toThrow();
    expect(() => validateScoreDefinition({ ...score, active: 1 as unknown as boolean })).toThrow();
    const budget = { bucket: "automatic" as const, dailyRequests: 50, concurrency: 1, dailyAudioSeconds: null };
    expect(validateBudgetSettings(budget)).toEqual(budget);
    for (const value of [-1, 0.5, Infinity, NaN, 2147483648]) expect(() => validateBudgetSettings({ ...budget, dailyRequests: value })).toThrow();
    expect(() => validateBudgetSettings({ ...budget, dailyAudioSeconds: NaN })).toThrow();
  });
  it("allows unconfigured roles but requires explicit complete fallback settings", () => {
    expect(validateModelRoleSettings({ role: "chat", primary: null, fallback: null }).primary).toBeNull();
    expect(() => validateModelRoleSettings({ role: "chat", primary: null, fallback: { provider: "p", model: "m" } })).toThrow();
    expect(() => validateModelRoleSettings({ role: "chat", primary: { provider: "p", model: " " }, fallback: null })).toThrow();
    expect(validateModelRoleSettings({ role: "scores", primary: { provider: "typesafe", model: "jev-latest" }, fallback: null }).fallback).toBeNull();
  });
});
