export const DEFAULT_APPROVAL =
  "Do not send messages, spend money, publish content, or delete data without explicit user approval.";
export const DEFAULT_FAILURE =
  "If a step fails or the expected screen is not visible, stop and ask the user before retrying.";
export const DEFAULT_STEP = "Repeat the demonstrated workflow using the same navigation pattern.";
export const DEFAULT_WHEN_TO_USE = "When the user asks to repeat the demonstrated task.";
export const DEFAULT_WHAT_TO_RETURN =
  "A short summary of what was completed and where outputs were saved.";

export function playbookHowToCheck(finalScreen: string | undefined): string {
  return finalScreen
    ? `The final screen should match: ${finalScreen}.`
    : "Confirm the outcome matches the user's goal before reporting success.";
}
