// Custom instructions (persona profile, layer 2) — one per verified account.
//
// Storage: Supabase public.vivian_user_custom_instructions,
// service-role only. Validation: app/api/custom-instructions
// PATCH rejects oversize with HTTP 400 (never silently truncates).
// Prompt injection: lib/vivian-persona.ts vivianTurnPrompt(), same budget.
// Settings UI shows a live counter against this budget.
export const MAX_CUSTOM_INSTRUCTIONS_LENGTH = 2000;

export const CUSTOM_INSTRUCTIONS_VERSION_LIMIT = 10;

export function validCustomInstructions(value: unknown): value is string {
  return typeof value === "string" && value.trim().length <= MAX_CUSTOM_INSTRUCTIONS_LENGTH;
}

// Defensive normalize only: the API route validates length and rejects
// oversize with 400 before calling this, so slicing here never silently
// discards valid user content (all valid input is already within budget).
export function normalizeCustomInstructions(value: string): string {
  return value.trim().slice(0, MAX_CUSTOM_INSTRUCTIONS_LENGTH);
}
