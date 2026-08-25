import { describe, expect, it } from "vitest";
import { localizeModelCopy } from "./ui-model-copy";

describe("localizeModelCopy", () => {
  it("localizes subscription and API billing copy while preserving product names", () => {
    expect(
      localizeModelCopy(
        "Sign in with ChatGPT Plus or Pro. Uses your OpenAI subscription. Rakazo does not pay.",
        "ko-KR",
      ),
    ).toBe(
      "ChatGPT Plus 또는 Pro로 로그인합니다. OpenAI 구독 사용량이 차감되며 Rakazo는 비용을 부담하지 않습니다.",
    );
    expect(
      localizeModelCopy("Uses your OpenRouter API key. Rakazo does not pay for model usage.", "ko"),
    ).toBe("내 OpenRouter API 키를 사용합니다. 모델 사용료는 Rakazo가 부담하지 않습니다.");
  });

  it("keeps unsupported locales unchanged", () => {
    expect(localizeModelCopy("Custom server", "en-US")).toBe("Custom server");
  });
});
