/**
 * Voice-chat scenarios, driven by this list: a new scenario is one entry
 * here, and the picker shows it. The title and description are i18n keys;
 * the instruction is a prompt for the model, so it stays in Chinese.
 *
 * How a scenario reaches the AI: the server's send accepts text only, and
 * the bot's stored instructions are global, so a scenario must not rewrite
 * them. Instead the scenario's instruction is attached to the next user turn
 * of this voice session, as a bracketed prefix, and only then — the voice
 * transcript shows the caller's own words, and the default scenario attaches
 * nothing at all.
 */

export type VoiceChatScenario = {
  id: string;
  /** i18n key for the title shown in the picker. */
  titleKey: string;
  /** i18n key for the one-line description shown in the picker. */
  descriptionKey: string;
  /**
   * Attached to the next turn when this scenario is picked; null means the
   * bot just stays itself.
   */
  instruction: string | null;
};

export const VOICE_CHAT_SCENARIOS: readonly VoiceChatScenario[] = [
  {
    id: "daily",
    titleKey: "Daily chat",
    descriptionKey: "Chat casually, like a friend",
    instruction: null,
  },
  {
    id: "english",
    titleKey: "English speaking",
    descriptionKey: "Practice spoken English with a patient partner",
    instruction:
      "【情景：英语口语】从现在起你是一位耐心友好的英语口语陪练，全程用简单清晰的英语和我对话；我每说完一段，先自然回应，再温和指出一处最值得改的发音或语法问题，并给出正确说法；多鼓励我开口，不要一次纠正太多。",
  },
  {
    id: "interview",
    titleKey: "Interview practice",
    descriptionKey: "A friendly interviewer asks, you answer",
    instruction:
      "【情景：面试练习】从现在起你是一位严格又友善的面试官，按真实面试的节奏提问：一次只问一个问题，等我答完再追问或点评；全部问题问完后，给出总体评价和三条具体改进建议。",
  },
  {
    id: "story",
    titleKey: "Bedtime story",
    descriptionKey: "A gentle voice tells a quiet bedtime story",
    instruction:
      "【情景：讲故事】从现在起你是一位温柔的讲故事的人，用缓慢、轻柔、安静的语气讲简短的睡前故事；一次只讲一段，讲完轻声问我想不想继续听。",
  },
];

export const DEFAULT_VOICE_CHAT_SCENARIO_ID = "daily";

/** The scenario for an id, or the default when the id is unknown. */
export function voiceChatScenario(id: string | null | undefined): VoiceChatScenario {
  return VOICE_CHAT_SCENARIOS.find((scenario) => scenario.id === id) ?? VOICE_CHAT_SCENARIOS[0]!;
}
