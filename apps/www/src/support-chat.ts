import { capture } from "./analytics";

const websiteId = import.meta.env.PUBLIC_CRISP_WEBSITE_ID?.trim();

type CrispWindow = Window & { $crisp?: unknown[][]; CRISP_WEBSITE_ID?: string };

if (websiteId) {
  const target = window as CrispWindow;
  target.$crisp = [
    // Counted next to sign-ups, to see whether visitors who chat go on to try the app.
    ["on", "chat:opened", () => capture("support_chat_opened")],
    ["on", "message:sent", () => capture("support_chat_message_sent")],
  ];
  target.CRISP_WEBSITE_ID = websiteId;
  const script = document.createElement("script");
  script.src = "https://client.crisp.chat/l.js";
  script.async = true;
  document.head.appendChild(script);
}
