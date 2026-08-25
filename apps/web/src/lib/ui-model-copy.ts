import { resolveUiLanguage } from "./ui-copy";

const exactKoreanModelCopy: Readonly<Record<string, string>> = {
  "Custom server": "사용자 지정 서버",
  "Skip or deploy key": "건너뛰기 또는 서버 키 사용",
  "Sign in with ChatGPT Plus/Pro": "ChatGPT Plus/Pro로 로그인",
  "Sign in with GitHub Copilot": "GitHub Copilot으로 로그인",
  "Sign in with SuperGrok or X Premium": "SuperGrok 또는 X Premium으로 로그인",
  "Sign in with Claude Pro/Max": "Claude Pro/Max로 로그인",
  "Runs on infrastructure configured by the deployment owner. No model charges from Rakazo.":
    "서버 관리자가 설정한 인프라에서 실행됩니다. Rakazo에서 별도 모델 사용료가 발생하지 않습니다.",
  "Runs on a URL you control. Rakazo does not pay for model usage.":
    "내가 지정한 서버에서 실행됩니다. 모델 사용료는 Rakazo가 부담하지 않습니다.",
  "Sign in with ChatGPT Plus or Pro. Uses your OpenAI subscription. Rakazo does not pay.":
    "ChatGPT Plus 또는 Pro로 로그인합니다. OpenAI 구독 사용량이 차감되며 Rakazo는 비용을 부담하지 않습니다.",
  "Sign in with GitHub Copilot. Uses your Copilot subscription. Rakazo does not pay.":
    "GitHub Copilot으로 로그인합니다. Copilot 구독 사용량이 차감되며 Rakazo는 비용을 부담하지 않습니다.",
  "Sign in with SuperGrok or X Premium, or paste an xAI API key. Rakazo does not pay.":
    "SuperGrok 또는 X Premium으로 로그인하거나 xAI API 키를 연결합니다. Rakazo는 비용을 부담하지 않습니다.",
  "Sign in with Claude Pro or Max, or paste an Anthropic API key. Uses your Anthropic subscription. Rakazo does not pay.":
    "Claude Pro 또는 Max로 로그인하거나 Anthropic API 키를 연결합니다. Anthropic 구독 사용량이 차감되며 Rakazo는 비용을 부담하지 않습니다.",
};

export function localizeModelCopy(text: string, locale?: string): string {
  if (resolveUiLanguage(locale) !== "ko") return text;
  const exact = exactKoreanModelCopy[text];
  if (exact) return exact;

  const apiKey = /^Uses your (.+) API key\. Rakazo does not pay for model usage\.$/.exec(text);
  if (apiKey) {
    return `내 ${apiKey[1]} API 키를 사용합니다. 모델 사용료는 Rakazo가 부담하지 않습니다.`;
  }
  const key = /^Uses your (.+) key\. Rakazo does not pay for model usage\.$/.exec(text);
  if (key) return `내 ${key[1]} 키를 사용합니다. 모델 사용료는 Rakazo가 부담하지 않습니다.`;
  return text;
}
