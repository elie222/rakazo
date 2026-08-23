import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { ThreadMessage } from "@rakazo/contracts";
import { isApprovalAskBlock } from "@rakazo/core";
import { useState } from "react";

export type AskBlock = Extract<ThreadMessage["blocks"][number], { kind: "ask" }>;

function formatAnsweredState(answer: string | undefined, approval: boolean): string {
  if (!answer) return "Answered";
  if (!approval) return `Answered: ${answer}`;
  if (answer === "allow") return "Allowed once";
  if (answer === "always") return "Always allowed";
  if (answer === "deny") return "Denied";
  return `Answered: ${answer}`;
}

export function AskCard({
  block,
  canAnswer,
  onAnswer,
}: {
  block: AskBlock;
  canAnswer: boolean;
  onAnswer: (text: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [answer, setAnswer] = useState("");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submitting = pendingAction !== null;
  const approvalActions = isApprovalAskBlock(block) ? block.actions : undefined;

  async function submitAnswer(value: string) {
    const text = value.trim();
    if (!text || submitting) return;
    setPendingAction(text);
    setError(null);
    try {
      await onAnswer(text);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not submit this answer");
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <div className="max-w-[74%] rounded-[20px] border border-[#242428] bg-[#141417] px-5 py-[17px]">
      <div className="text-[15.5px] leading-[1.5] text-[#ECECEE]">
        <ChatMarkdown>{block.text}</ChatMarkdown>
      </div>
      {block.detail ? (
        <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-[#0E0E10] px-3.5 py-3 font-mono text-[12.5px] leading-[1.7] text-[#85858A]">
          {block.detail}
        </pre>
      ) : null}
      {block.status === "answered" ? (
        <div className="mt-3.5 text-[13.5px] font-medium text-[#4ECB71]">
          {formatAnsweredState(block.answer, Boolean(approvalActions))}
        </div>
      ) : !canAnswer ? (
        <div className="mt-3.5 text-[13.5px] font-medium text-[#85858A]">No longer active</div>
      ) : approvalActions ? (
        <div className="mt-3.5 flex gap-2">
          {approvalActions.map((action) => (
            <button
              key={action.id}
              type="button"
              disabled={submitting}
              onClick={() => void submitAnswer(action.id)}
              className={
                action.id === "allow"
                  ? "rounded-[11px] bg-[#F1F1EF] px-[17px] py-2 text-[14.5px] font-medium text-[#17171A] disabled:opacity-50"
                  : "rounded-[11px] border border-[#26262A] px-[17px] py-2 text-[14.5px] text-[#C9C9CE] disabled:opacity-50"
              }
            >
              {pendingAction === action.id ? "Sending…" : action.label}
            </button>
          ))}
        </div>
      ) : editing ? (
        <form
          className="mt-3.5 flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submitAnswer(answer);
          }}
        >
          <input
            aria-label="Answer"
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            placeholder="Type your answer"
            className="rounded-[11px] border border-[#303035] bg-[#0E0E10] px-3.5 py-2.5 text-[14.5px] text-[#ECECEE] outline-none focus:border-[#66666D]"
          />
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={!answer.trim() || submitting}
              className="rounded-[11px] bg-[#F1F1EF] px-[17px] py-2 text-[14.5px] font-medium text-[#17171A] disabled:opacity-50"
            >
              {submitting ? "Sending…" : "Send answer"}
            </button>
            <button
              type="button"
              disabled={submitting}
              onClick={() => {
                setAnswer("");
                setEditing(false);
              }}
              className="rounded-[11px] border border-[#26262A] px-[17px] py-2 text-[14.5px] text-[#C9C9CE] disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="mt-3.5 flex gap-2">
          <button
            type="button"
            disabled={submitting}
            onClick={() => void submitAnswer("approved")}
            className="rounded-[11px] bg-[#F1F1EF] px-[17px] py-2 text-[14.5px] font-medium text-[#17171A] disabled:opacity-50"
          >
            {submitting ? "Sending…" : "Send it"}
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => setEditing(true)}
            className="rounded-[11px] border border-[#26262A] px-[17px] py-2 text-[14.5px] text-[#C9C9CE] disabled:opacity-50"
          >
            Edit first
          </button>
        </div>
      )}
      {error ? <p className="mt-3 text-[13px] text-[#E65707]">{error}</p> : null}
    </div>
  );
}
