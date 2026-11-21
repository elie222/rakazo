import "./chat-top-fade.css";

/**
 * Fades and blurs the transcript where it scrolls under the floating chat header.
 * Its height comes from the shared --chat-top-clearance, so it matches the transcript's
 * top padding and stays invisible while the chat is at the top.
 */
export function ChatTopFade() {
  return (
    <div
      aria-hidden="true"
      data-testid="chat-top-fade"
      className="chat-top-fade pointer-events-none absolute inset-x-0 top-0 z-[5] print:hidden"
    />
  );
}
