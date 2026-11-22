import type { ReactNode, RefObject } from "react";
import { useRef } from "react";
import { CallReturnBar } from "../../../components/call/CallCard";
import { ChatFindBar } from "./chat-find-bar";

/** The open chat's column beside the sidebar: its floating header, find bar, body and composer. */
export function ChatColumn({
  drawerOpen,
  covered,
  findOpen,
  findInputRef,
  onCloseFind,
  header,
  children,
  composer,
}: {
  /** The phone drawer is open over the chat. */
  drawerOpen: boolean;
  /** A side panel covers the chat. */
  covered: boolean;
  findOpen: boolean;
  findInputRef: RefObject<HTMLInputElement | null>;
  onCloseFind: () => void;
  header: ReactNode;
  children: ReactNode;
  composer: ReactNode;
}) {
  const chatColumnRef = useRef<HTMLDivElement>(null);
  return (
    // Keep the composer's z-index inside the chat so phone overlays like the side panel cover it.
    <main
      data-space-switch="main"
      aria-hidden={drawerOpen || undefined}
      inert={drawerOpen || covered}
      className="isolate flex min-w-0 flex-1 flex-col bg-background"
    >
      {/* Inside main so the composer and its menus stay above it. */}
      {!drawerOpen ? (
        <div
          data-testid="mobile-sidebar-swipe-edge"
          aria-hidden="true"
          className="absolute bottom-20 start-0 top-16 z-20 w-8 touch-none md:hidden"
        />
      ) : null}
      <CallReturnBar />
      {/* The header floats so the transcript scrolls under its buttons. */}
      <div
        ref={chatColumnRef}
        data-finding={findOpen || undefined}
        className="relative flex min-h-0 flex-1 flex-col"
      >
        {/* Only the pills take input; the gaps pass clicks and scrolling to the transcript. */}
        <div aria-hidden="true" className="app-drag absolute inset-x-0 top-0 z-10 h-3" />
        {findOpen ? (
          <div className="absolute end-3 top-14 z-20">
            <ChatFindBar scope={chatColumnRef} inputRef={findInputRef} onClose={onCloseFind} />
          </div>
        ) : null}
        {header}
        {children}
      </div>
      {composer}
    </main>
  );
}
