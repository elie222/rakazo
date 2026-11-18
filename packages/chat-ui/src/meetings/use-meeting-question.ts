import type { RpcOutput } from "@rakazo/contracts";
import { useState } from "react";

/** Keeps the current draft and the last completed exchange for a transcript view. */
export function useMeetingQuestion() {
  const [draft, setDraft] = useState("");
  const [exchange, setExchange] = useState<{ question: string; answer: string }>();
  const question = draft.trim();

  return {
    draft,
    setDraft,
    exchange,
    canAsk: Boolean(question),
    submit(run: (question: string) => void, blocked: boolean) {
      if (question && !blocked) run(question);
    },
    onAnswered({ answer }: RpcOutput<"meetings/ask">, question: string) {
      setExchange({ question, answer });
      setDraft("");
    },
  };
}
