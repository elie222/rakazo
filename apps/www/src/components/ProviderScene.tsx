import type { DemoCardLine, DemoMessage, DemoScreen } from "../demo";
import { fillDemoText } from "../i18n/demo-text";
import { demoMessages } from "../i18n/demo";
import { LandingBotAvatar } from "./LandingBotAvatar";
import type { DemoTranslator } from "./ProductDemo";
import { DEFAULT_DESK, Thread } from "./ProductDemo";

type SceneScreen = Readonly<Omit<DemoScreen, "lines">> & { lines: readonly string[] };

export type ProviderSceneProps = {
  bot: string;
  color: string;
  /** Where the bot's work happens, shown in the header. */
  where: string;
  ask: string;
  reply: string;
  /** Work on the bot's computer: what it's doing and what the screen shows. */
  computer?: { task: string; screen: SceneScreen };
  /** Work through tools: one checked line per action, like the demo's result card. */
  results?: readonly DemoCardLine[];
};

const strings = demoMessages("en");
const text: DemoTranslator = (source, values) => fillDemoText(strings, source, values);
const EMPTY_SCREEN: DemoScreen = { host: "", title: "", lines: [] };

/** A static slice of the landing-page demo: one bot at work. */
export function ProviderScene({ bot, color, where, ask, reply, computer, results }: ProviderSceneProps) {
  const messages: DemoMessage[] = [
    { type: "user", text: ask },
    { type: "bot", text: reply },
    ...(results ? [{ type: "card" as const, lines: [...results] }] : []),
    ...(computer ? [{ type: "computer" as const, text: computer.task }] : []),
  ];
  const screen = computer ? { ...computer.screen, lines: [...computer.screen.lines] } : EMPTY_SCREEN;
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
          screen={screen}
          desk={DEFAULT_DESK}
          onOpenComputer={() => {}}
        />
      </div>
    </div>
  );
}
