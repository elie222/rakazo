import type { DemoMessage, DemoScreen } from "../demo";
import { fillDemoText } from "../i18n/demo-text";
import { demoMessages } from "../i18n/demo";
import { LandingBotAvatar } from "./LandingBotAvatar";
import type { DemoTranslator } from "./ProductDemo";
import { DEFAULT_DESK, Thread } from "./ProductDemo";

export type SandboxSceneProps = {
  bot: string;
  color: string;
  /** Where this bot's computer runs, shown in the header. */
  where: string;
  ask: string;
  reply: string;
  /** What the bot is doing on its computer, shown on the computer card. */
  task: string;
  screen: Readonly<Omit<DemoScreen, "lines">> & { lines: readonly string[] };
};

const strings = demoMessages("en");
const text: DemoTranslator = (source, values) => fillDemoText(strings, source, values);

/** A static slice of the landing-page demo: one bot at work on its computer. */
export function SandboxScene({ bot, color, where, ask, reply, task, screen }: SandboxSceneProps) {
  const messages: DemoMessage[] = [
    { type: "user", text: ask },
    { type: "bot", text: reply },
    { type: "computer", text: task },
  ];
  return (
    <div className="sandbox-scene">
      <div className="sandbox-scene__bar">
        <span className="sandbox-scene__bot">
          <LandingBotAvatar color={color} size={28} />
          <strong>{bot}</strong>
        </span>
        <span className="sandbox-scene__where">{where}</span>
      </div>
      <div className="product-demo__thread sandbox-scene__thread">
        <Thread
          messages={messages}
          text={text}
          screen={{ ...screen, lines: [...screen.lines] }}
          desk={DEFAULT_DESK}
          onOpenComputer={() => {}}
        />
      </div>
    </div>
  );
}
