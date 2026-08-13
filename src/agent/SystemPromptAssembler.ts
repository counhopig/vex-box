/**
 * SystemPromptAssembler — assembles the 3-section system prompt.
 *
 * Architecture doc (§11):
 *   Section 1: PERSONA (BASE) — always first. The LLM sees identity first,
 *              capabilities second.
 *   Section 2: CUSTOM INSTRUCTIONS — user-authored agent.systemPrompt. Follows
 *              identity; precedes skills.
 *   Section 3: SKILLS              — injected skill content
 *
 * Key rule: Persona is Section 1. Always.
 *
 * When persona is set, DEFAULT_IDENTITY is excluded — persona owns identity
 * exclusively. When persona is absent/falsy, DEFAULT_IDENTITY is used.
 * This is the fix for the 2026-07-17 competing-identity incident.
 *
 * Previously declared environment/toolRules/outputFormat sections were
 * removed in plan 009: no caller supplied their values (Agent.processMessage
 * only feeds the 3 live fields), so the assembler could never emit them —
 * the labels and interface fields were dead. Re-add requires a separate
 * design plan that defines the content source for each section.
 */

// ---------------------------------------------------------------------------
// Default identity
// ---------------------------------------------------------------------------

/** Used when no persona is configured (bare tool executor mode). */
export const DEFAULT_IDENTITY =
  "You are a helpful AI assistant. Be concise, accurate, and polite.";

// ---------------------------------------------------------------------------
// Section headers
// ---------------------------------------------------------------------------

const SECTION_LABELS: Record<string, string> = {
  persona: "【角色身份】",
  customInstructions: "【自定义指令】",
  skills: "【技能模板】",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SystemPromptSections {
  persona?: string;
  customInstructions?: string;
  skills?: string;
}

// ---------------------------------------------------------------------------
// Assembler
// ---------------------------------------------------------------------------

/**
 * Assemble the system prompt from sections.
 *
 * Section order is always: persona → customInstructions → skills. Any section
 * can be omitted — only provided sections are included (except for Section 1:
 * if persona is absent/falsy, DEFAULT_IDENTITY is used so there is always a
 * base identity).
 */
export function assembleSystemPrompt(sections: SystemPromptSections): string {
  const parts: string[] = [];

  // Section 1: persona or DEFAULT_IDENTITY (mutually exclusive)
  if (sections.persona) {
    parts.push(`${SECTION_LABELS.persona}\n${sections.persona}`);
  } else {
    parts.push(DEFAULT_IDENTITY);
  }

  // Section 2: custom instructions (user-authored agent.systemPrompt)
  if (sections.customInstructions) {
    parts.push(`${SECTION_LABELS.customInstructions}\n${sections.customInstructions}`);
  }

  // Section 3: skills
  if (sections.skills) {
    parts.push(`${SECTION_LABELS.skills}\n${sections.skills}`);
  }

  return parts.join("\n\n---\n\n");
}
