import { resolveUiLanguage } from "./ui-copy";

const exactKoreanActivity: Readonly<Record<string, string>> = {
  Remember: "기억",
  "Rendering a chart": "차트 만드는 중",
  "Looking at the screen": "화면 확인 중",
  "Operating the computer": "컴퓨터 조작 중",
  "Saving a note to memory": "기억해두는 중",
};

const delimitedKoreanActivity: ReadonlyArray<readonly [string, string]> = [
  ["Running: ", " 실행 중"],
  ["Connecting MCP server: ", " MCP 서버 연결 중"],
  ["Delegating to helper: ", " 보조 에이전트에게 맡기는 중"],
];

const targetedKoreanActivity: ReadonlyArray<readonly [string, string]> = [
  ["Reading ", " 읽는 중"],
  ["Writing ", " 작성 중"],
  ["Listing ", " 목록 확인 중"],
  ["Attaching ", " 첨부 중"],
  ["Opening ", " 여는 중"],
];

function looksLikeActivityTarget(value: string): boolean {
  const target = value.trim();
  return (
    /^(?:\.{0,2}\/|~\/|https?:\/\/)/.test(target) ||
    target.includes("/") ||
    /\.[A-Za-z0-9]{1,10}$/.test(target)
  );
}

export function localizeAgentActivity(text: string, locale?: string): string {
  if (resolveUiLanguage(locale) !== "ko") return text;
  const exact = exactKoreanActivity[text];
  if (exact) return exact;

  for (const [prefix, suffix] of delimitedKoreanActivity) {
    if (text.startsWith(prefix)) return `${text.slice(prefix.length)}${suffix}`;
  }
  for (const [prefix, suffix] of targetedKoreanActivity) {
    if (!text.startsWith(prefix)) continue;
    const target = text.slice(prefix.length);
    if (looksLikeActivityTarget(target)) return `${target}${suffix}`;
  }

  const mcp = /^Using ([^:]+): (.+)$/.exec(text);
  if (mcp) return `${mcp[1]}의 ${mcp[2]} 사용 중`;
  const tool = /^Using (.+)$/.exec(text);
  if (tool) return `${tool[1]} 사용 중`;
  return text;
}
