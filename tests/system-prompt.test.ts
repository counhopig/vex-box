/**
 * SystemPromptAssembler tests — 3-section prompt assembly with
 * mutually-exclusive persona vs DEFAULT_IDENTITY.
 *
 * Architecture doc (§11):
 *   Section 1: PERSONA (BASE) — always first. The LLM sees identity first.
 *   Section 2: CUSTOM INSTRUCTIONS
 *   Section 3: SKILLS
 */

import { describe, it, expect } from "vitest";
import { assembleSystemPrompt, DEFAULT_IDENTITY } from "../src/agent/SystemPromptAssembler.js";

describe("SystemPromptAssembler", () => {
  // -- persona present → DEFAULT_IDENTITY excluded -------------------------

  it("uses persona block when provided, excludes DEFAULT_IDENTITY", () => {
    const prompt = assembleSystemPrompt({ persona: "你是 PandaBot。" });
    expect(prompt).toContain("你是 PandaBot。");
    expect(prompt).not.toContain(DEFAULT_IDENTITY);
  });

  // -- persona absent → DEFAULT_IDENTITY included --------------------------

  it("uses DEFAULT_IDENTITY when persona is not provided", () => {
    const prompt = assembleSystemPrompt({});
    expect(prompt).toContain(DEFAULT_IDENTITY);
  });

  it("uses DEFAULT_IDENTITY when persona is empty string", () => {
    const prompt = assembleSystemPrompt({ persona: "" });
    expect(prompt).toContain(DEFAULT_IDENTITY);
  });

  // -- sections in order ---------------------------------------------------

  it("assembles sections in the correct order: persona → customInstructions → skills", () => {
    const prompt = assembleSystemPrompt({
      persona: "PERSONA_MARKER_001",
      customInstructions: "CUSTOM_INSTRUCTIONS_MARKER_002",
      skills: "SKILLS_MARKER_003",
    });

    const personaIdx = prompt.indexOf("PERSONA_MARKER_001");
    const customIdx = prompt.indexOf("CUSTOM_INSTRUCTIONS_MARKER_002");
    const skillsIdx = prompt.indexOf("SKILLS_MARKER_003");

    expect(personaIdx).toBeGreaterThanOrEqual(0);
    expect(customIdx).toBeGreaterThanOrEqual(0);
    expect(skillsIdx).toBeGreaterThanOrEqual(0);
    expect(personaIdx).toBeLessThan(customIdx);
    expect(customIdx).toBeLessThan(skillsIdx);
  });

  // -- optional sections omitted -------------------------------------------

  it("omits sections that are not provided", () => {
    const prompt = assembleSystemPrompt({ persona: "角色" });
    expect(prompt).toContain("角色");
    expect(prompt).not.toContain("【自定义指令】");
    expect(prompt).not.toContain("【技能模板】");
  });

  // -- section labelling ---------------------------------------------------

  it("labels Section 1 with a header when persona is provided", () => {
    const prompt = assembleSystemPrompt({ persona: "你是一个助手。" });
    expect(prompt).toMatch(/Section 1|角色身份|Persona/);
  });

  it("labels provided optional sections with their headers", () => {
    const prompt = assembleSystemPrompt({
      persona: "角色",
      customInstructions: "CUSTOM_INSTRUCTIONS_BODY",
      skills: "SKILLS_BODY",
    });
    expect(prompt).toContain("CUSTOM_INSTRUCTIONS_BODY");
    expect(prompt).toContain("SKILLS_BODY");
  });
});
