import { Button } from "@rakazo/ui-web";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  DEMO_BOTS,
  type DemoBot,
  type DemoMessage,
  type DemoRoutine,
  type DemoRoutineRun,
  type DemoScreen,
} from "../demo";
import { LandingBotAvatar } from "./LandingBotAvatar";

const BOT_COLORS = ["#3EC5A8", "#F5A03C", "#6A6BF5", "#9B5CF6", "#3B82F6", "#F2622A", "#D9508A"];
const FREQS = [
  "Every hour",
  "Every day",
  "Weekdays",
  "Every week",
  "Every month",
  "Interval",
  "Advanced",
];
const UNITS = ["minutes", "hours", "days"];
const NUMBERS = [1, 2, 3, 5, 10, 15, 30, 45];
const TIMES = [
  "6:00 AM",
  "7:00 AM",
  "8:00 AM",
  "9:00 AM",
  "12:00 PM",
  "3:00 PM",
  "6:00 PM",
  "9:00 PM",
];

const ONBOARD = [
  {
    q: "What do you mainly want me helping with?",
    sub: "Pick whatever’s closest, or type your own.",
    opts: [
      "Inbox & email",
      "Slack & messages",
      "Coding & repos",
      "Research & writing",
      "A bit of everything",
    ],
    ack: (answer: string) => `${answer.toLowerCase()} is a sweet spot for me.`,
  },
  {
    q: "How do you want me to write?",
    sub: "I’ll match this unless you say otherwise on a specific piece.",
    opts: [
      "Clear and tight",
      "Warm and conversational",
      "Polished / formal",
      "Match whatever I draft",
    ],
    ack: (answer: string) => `Got it — ${answer.toLowerCase()} it is.`,
  },
  {
    q: "Where does most of that work live?",
    sub: "So I know where to pull from and drop drafts.",
    opts: ["Google Docs", "Notion", "Just chat / paste here", "A mix"],
    ack: (answer: string) => `Noted. I’ll pull from ${answer} and leave drafts there too.`,
  },
];

type ExtraMessages = Record<string, DemoMessage[]>;
type PanelMode = "computer" | "settings" | "routine";
type LiveBot = DemoBot & {
  title: string;
  description: string;
  onboarding: boolean;
  answers: string[];
};
type Trigger = { freq: string; n: number; unit: string; time: string; cron: string };
type RoutineDraft = {
  index: number | null;
  name: string;
  instruction: string;
  active: boolean;
  triggers: Trigger[];
  runs: DemoRoutineRun[];
};

function cloneBots(): LiveBot[] {
  return DEMO_BOTS.map((bot) => ({
    ...bot,
    routines: bot.routines.map((routine) => ({
      ...routine,
      runs: routine.runs?.map((run) => ({ ...run })),
    })),
    title: "",
    description: "",
    onboarding: false,
    answers: [],
  }));
}

function defaultTrigger(): Trigger {
  return { freq: "Every day", n: 3, unit: "minutes", time: "9:00 AM", cron: "" };
}

function parseWhen(when: string): Trigger {
  const trigger = defaultTrigger();
  if (!when) {
    return trigger;
  }
  const interval = /every\s+(\d+)\s*(min|h)/i.exec(when);
  if (interval) {
    trigger.freq = "Interval";
    trigger.n = Number(interval[1]);
    trigger.unit = /h/i.test(interval[2] ?? "") ? "hours" : "minutes";
    return trigger;
  }
  if (/hourly/i.test(when)) {
    trigger.freq = "Every hour";
    return trigger;
  }
  if (/weekday/i.test(when)) {
    trigger.freq = "Weekdays";
  } else if (/monday|week/i.test(when)) {
    trigger.freq = "Every week";
  } else if (/month/i.test(when)) {
    trigger.freq = "Every month";
  }
  const time = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(when);
  if (time) {
    trigger.time = `${time[1]}:${time[2] || "00"} ${time[3]?.toUpperCase()}`;
  }
  return trigger;
}

function describeTrigger(trigger: Trigger) {
  if (trigger.freq === "Interval") {
    return { lead: "Every", detail: `${trigger.n} ${trigger.unit}` };
  }
  if (trigger.freq === "Every hour") {
    return { lead: "Every hour", detail: "" };
  }
  if (trigger.freq === "Advanced") {
    return { lead: "Cron", detail: trigger.cron || "*/3 * * * *" };
  }
  if (trigger.freq === "Weekdays") {
    return { lead: "Weekdays", detail: `at ${trigger.time}` };
  }
  if (trigger.freq === "Every week") {
    return { lead: "Every Monday", detail: `at ${trigger.time}` };
  }
  if (trigger.freq === "Every month") {
    return { lead: "Monthly", detail: `on the 1st at ${trigger.time}` };
  }
  return { lead: "Every day", detail: `at ${trigger.time}` };
}

function whenLabel(triggers: Trigger[]) {
  if (triggers.length === 0) {
    return "Unscheduled";
  }
  const { lead, detail } = describeTrigger(triggers[0] ?? defaultTrigger());
  return [lead, detail].filter(Boolean).join(" ");
}

function previewForBot(bot: LiveBot, extra: ExtraMessages) {
  const last = extra[bot.id]?.at(-1);
  if (last && "text" in last) {
    return last.text;
  }
  if (bot.onboarding && bot.answers.length > 0) {
    return bot.answers.at(-1) ?? bot.preview;
  }
  return bot.preview;
}

const BOOT_STEPS: Record<number, string> = {
  8: "Allocating a machine",
  46: "Restoring the session",
  82: "Opening the browser",
  100: "Handing you the screen",
};

function ComputerDesktop({ screen, large = false }: { screen: DemoScreen; large?: boolean }) {
  return (
    <div className={`product-demo__desktop${large ? " is-large" : ""}`}>
      <div className="product-demo__window">
        <div className="product-demo__window-bar">
          <span />
          <span />
          <span />
          <div className="product-demo__window-url">{screen.host}</div>
        </div>
        <div className="product-demo__window-body">
          <div className="product-demo__window-title">{screen.title}</div>
          {screen.lines.map((line) => (
            <div key={line}>{line}</div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Thread({ messages }: { messages: DemoMessage[] }) {
  return (
    <>
      {messages.map((message, index) => {
        if (message.type === "time") {
          return (
            <div key={`time-${index}`} className="product-demo__time">
              {message.text}
            </div>
          );
        }
        if (message.type === "meta") {
          return (
            <div key={`meta-${index}`} className="product-demo__meta">
              {message.text}
            </div>
          );
        }
        if (message.type === "card") {
          return (
            <div key={`card-${index}`} className="product-demo__message product-demo__message--bot">
              <div className="product-demo__card">
                {message.lines.map((line) => (
                  <div key={`${line.k}-${line.v}`} className="product-demo__card-line">
                    <span className="product-demo__card-check">✓</span>
                    <strong>{line.k}</strong>
                    <span className="product-demo__card-arrow">→</span>
                    <span>{line.v}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        }
        if (message.type === "typing") {
          return (
            <div
              key={`typing-${index}`}
              className="product-demo__message product-demo__message--bot"
            >
              <div className="product-demo__bubble product-demo__bubble--typing">working…</div>
            </div>
          );
        }
        return (
          <div
            key={`${message.type}-${index}`}
            className={`product-demo__message product-demo__message--${message.type}`}
          >
            <div className={`product-demo__bubble product-demo__bubble--${message.type}`}>
              {message.text}
            </div>
          </div>
        );
      })}
    </>
  );
}

function OnboardThread({
  answers,
  onAnswer,
}: {
  answers: string[];
  onAnswer: (value: string) => void;
}) {
  return (
    <>
      <div className="product-demo__time">Today</div>
      <div className="product-demo__message product-demo__message--bot">
        <div className="product-demo__bubble product-demo__bubble--bot">
          Hey Avery — good to meet you.
        </div>
      </div>
      {ONBOARD.map((step, index) => {
        const answer = answers[index];
        if (answer !== undefined) {
          const letter = String.fromCharCode(65 + Math.max(0, step.opts.indexOf(answer)));
          return (
            <div key={step.q}>
              <div className="product-demo__choice product-demo__choice--done">
                <div className="product-demo__choice-q">{step.q}</div>
                <div className="product-demo__choice-picked">
                  <span className="product-demo__choice-letter">{letter}</span>
                  <span>{answer}</span>
                  <span className="product-demo__choice-check">✓</span>
                </div>
              </div>
              <div className="product-demo__message product-demo__message--bot">
                <div className="product-demo__bubble product-demo__bubble--bot">
                  {step.ack(answer)}
                </div>
              </div>
            </div>
          );
        }
        if (answers.length !== index) {
          return null;
        }
        return (
          <div key={step.q} className="product-demo__choice">
            <div className="product-demo__choice-q">{step.q}</div>
            <div className="product-demo__choice-sub">{step.sub}</div>
            <div className="product-demo__choice-opts">
              {step.opts.map((opt, optIndex) => (
                <button key={opt} type="button" onClick={() => onAnswer(opt)}>
                  <span className="product-demo__choice-letter">
                    {String.fromCharCode(65 + optIndex)}
                  </span>
                  <span>{opt}</span>
                </button>
              ))}
            </div>
            <div className="product-demo__choice-own">Type your own answer</div>
          </div>
        );
      })}
      {answers.length === ONBOARD.length ? (
        <div className="product-demo__message product-demo__message--bot">
          <div className="product-demo__bubble product-demo__bubble--bot">
            That’s everything I need. Give me a first job whenever you’re ready — I’ll ask before
            anything leaves the building.
          </div>
        </div>
      ) : null}
    </>
  );
}

export function ProductDemo() {
  const [bots, setBots] = useState<LiveBot[]>(cloneBots);
  const [activeId, setActiveId] = useState("inbox");
  const [panelOpen, setPanelOpen] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [compact, setCompact] = useState(false);
  const [panelMode, setPanelMode] = useState<PanelMode>("computer");
  const [hasControl, setHasControl] = useState(false);
  const [takeover, setTakeover] = useState(false);
  const [bootPct, setBootPct] = useState(0);
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [extra, setExtra] = useState<ExtraMessages>({});
  const [routineDraft, setRoutineDraft] = useState<RoutineDraft | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const timersRef = useRef<number[]>([]);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const widePanelRef = useRef(true);
  const booting = bootPct > 0;

  const active = bots.find((bot) => bot.id === activeId) ?? bots[0];
  const messages = useMemo(() => {
    if (!active) {
      return [];
    }
    return active.thread.concat(extra[active.id] ?? []);
  }, [active, extra]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return bots;
    }
    return bots.filter((bot) => `${bot.name} ${bot.preview}`.toLowerCase().includes(needle));
  }, [bots, query]);

  const onboardingOpen = Boolean(active?.onboarding && active.answers.length < ONBOARD.length);

  useEffect(() => {
    setHasControl(false);
    setTakeover(false);
    setBootPct(0);
  }, [activeId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [active?.id, messages.length, active?.answers.length]);

  useEffect(() => {
    return () => {
      for (const timer of timersRef.current) {
        window.clearTimeout(timer);
      }
    };
  }, []);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 860px)");
    const sync = () => setCompact(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  // Phone widths show one screen at a time, so the bot list starts hidden behind
  // the hamburger and the side panel stays closed until asked for. Growing the
  // window back restores however the panel was left at wide widths: this effect
  // only runs when `compact` flips, so it closes over that render's panelOpen.
  useEffect(() => {
    if (compact) {
      widePanelRef.current = panelOpen;
      setPanelOpen(false);
    } else {
      setMenuOpen(false);
      setPanelOpen(widePanelRef.current);
    }
  }, [compact]);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        closeMenu();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  useEffect(() => {
    if (!takeover && !booting) {
      return;
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setTakeover(false);
        setBootPct(0);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [takeover, booting]);

  if (!active) {
    return null;
  }

  function schedule(callback: () => void, delayMs: number) {
    const timer = window.setTimeout(() => {
      timersRef.current = timersRef.current.filter((pending) => pending !== timer);
      callback();
    }, delayMs);
    timersRef.current.push(timer);
  }

  function closeMenu() {
    if (!menuOpen) {
      return;
    }
    setMenuOpen(false);
    // The drawer is hidden from the focus order once closed, so hand focus back
    // to the control that opened it.
    menuButtonRef.current?.focus();
  }

  function openComputer() {
    setPanelOpen(true);
    setPanelMode("computer");
    setRoutineDraft(null);
  }

  function toggleComputer() {
    if (panelOpen && panelMode === "computer") {
      setPanelOpen(false);
      return;
    }
    openComputer();
  }

  function openSettings() {
    setPanelOpen(true);
    setPanelMode("settings");
    setRoutineDraft(null);
  }

  function openRoutine(routine: DemoRoutine | null, index: number | null) {
    setPanelOpen(true);
    setPanelMode("routine");
    setRoutineDraft({
      index,
      name: routine?.name ?? "",
      instruction: routine?.instruction ?? "",
      active: routine?.active ?? true,
      triggers: routine ? [parseWhen(routine.when)] : [],
      runs: routine?.runs?.map((run) => ({ ...run })) ?? [],
    });
  }

  function patchActive(patch: Partial<LiveBot>) {
    setBots((current) => current.map((bot) => (bot.id === activeId ? { ...bot, ...patch } : bot)));
  }

  function changeRoutine(patch: Partial<RoutineDraft>) {
    setRoutineDraft((current) => (current ? { ...current, ...patch } : current));
  }

  function persistRoutine(draftState: RoutineDraft) {
    const index = draftState.index ?? active.routines.length;
    const next: DemoRoutine = {
      name: draftState.name.trim() || "Untitled routine",
      when: whenLabel(draftState.triggers),
      instruction: draftState.instruction,
      active: draftState.active,
      runs: draftState.runs,
    };
    setBots((current) =>
      current.map((bot) => {
        if (bot.id !== activeId) {
          return bot;
        }
        const routines = [...bot.routines];
        if (index === routines.length) {
          routines.push(next);
        } else {
          routines[index] = next;
        }
        return { ...bot, routines };
      }),
    );
    return index;
  }

  function saveRoutine() {
    if (!routineDraft) {
      return;
    }
    persistRoutine(routineDraft);
    openComputer();
  }

  function deleteRoutine() {
    if (routineDraft?.index !== null && routineDraft) {
      patchActive({ routines: active.routines.filter((_, index) => index !== routineDraft.index) });
    }
    openComputer();
  }

  function startNewBot() {
    const color = BOT_COLORS[bots.length % BOT_COLORS.length] ?? "#3EC5A8";
    const bot: LiveBot = {
      id: `bot-${Date.now()}`,
      name: "New bot",
      color,
      time: "Now",
      preview: "Say what you want this bot doing",
      title: "",
      description: "",
      onboarding: true,
      answers: [],
      routines: [],
      screen: { host: "desktop", title: "Computer is stopped", lines: [] },
      thread: [],
      reply: "on it. tell me the job and i’ll get started.",
    };
    setBots((current) => [bot, ...current]);
    setActiveId(bot.id);
    setDraft("");
    closeMenu();
    openSettings();
  }

  function answerOnboard(value: string) {
    if (!active.onboarding || active.answers.length >= ONBOARD.length) {
      return;
    }
    patchActive({ answers: [...active.answers, value] });
  }

  function closeOverlay() {
    for (const timer of timersRef.current.splice(0)) {
      window.clearTimeout(timer);
    }
    setTakeover(false);
    setBootPct(0);
  }

  function releaseControl() {
    setHasControl(false);
    closeOverlay();
  }

  function takeControl() {
    if (booting) {
      return;
    }
    if (hasControl) {
      setTakeover(true);
      return;
    }
    for (const timer of timersRef.current.splice(0)) {
      window.clearTimeout(timer);
    }
    setBootPct(8);
    schedule(() => setBootPct(46), 450);
    schedule(() => setBootPct(82), 1100);
    schedule(() => setBootPct(100), 1750);
    schedule(() => {
      setBootPct(0);
      setHasControl(true);
      setTakeover(true);
    }, 2300);
  }

  function appendMessage(botId: string, message: DemoMessage) {
    setExtra((current) => ({
      ...current,
      [botId]: [...(current[botId] ?? []), message],
    }));
  }

  function send() {
    const text = draft.trim();
    if (!text) {
      return;
    }
    setDraft("");
    if (onboardingOpen) {
      answerOnboard(text);
      return;
    }
    const botId = active.id;
    const reply = active.reply;
    appendMessage(botId, { type: "user", text });
    schedule(() => appendMessage(botId, { type: "typing" }), 280);
    schedule(() => {
      setExtra((current) => {
        const withoutTyping = (current[botId] ?? []).filter((message) => message.type !== "typing");
        return { ...current, [botId]: [...withoutTyping, { type: "bot", text: reply }] };
      });
    }, 1350);
  }

  function selectBot(id: string) {
    setActiveId(id);
    closeMenu();
    if (panelMode === "routine") {
      setPanelMode("computer");
      setRoutineDraft(null);
    }
  }

  function patchTrigger(index: number, patch: Partial<Trigger>) {
    changeRoutine({
      triggers: (routineDraft?.triggers ?? []).map((trigger, triggerIndex) =>
        triggerIndex === index ? { ...trigger, ...patch } : trigger,
      ),
    });
  }

  function testRun() {
    if (!routineDraft?.name.trim()) {
      return;
    }
    const completedRun: DemoRoutineRun = {
      mark: "●",
      color: "#4ECB71",
      text: "Completed",
      time: "Just now",
    };
    const index = persistRoutine({
      ...routineDraft,
      runs: [...routineDraft.runs, completedRun],
    });
    setRoutineDraft((current) =>
      current
        ? {
            ...current,
            index,
            runs: [...current.runs, completedRun],
          }
        : current,
    );
    appendMessage(active.id, { type: "meta", text: `Routine ran · ${routineDraft.name}` });
  }

  return (
    <div className="product-demo">
      <div className={`product-demo__frame${panelOpen ? "" : " is-collapsed"}`}>
        <aside
          id="product-demo-bots"
          className={`product-demo__sidebar${menuOpen ? " is-open" : ""}`}
          aria-hidden={compact && !menuOpen}
          inert={compact && !menuOpen}
        >
          <div className="product-demo__chrome">
            <div className="product-demo__traffic" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <span className="product-demo__drawer-title">Bots</span>
            <div className="product-demo__chrome-actions">
              <button
                type="button"
                className="product-demo__new"
                aria-label="New bot"
                onClick={startNewBot}
              >
                +
              </button>
              <button
                type="button"
                className="product-demo__sidebar-close"
                aria-label="Hide bots"
                onClick={closeMenu}
              >
                ✕
              </button>
            </div>
          </div>
          <label className="product-demo__search">
            <span aria-hidden="true">⌕</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search"
            />
          </label>
          <div className="product-demo__bot-list">
            {filtered.map((bot) => {
              const isActive = bot.id === active.id;
              return (
                <button
                  key={bot.id}
                  type="button"
                  className={`product-demo__bot-row${isActive ? " is-active" : ""}`}
                  onClick={() => selectBot(bot.id)}
                >
                  <LandingBotAvatar color={bot.color} size={38} />
                  <span className="product-demo__bot-copy">
                    <span className="product-demo__bot-meta">
                      <span className="product-demo__bot-name">{bot.name}</span>
                      <span className="product-demo__bot-time">{bot.time}</span>
                    </span>
                    <span className="product-demo__bot-preview">{previewForBot(bot, extra)}</span>
                  </span>
                </button>
              );
            })}
          </div>
          <div className="product-demo__user">
            <span className="product-demo__user-badge">AK</span>
            <span>Avery Kim</span>
          </div>
        </aside>

        {menuOpen ? (
          <button
            type="button"
            className="product-demo__scrim"
            aria-label="Hide bots"
            onClick={closeMenu}
          />
        ) : null}

        <main className="product-demo__main">
          <div className="product-demo__topbar">
            <div className="product-demo__topbar-left">
              <button
                type="button"
                ref={menuButtonRef}
                className="product-demo__menu-btn"
                aria-label="Show bots"
                aria-expanded={menuOpen}
                aria-controls="product-demo-bots"
                onClick={() => setMenuOpen(true)}
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                >
                  <path d="M4 7h16M4 12h16M4 17h16" />
                </svg>
              </button>
              <button type="button" className="product-demo__name-btn" onClick={openSettings}>
                <LandingBotAvatar color={active.color} size={28} />
                <span className="product-demo__active-name">{active.name}</span>
              </button>
            </div>
            <button
              type="button"
              className="product-demo__panel-toggle"
              aria-pressed={panelOpen && panelMode === "computer"}
              aria-label="Toggle computer panel"
              title="Computer"
              onClick={toggleComputer}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
              >
                <rect x="2" y="4" width="20" height="13" rx="2" />
                <path d="M8 21h8M12 17v4" />
              </svg>
            </button>
          </div>

          <div className="product-demo__thread" ref={scrollRef}>
            {active.onboarding ? (
              <OnboardThread answers={active.answers} onAnswer={answerOnboard} />
            ) : null}
            {messages.length === 0 && !active.onboarding ? (
              <div className="product-demo__empty-thread">
                Message {active.name} to give it a first job.
              </div>
            ) : (
              <Thread messages={messages} />
            )}
          </div>

          <div className="product-demo__composer">
            <div className="product-demo__input-shell">
              <span className="product-demo__composer-plus" aria-hidden="true">
                +
              </span>
              <input
                type="text"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    send();
                  }
                }}
                placeholder={onboardingOpen ? "Type your own answer" : `Message ${active.name}`}
                aria-label={onboardingOpen ? "Type your own answer" : `Message ${active.name}`}
              />
              <button type="button" className="product-demo__send" onClick={send} aria-label="Send">
                ↑
              </button>
            </div>
          </div>
        </main>

        {panelOpen ? (
          <aside className="product-demo__panel">
            {panelMode !== "routine" ? (
              <div className="product-demo__panel-head">
                <span>{panelMode === "settings" ? "settings" : `${active.name}’s computer`}</span>
                <div className="product-demo__panel-actions">
                  <button type="button" aria-label="Bot settings" onClick={openSettings}>
                    <svg
                      width="17"
                      height="17"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.6"
                    >
                      <circle cx="12" cy="12" r="3" />
                      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6h.09A1.65 1.65 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    aria-label="Close panel"
                    onClick={() => setPanelOpen(false)}
                  >
                    ✕
                  </button>
                </div>
              </div>
            ) : null}

            {panelMode === "computer" ? (
              <>
                <button
                  type="button"
                  className="product-demo__screen"
                  onClick={takeControl}
                  aria-label={hasControl ? "Open computer" : "Take control of computer"}
                >
                  <ComputerDesktop screen={active.screen} />
                </button>
                <div className="product-demo__screen-meta">
                  <span>{hasControl ? "You have control" : `${active.name}’s screen`}</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => (hasControl ? releaseControl() : takeControl())}
                  >
                    {hasControl ? "Release" : "Take control"}
                  </Button>
                </div>
                <div className="product-demo__panel-label">Routines</div>
                {active.routines.length === 0 ? (
                  <div className="product-demo__empty-routines">
                    <p>Routines are recurring tasks this agent runs on a schedule.</p>
                    <button
                      type="button"
                      className="product-demo__ghost-btn"
                      onClick={() => openRoutine(null, null)}
                    >
                      Create routine
                    </button>
                  </div>
                ) : (
                  <>
                    {active.routines.map((routine, index) => (
                      <button
                        key={`${routine.name}-${index}`}
                        type="button"
                        className="product-demo__routine"
                        onClick={() => openRoutine(routine, index)}
                      >
                        <span className="product-demo__routine-icon">◷</span>
                        <span className="product-demo__routine-name">{routine.name}</span>
                        <span className="product-demo__routine-when">{routine.when}</span>
                      </button>
                    ))}
                    <button
                      type="button"
                      className="product-demo__quiet"
                      onClick={() => openRoutine(null, null)}
                    >
                      + New routine
                    </button>
                  </>
                )}
              </>
            ) : null}

            {panelMode === "settings" ? (
              <div className="product-demo__settings">
                <div className="product-demo__settings-avatar">
                  <LandingBotAvatar color={active.color} size={72} />
                </div>
                <label className="product-demo__field">
                  Name
                  <input
                    value={active.name}
                    placeholder="Name this agent"
                    onChange={(event) => patchActive({ name: event.target.value })}
                  />
                </label>
                <label className="product-demo__field">
                  Title
                  <input
                    value={active.title}
                    placeholder="Describe what this agent does"
                    onChange={(event) => patchActive({ title: event.target.value })}
                  />
                </label>
                <label className="product-demo__field">
                  Description
                  <textarea
                    rows={4}
                    value={active.description}
                    placeholder="What this agent is for"
                    onChange={(event) => patchActive({ description: event.target.value })}
                  />
                </label>
              </div>
            ) : null}

            {panelMode === "routine" && routineDraft ? (
              <div className="product-demo__routine-editor">
                <div className="product-demo__routine-nav">
                  <button type="button" onClick={saveRoutine} aria-label="Back to computer">
                    ‹
                  </button>
                  <span>Routine</span>
                  <button
                    type="button"
                    onClick={() => setPanelOpen(false)}
                    aria-label="Close panel"
                  >
                    ✕
                  </button>
                </div>
                <div className="product-demo__routine-toolbar">
                  <button
                    type="button"
                    className={`product-demo__switch${routineDraft.active ? " is-on" : ""}`}
                    aria-pressed={routineDraft.active}
                    onClick={() => changeRoutine({ active: !routineDraft.active })}
                  >
                    <span />
                  </button>
                  <span>{routineDraft.active ? "Active" : "Paused"}</span>
                  <button type="button" className="product-demo__ghost-btn" onClick={deleteRoutine}>
                    Delete
                  </button>
                  <button
                    type="button"
                    className="product-demo__ghost-btn"
                    disabled={!routineDraft.name.trim()}
                    onClick={testRun}
                  >
                    Test run
                  </button>
                </div>
                <label className="product-demo__field">
                  Name
                  <input
                    value={routineDraft.name}
                    placeholder="Name this routine"
                    onChange={(event) => changeRoutine({ name: event.target.value })}
                  />
                </label>
                <label className="product-demo__field">
                  Instruction
                  <textarea
                    rows={4}
                    value={routineDraft.instruction}
                    placeholder="What should this routine do each time it runs?"
                    onChange={(event) => changeRoutine({ instruction: event.target.value })}
                  />
                </label>
                <div className="product-demo__field">
                  When to run
                  {routineDraft.triggers.length === 0 ? (
                    <button
                      type="button"
                      className="product-demo__add-schedule"
                      onClick={() => changeRoutine({ triggers: [defaultTrigger()] })}
                    >
                      + Add schedule
                    </button>
                  ) : (
                    <div className="product-demo__triggers">
                      {routineDraft.triggers.map((trigger, index) => {
                        const { lead, detail } = describeTrigger(trigger);
                        const timed = [
                          "Every day",
                          "Weekdays",
                          "Every week",
                          "Every month",
                        ].includes(trigger.freq);
                        return (
                          <div key={`${trigger.freq}-${index}`} className="product-demo__trigger">
                            <div className="product-demo__trigger-head">
                              <span>
                                {lead} {detail}
                              </span>
                              <button
                                type="button"
                                aria-label="Remove schedule"
                                onClick={() =>
                                  changeRoutine({
                                    triggers: routineDraft.triggers.filter(
                                      (_, triggerIndex) => triggerIndex !== index,
                                    ),
                                  })
                                }
                              >
                                ✕
                              </button>
                            </div>
                            <div className="product-demo__trigger-row">
                              <select
                                value={trigger.freq}
                                onChange={(event) =>
                                  patchTrigger(index, { freq: event.target.value })
                                }
                              >
                                {FREQS.map((freq) => (
                                  <option key={freq} value={freq}>
                                    {freq}
                                  </option>
                                ))}
                              </select>
                              {trigger.freq === "Interval" ? (
                                <>
                                  <span>every</span>
                                  <select
                                    value={String(trigger.n)}
                                    onChange={(event) =>
                                      patchTrigger(index, { n: Number(event.target.value) })
                                    }
                                  >
                                    {NUMBERS.map((n) => (
                                      <option key={n} value={n}>
                                        {n}
                                      </option>
                                    ))}
                                  </select>
                                  <select
                                    value={trigger.unit}
                                    onChange={(event) =>
                                      patchTrigger(index, { unit: event.target.value })
                                    }
                                  >
                                    {UNITS.map((unit) => (
                                      <option key={unit} value={unit}>
                                        {unit}
                                      </option>
                                    ))}
                                  </select>
                                </>
                              ) : null}
                              {timed ? (
                                <>
                                  <span>at</span>
                                  <select
                                    value={trigger.time}
                                    onChange={(event) =>
                                      patchTrigger(index, { time: event.target.value })
                                    }
                                  >
                                    {TIMES.map((time) => (
                                      <option key={time} value={time}>
                                        {time}
                                      </option>
                                    ))}
                                  </select>
                                </>
                              ) : null}
                              {trigger.freq === "Advanced" ? (
                                <input
                                  value={trigger.cron}
                                  placeholder="*/3 * * * *"
                                  onChange={(event) =>
                                    patchTrigger(index, { cron: event.target.value })
                                  }
                                />
                              ) : null}
                            </div>
                          </div>
                        );
                      })}
                      <button
                        type="button"
                        className="product-demo__quiet"
                        onClick={() =>
                          changeRoutine({ triggers: [...routineDraft.triggers, defaultTrigger()] })
                        }
                      >
                        + Add another
                      </button>
                    </div>
                  )}
                </div>
                <div className="product-demo__field">
                  Run history
                  {routineDraft.runs.length === 0 ? (
                    <p className="product-demo__muted">No runs yet</p>
                  ) : (
                    <ul className="product-demo__runs">
                      {routineDraft.runs.map((run, index) => (
                        <li key={`${run.text}-${index}`}>
                          <span style={{ color: run.color }}>{run.mark}</span>
                          <span>{run.text}</span>
                          <span>{run.time}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            ) : null}
          </aside>
        ) : null}

        {booting || takeover ? (
          <div className="product-demo__stage">
            {booting ? (
              <div className="product-demo__boot">
                <div className="product-demo__boot-title">Booting up {active.name}’s computer</div>
                <div className="product-demo__boot-track">
                  <div style={{ width: `${bootPct}%` }} />
                </div>
                <div className="product-demo__boot-step">{BOOT_STEPS[bootPct] ?? ""}</div>
              </div>
            ) : (
              <div className="product-demo__takeover">
                <div className="product-demo__takeover-bar">
                  <div className="product-demo__takeover-who">
                    <LandingBotAvatar color={active.color} size={32} />
                    <span>{active.name}’s computer</span>
                    <span className="product-demo__takeover-pill">You have control</span>
                  </div>
                  <div className="product-demo__takeover-actions">
                    <Button type="button" variant="outline" size="sm" onClick={releaseControl}>
                      Release
                    </Button>
                    <button
                      type="button"
                      className="product-demo__takeover-close"
                      onClick={closeOverlay}
                      aria-label="Close computer"
                    >
                      ✕
                    </button>
                  </div>
                </div>
                <div className="product-demo__takeover-screen">
                  <ComputerDesktop screen={active.screen} large />
                </div>
              </div>
            )}
          </div>
        ) : null}
      </div>
      <p className="product-demo__caption">
        Live demo — pick a bot, open its computer, add a routine, or start a new chat.
      </p>
    </div>
  );
}
