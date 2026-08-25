import type { ThreadMessage } from "@rakazo/contracts";
import { useMemo, useState } from "react";
import { peerConversations } from "../lib/peer-messages";

/**
 * Bot-to-bot traffic lives here rather than in the thread: it is the bots
 * working, not the conversation the user is having.
 */
export function PeerMessagesOverlay({
  botName,
  messages,
  onClose,
}: {
  botName: string;
  messages: readonly ThreadMessage[];
  onClose: () => void;
}) {
  const conversations = useMemo(() => peerConversations(messages), [messages]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected =
    conversations.find((conversation) => conversation.peerBotId === selectedId) ?? conversations[0];

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-[rgba(4,4,5,.62)] p-4 sm:p-10">
      <div className="flex h-[min(680px,100%)] w-[880px] max-w-full flex-col overflow-hidden rounded-[26px] border border-[#232326] bg-[#141416] shadow-[0_40px_90px_rgba(0,0,0,.55)]">
        <div className="flex items-start justify-between px-6 pt-6 sm:px-8 sm:pt-7">
          <div>
            <div className="text-2xl font-medium text-[#F1F1F2]">Bot messages</div>
            <p className="mt-1 text-[13.5px] text-[#7A7A80]">
              {conversations.length === 0
                ? `${botName} has not messaged another bot yet.`
                : `${botName} and ${conversations.length} other ${
                    conversations.length === 1 ? "bot" : "bots"
                  }.`}
            </p>
          </div>
          <button
            type="button"
            aria-label="Close bot messages"
            onClick={onClose}
            className="text-[#85858A]"
          >
            ✕
          </button>
        </div>

        {conversations.length === 0 ? (
          <div className="grid flex-1 place-items-center px-8 text-center text-[13.5px] text-[#6C6C70]">
            When {botName} messages another bot, the exchange shows up here instead of in the chat.
          </div>
        ) : (
          <div className="mt-5 flex min-h-0 flex-1 gap-4 px-6 pb-6 sm:px-8 sm:pb-7">
            <div className="w-[240px] shrink-0 overflow-y-auto">
              {conversations.map((conversation) => {
                const active = conversation.peerBotId === selected?.peerBotId;
                return (
                  <button
                    key={conversation.peerBotId}
                    type="button"
                    onClick={() => setSelectedId(conversation.peerBotId)}
                    className={`mb-1.5 block w-full rounded-[13px] border px-3.5 py-2.5 text-start ${
                      active
                        ? "border-[#2F2F34] bg-[#1B1B1E]"
                        : "border-transparent hover:bg-[#161618]"
                    }`}
                  >
                    <div className="truncate text-[14px] text-[#ECECEE]">
                      {conversation.peerBotName}
                    </div>
                    <div className="mt-0.5 truncate text-[12.5px] text-[#6C6C70]">
                      {conversation.lastText}
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="flex min-w-0 flex-1 flex-col overflow-y-auto rounded-[16px] border border-[#26262A] bg-[#101012] p-4">
              {selected?.messages.map((peerMessage) => {
                const sent = peerMessage.direction === "sent";
                return (
                  <div
                    key={`${peerMessage.messageId}-${peerMessage.createdAt}-${peerMessage.text}`}
                    className={`mb-2.5 flex ${sent ? "justify-end" : "justify-start"}`}
                  >
                    <div
                      className={`max-w-[80%] rounded-[16px] px-4 py-2.5 ${
                        sent ? "bg-[#1F1F23]" : "bg-[#17171A]"
                      }`}
                    >
                      <div className="mb-1 text-[12px] text-[#7A7A80]">
                        {sent ? `${botName} → ${peerMessage.peerBotName}` : peerMessage.peerBotName}
                      </div>
                      <div
                        className="whitespace-pre-wrap text-[14.5px] leading-[1.5] text-[#DFDFE2]"
                        dir="auto"
                      >
                        {peerMessage.text}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
