import { resolveUiLanguage } from "./ui-copy";

const exactKoreanVoiceCopy: Readonly<Record<string, string>> = {
  "Highest quality and cloning. Flash v2.5 for conversational calls.":
    "고품질 음성과 목소리 복제를 지원합니다. 대화형 통화에는 Flash v2.5를 사용합니다.",
  "Simple TTS plus Whisper-class transcription. Reuse an OpenAI key.":
    "간편한 음성 출력과 Whisper 수준의 받아쓰기를 지원합니다. 기존 OpenAI 키를 그대로 쓸 수 있습니다.",
  "Lowest-latency Sonic voices for interruptible calls.":
    "통화 중 끼어들기에 적합한, 응답이 매우 빠른 Sonic 음성을 제공합니다.",
};

export function localizeVoiceCopy(text: string, locale?: string): string {
  if (resolveUiLanguage(locale) !== "ko") return text;
  return exactKoreanVoiceCopy[text] ?? text;
}
