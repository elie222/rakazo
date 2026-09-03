import { BotAvatar } from "@rakazo/ui-web";
import { createRoot } from "react-dom/client";

createRoot(document.getElementById("root")!).render(
  <BotAvatar
    color="#D9508A"
    identity="reduced-motion"
    size={120}
    status="running"
    variant="organic"
  />,
);
