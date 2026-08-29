import { DEMO_ROSTER, type RosterBot } from "../demo";
import { SITE_DESCRIPTION } from "../site";
import type { Locale } from "./locales";

export type HomeCopy = {
  title: string;
  description: string;
  ogImageAlt: string;
  availableLanguage: string;
  skipToContent: string;
  starFallback: string;
  nav: {
    primary: string;
    menu: string;
    product: string;
    bots: string;
    selfHost: string;
    openSource: string;
    docs: string;
    viewOnGithub: string;
  };
  hero: {
    badge: string;
    pill: string;
    heading: string;
    lead: string;
    getStarted: string;
    viewOnGithub: string;
    setupWithAgent: string;
    copiedForAgent: string;
    copyFailed: string;
  };
  selfHost: {
    eyebrow: string;
    heading: string;
    copy: string;
    installTitle: string;
    installHint: string;
    computersNote: string;
    features: Array<{ title: string; body: string }>;
  };
  roster: {
    eyebrow: string;
    heading: string;
    copy: string;
    bots: RosterBot[];
  };
  openSource: {
    eyebrow: string;
    heading: string;
    copy: string;
    selfHostTitle: string;
    selfHostMeta: string;
    selfHostItems: string[];
    starOnGithub: string;
    readTheDocs: string;
    cloudTitle: string;
    cloudBadge: string;
    cloudMeta: string;
    cloudItems: string[];
    getStarted: string;
  };
  cta: {
    heading: string;
    copy: string;
    getStarted: string;
    viewOnGithub: string;
    openSourceValue: string;
    selfHostValue: string;
    stats: Array<{ value: "stars" | "license" | "openSource" | "selfHost"; label: string }>;
  };
  getStartedDialog: {
    closeLabel: string;
    eyebrow: string;
    title: string;
    copy: string;
    selfHostNow: string;
    selfHostHint: string;
    cloudWaitlist: string;
    cloudHint: string;
    back: string;
    successTitle: string;
    successCopy: string;
    done: string;
    viewOnGithub: string;
  };
  waitlist: {
    emailLabel: string;
    placeholder: string;
    submit: string;
    joining: string;
    success: string;
    added: string;
    error: string;
  };
  footer: {
    navLabel: string;
    languagesLabel: string;
  };
};

const EN_ROSTER = DEMO_ROSTER;

const DE_ROSTER: RosterBot[] = [
  {
    name: "Sales Outbound",
    color: "#F5A03C",
    slug: "rakazo/sales-outbound",
    desc: "Recherchiert nachts Accounts, bewertet Intent, entwirft in deinem Ton und hinterlässt eine Review-Liste.",
  },
  {
    name: "Inbox Manager",
    color: "#6A6BF5",
    slug: "rakazo/inbox-manager",
    desc: "Archiviert den Lärm, antwortet auf Routine-Threads und parkt Entwürfe, die du lesen solltest.",
  },
  {
    name: "Talent Scout",
    color: "#3B82F6",
    slug: "rakazo/talent-scout",
    desc: "Liest jede Bewerbung, shortlistet nach deiner Latte und schreibt die Intro-Mails.",
  },
  {
    name: "Expense Manager",
    color: "#F2622A",
    slug: "rakazo/expense-manager",
    desc: "Ordnet Belege den Buchungen zu, reicht den Report ein und fragt nach, statt zu raten.",
  },
  {
    name: "Bug Triage",
    color: "#D9508A",
    slug: "rakazo/bug-triage",
    desc: "Reproduziert Reports in einem echten Browser und hängt die Schritte an das Issue.",
  },
  {
    name: "Account Manager",
    color: "#9B5CF6",
    slug: "rakazo/account-manager",
    desc: "Hält Renewal-Kontext, beantwortet bekannte Fragen und eskaliert den Rest.",
  },
  {
    name: "Paid Media",
    color: "#3EC5A8",
    slug: "rakazo/paid-media",
    desc: "Überwacht den Spend täglich, pausiert, was nicht konvertiert, und meldet, was sich geändert hat.",
  },
  {
    name: "Chief of Staff",
    color: "#8B93A8",
    slug: "rakazo/chief-of-staff",
    desc: "Führt die Woche: Briefings, Buchungen und Übergaben zwischen deinen anderen Bots.",
  },
];

const KO_ROSTER: RosterBot[] = [
  {
    name: "Sales Outbound",
    color: "#F5A03C",
    slug: "rakazo/sales-outbound",
    desc: "밤새 계정을 조사하고 의도를 점수한 뒤, 당신 말투로 초안을 써 검토 목록을 남깁니다.",
  },
  {
    name: "Inbox Manager",
    color: "#6A6BF5",
    slug: "rakazo/inbox-manager",
    desc: "잡음을 보관처리하고, 루틴 스레드에 답하며, 확인이 필요한 초안은 보류합니다.",
  },
  {
    name: "Talent Scout",
    color: "#3B82F6",
    slug: "rakazo/talent-scout",
    desc: "지원서를 모두 읽고 기준에 맞게 숏리스트한 뒤 소개 메일을 작성합니다.",
  },
  {
    name: "Expense Manager",
    color: "#F2622A",
    slug: "rakazo/expense-manager",
    desc: "영수증과 결제를 맞추고 리포트를 제출하며, 추측하기 전에 묻습니다.",
  },
  {
    name: "Bug Triage",
    color: "#D9508A",
    slug: "rakazo/bug-triage",
    desc: "실제 브라우저에서 리포트를 재현하고 이슈에 재현 절차를 붙입니다.",
  },
  {
    name: "Account Manager",
    color: "#9B5CF6",
    slug: "rakazo/account-manager",
    desc: "갱신 맥락을 유지하고 알려진 질문에 답하며, 나머지는 에스컬레이션합니다.",
  },
  {
    name: "Paid Media",
    color: "#3EC5A8",
    slug: "rakazo/paid-media",
    desc: "매일 지출을 지켜보고 전환되지 않는 건 일시정지한 뒤, 바뀐 점을 보고합니다.",
  },
  {
    name: "Chief of Staff",
    color: "#8B93A8",
    slug: "rakazo/chief-of-staff",
    desc: "한 주를 운영합니다: 브리핑, 예약, 다른 봇 사이의 핸드오프.",
  },
];

const HOME_COPY: Record<Locale, HomeCopy> = {
  en: {
    title: "Rakazo | Open source Grok Bot alternative",
    description: SITE_DESCRIPTION,
    ogImageAlt:
      "Rakazo — AI teammates you actually own. Your keys, your model, your machine.",
    availableLanguage: "English",
    skipToContent: "Skip to content",
    starFallback: "Star",
    nav: {
      primary: "Primary",
      menu: "Menu",
      product: "Product",
      bots: "Bots",
      selfHost: "Self-host",
      openSource: "Open source",
      docs: "Docs",
      viewOnGithub: "View on GitHub",
    },
    hero: {
      badge: "Apache-2.0",
      pill: "Self-hosted",
      heading: "AI teammates you actually own",
      lead: "Rakazo is an open source Grok Bot alternative. Give a bot real work. It signs in to your tools, uses them the way you do, and comes back when it needs you.",
      getStarted: "Get started",
      viewOnGithub: "View on GitHub",
      setupWithAgent: "Set up with your agent",
      copiedForAgent: "Copied for your agent",
      copyFailed: "Copy failed — try again",
    },
    selfHost: {
      eyebrow: "Self-hosted",
      heading: "The computer is yours",
      copy: "Run Rakazo on your machine with published images. Local Docker computers work without an E2B account.",
      installTitle: "Install with Docker",
      installHint: "Docker Engine and the Compose plugin required. Default tag is edge (amd64).",
      computersNote:
        "Default is Docker computers on this host. E2B, Daytona, and Box are optional remote providers.",
      features: [
        {
          title: "Any model, your key",
          body: "Point a bot at Claude, GPT, Grok, or a local model. Swap per bot — the cheap one triages, the smart one writes.",
        },
        {
          title: "Readable routines",
          body: "Show a bot a workflow once and it saves a routine as plain Markdown you can read, edit, and commit.",
        },
        {
          title: "Approvals that hold",
          body: "Set what a bot may do alone and what it must ask about. Every action lands in an audit log you own.",
        },
      ],
    },
    roster: {
      eyebrow: "Bot Templates",
      heading: "Give each bot a job",
      copy: "Start a new bot and it interviews you — a few questions about the work, how you write, and where it lives. Then it gets going.",
      bots: EN_ROSTER,
    },
    openSource: {
      eyebrow: "Open source",
      heading: "No pricing page. Just the repo.",
      copy: "Rakazo is Apache-2.0 licensed and runs on your own machine with your own model keys. Nothing is gated, nothing phones home.",
      selfHostTitle: "Self-host",
      selfHostMeta: "Available today",
      selfHostItems: [
        "Docker runner and sandboxed browser",
        "Bring your own model keys",
        "Routines, memory, and audit log",
        "Unlimited bots, no seats, no limits",
        "Community support on GitHub",
      ],
      starOnGithub: "Star on GitHub",
      readTheDocs: "Read the docs",
      cloudTitle: "Cloud",
      cloudBadge: "Coming soon",
      cloudMeta: "Bring your own keys, we run the computers",
      cloudItems: [
        "Managed sandboxes, always on",
        "Your keys, your model spend",
        "Same bots, same routines, no migration",
      ],
      getStarted: "Get started",
    },
    cta: {
      heading: "Meet your first bot",
      copy: "Give Rakazo something you have been putting off and let it handle the follow-through.",
      getStarted: "Get started",
      viewOnGithub: "View on GitHub",
      openSourceValue: "Open source",
      selfHostValue: "Self-host",
      stats: [
        { value: "stars", label: "GitHub stars" },
        { value: "license", label: "License" },
        { value: "openSource", label: "No seats, no gates" },
        { value: "selfHost", label: "Your machine" },
      ],
    },
    getStartedDialog: {
      closeLabel: "Close get started dialog",
      eyebrow: "Get started",
      title: "How do you want to start?",
      copy: "Self-host now with Docker, or join the Cloud waitlist.",
      selfHostNow: "Self-host now",
      selfHostHint: "Published images. UI in minutes. No E2B key required to sign up.",
      cloudWaitlist: "Cloud waitlist",
      cloudHint: "Hosted Rakazo is coming. Leave your email.",
      back: "Back",
      successTitle: "You're in.",
      successCopy:
        "We'll email you when hosted Rakazo is ready. Want to start today? Jump to Self-host on this page.",
      done: "Done",
      viewOnGithub: "View on GitHub",
    },
    waitlist: {
      emailLabel: "Email address",
      placeholder: "you@company.com",
      submit: "Continue",
      joining: "Joining…",
      success: "You’re in.",
      added: "Added",
      error: "Couldn’t add you. Try again.",
    },
    footer: {
      navLabel: "Footer",
      languagesLabel: "Language",
    },
  },
  de: {
    title: "Rakazo | Open-Source-Alternative zu Grok Bot",
    description:
      "Rakazo ist eine Open-Source-Alternative zu Grok Bot für persistente KI-Teamkollegen, die echte Arbeit erledigen. Deine Keys, dein Modell, deine Maschine.",
    ogImageAlt:
      "Rakazo — KI-Teamkollegen, die dir wirklich gehören. Deine Keys, dein Modell, deine Maschine.",
    availableLanguage: "German",
    skipToContent: "Zum Inhalt springen",
    starFallback: "Star",
    nav: {
      primary: "Hauptnavigation",
      menu: "Menü",
      product: "Produkt",
      bots: "Bots",
      selfHost: "Self-host",
      openSource: "Open Source",
      docs: "Docs",
      viewOnGithub: "Auf GitHub ansehen",
    },
    hero: {
      badge: "Apache-2.0",
      pill: "Self-hosted",
      heading: "KI-Teamkollegen, die dir wirklich gehören",
      lead: "Rakazo ist eine Open-Source-Alternative zu Grok Bot. Gib einem Bot echte Arbeit. Er meldet sich in deinen Tools an, nutzt sie wie du — und kommt zurück, wenn er dich braucht.",
      getStarted: "Loslegen",
      viewOnGithub: "Auf GitHub ansehen",
      setupWithAgent: "Mit deinem Agenten einrichten",
      copiedForAgent: "Für deinen Agenten kopiert",
      copyFailed: "Kopieren fehlgeschlagen — erneut versuchen",
    },
    selfHost: {
      eyebrow: "Self-hosted",
      heading: "Der Computer gehört dir",
      copy: "Starte Rakazo mit veröffentlichten Images. Lokale Docker-Computer laufen ohne E2B-Account.",
      installTitle: "Mit Docker installieren",
      installHint: "Docker Engine und Compose-Plugin nötig. Default-Tag ist edge (amd64).",
      computersNote:
        "Standard sind Docker-Computer auf diesem Host. E2B, Daytona und Box sind optionale Remote-Anbieter.",
      features: [
        {
          title: "Beliebiges Modell, dein Key",
          body: "Richte einen Bot auf Claude, GPT, Grok oder ein lokales Modell aus. Pro Bot wechselbar — der günstige triagiert, der smarte schreibt.",
        },
        {
          title: "Lesbare Routinen",
          body: "Zeig einem Bot einmal einen Workflow — er speichert eine Routine als Markdown, das du lesen, editieren und committen kannst.",
        },
        {
          title: "Freigaben, die greifen",
          body: "Lege fest, was ein Bot allein darf und worum er fragen muss. Jede Aktion landet in einem Audit-Log, das dir gehört.",
        },
      ],
    },
    roster: {
      eyebrow: "Bot-Vorlagen",
      heading: "Gib jedem Bot eine Aufgabe",
      copy: "Starte einen neuen Bot und er interviewt dich — ein paar Fragen zur Arbeit, zu deinem Schreibstil und wo sie lebt. Dann legt er los.",
      bots: DE_ROSTER,
    },
    openSource: {
      eyebrow: "Open Source",
      heading: "Keine Preisseite. Nur das Repo.",
      copy: "Rakazo ist Apache-2.0-lizenziert und läuft auf deiner Maschine mit deinen Model-Keys. Nichts ist freigeschaltet, nichts telefoniert nach Hause.",
      selfHostTitle: "Self-host",
      selfHostMeta: "Heute verfügbar",
      selfHostItems: [
        "Docker-Runner und sandboxierter Browser",
        "Eigene Model-Keys mitbringen",
        "Routinen, Memory und Audit-Log",
        "Unbegrenzte Bots, keine Seats, keine Limits",
        "Community-Support auf GitHub",
      ],
      starOnGithub: "Auf GitHub mit Stern markieren",
      readTheDocs: "Docs lesen",
      cloudTitle: "Cloud",
      cloudBadge: "Demnächst",
      cloudMeta: "Deine Keys, wir betreiben die Computer",
      cloudItems: [
        "Managed Sandboxes, immer an",
        "Deine Keys, dein Model-Spend",
        "Dieselben Bots, dieselben Routinen, keine Migration",
      ],
      getStarted: "Loslegen",
    },
    cta: {
      heading: "Triff deinen ersten Bot",
      copy: "Gib Rakazo etwas, das du aufgeschoben hast — und lass es den Follow-through übernehmen.",
      getStarted: "Loslegen",
      viewOnGithub: "Auf GitHub ansehen",
      openSourceValue: "Open Source",
      selfHostValue: "Self-host",
      stats: [
        { value: "stars", label: "GitHub Stars" },
        { value: "license", label: "Lizenz" },
        { value: "openSource", label: "Keine Seats, keine Gates" },
        { value: "selfHost", label: "Deine Maschine" },
      ],
    },
    getStartedDialog: {
      closeLabel: "Loslegen-Dialog schließen",
      eyebrow: "Loslegen",
      title: "Wie willst du starten?",
      copy: "Jetzt self-hosten mit Docker, oder auf die Cloud-Warteliste.",
      selfHostNow: "Jetzt self-hosten",
      selfHostHint: "Veröffentlichte Images. UI in Minuten. Kein E2B-Key für Signup nötig.",
      cloudWaitlist: "Cloud-Warteliste",
      cloudHint: "Gehostetes Rakazo kommt. Hinterlasse deine E-Mail.",
      back: "Zurück",
      successTitle: "Du bist dabei.",
      successCopy:
        "Wir mailen dir, wenn gehostetes Rakazo bereit ist. Heute starten? Zum Self-host-Abschnitt auf dieser Seite.",
      done: "Fertig",
      viewOnGithub: "Auf GitHub ansehen",
    },
    waitlist: {
      emailLabel: "E-Mail-Adresse",
      placeholder: "du@firma.com",
      submit: "Weiter",
      joining: "Wird eingetragen…",
      success: "Du bist dabei.",
      added: "Hinzugefügt",
      error: "Konnte dich nicht eintragen. Bitte erneut versuchen.",
    },
    footer: {
      navLabel: "Fußzeile",
      languagesLabel: "Sprache",
    },
  },
  ko: {
    title: "Rakazo | 오픈소스 Grok Bot 대안",
    description:
      "Rakazo는 실제 업무를 수행하는 지속형 AI 팀원을 위한 오픈소스 Grok Bot 대안입니다. 키, 모델, 머신 — 모두 당신 것.",
    ogImageAlt: "Rakazo — 진짜로 내 것인 AI 팀원. 키, 모델, 머신 — 모두 당신 것.",
    availableLanguage: "Korean",
    skipToContent: "본문으로 건너뛰기",
    starFallback: "Star",
    nav: {
      primary: "주 메뉴",
      menu: "메뉴",
      product: "제품",
      bots: "봇",
      selfHost: "셀프 호스트",
      openSource: "오픈소스",
      docs: "Docs",
      viewOnGithub: "GitHub에서 보기",
    },
    hero: {
      badge: "Apache-2.0",
      pill: "셀프 호스트",
      heading: "진짜로 내 것인 AI 팀원",
      lead: "Rakazo는 오픈소스 Grok Bot 대안입니다. 봇에게 실제 업무를 맡기세요. 봇이 도구에 로그인하고, 당신처럼 사용하며, 필요할 때 돌아와 묻습니다.",
      getStarted: "시작하기",
      viewOnGithub: "GitHub에서 보기",
      setupWithAgent: "에이전트로 설정하기",
      copiedForAgent: "에이전트용으로 복사됨",
      copyFailed: "복사 실패 — 다시 시도",
    },
    selfHost: {
      eyebrow: "셀프 호스트",
      heading: "컴퓨터는 당신 것",
      copy: "게시된 이미지로 Rakazo를 실행하세요. 로컬 Docker 컴퓨터는 E2B 계정 없이 동작합니다.",
      installTitle: "Docker로 설치",
      installHint: "Docker Engine과 Compose 플러그인이 필요합니다. 기본 태그는 edge(amd64)입니다.",
      computersNote:
        "기본값은 이 호스트의 Docker 컴퓨터입니다. E2B, Daytona, Box는 선택적 원격 제공자입니다.",
      features: [
        {
          title: "어떤 모델이든, 키는 당신 것",
          body: "봇을 Claude, GPT, Grok 또는 로컬 모델에 연결하세요. 봇마다 바꿀 수 있습니다 — 저렴한 모델은 분류하고, 똑똑한 모델은 작성합니다.",
        },
        {
          title: "읽을 수 있는 루틴",
          body: "워크플로를 한 번 보여주면 봇이 읽고 수정하고 커밋할 수 있는 Markdown 루틴으로 저장합니다.",
        },
        {
          title: "지키는 승인",
          body: "봇이 혼자 해도 되는 일과 물어야 하는 일을 정하세요. 모든 액션은 당신이 소유한 감사 로그에 남습니다.",
        },
      ],
    },
    roster: {
      eyebrow: "봇 템플릿",
      heading: "봇마다 역할을 주세요",
      copy: "새 봇을 시작하면 인터뷰합니다 — 업무, 글쓰기 방식, 작업이 어디에 있는지 몇 가지 질문. 그다음 바로 시작합니다.",
      bots: KO_ROSTER,
    },
    openSource: {
      eyebrow: "오픈소스",
      heading: "가격 페이지 없음. 리포만.",
      copy: "Rakazo는 Apache-2.0 라이선스이며, 당신 머신에서 당신 모델 키로 실행됩니다. 잠긴 기능도, 외부로 연락하는 것도 없습니다.",
      selfHostTitle: "셀프 호스트",
      selfHostMeta: "지금 사용 가능",
      selfHostItems: [
        "Docker 러너와 샌드박스 브라우저",
        "모델 키는 직접 가져오기",
        "루틴, 메모리, 감사 로그",
        "봇 무제한, 시트·한도 없음",
        "GitHub 커뮤니티 지원",
      ],
      starOnGithub: "GitHub에서 Star",
      readTheDocs: "문서 읽기",
      cloudTitle: "Cloud",
      cloudBadge: "곧 출시",
      cloudMeta: "키는 당신 것, 컴퓨터는 우리가 운영",
      cloudItems: [
        "상시 가동 관리형 샌드박스",
        "키와 모델 비용은 당신 것",
        "같은 봇, 같은 루틴, 마이그레이션 없음",
      ],
      getStarted: "시작하기",
    },
    cta: {
      heading: "첫 봇을 만나보세요",
      copy: "미뤄 두었던 일을 Rakazo에 맡기고, 후속까지 맡기세요.",
      getStarted: "시작하기",
      viewOnGithub: "GitHub에서 보기",
      openSourceValue: "오픈소스",
      selfHostValue: "셀프 호스트",
      stats: [
        { value: "stars", label: "GitHub 스타" },
        { value: "license", label: "라이선스" },
        { value: "openSource", label: "시트·게이트 없음" },
        { value: "selfHost", label: "당신 머신" },
      ],
    },
    getStartedDialog: {
      closeLabel: "시작하기 대화상자 닫기",
      eyebrow: "시작하기",
      title: "어떻게 시작할까요?",
      copy: "Docker로 지금 셀프 호스트하거나, Cloud 대기열에 등록하세요.",
      selfHostNow: "지금 셀프 호스트",
      selfHostHint: "게시된 이미지. 몇 분 안에 UI. 가입에 E2B 키 불필요.",
      cloudWaitlist: "Cloud 대기열",
      cloudHint: "호스팅 Rakazo가 곧 옵니다. 이메일을 남겨 주세요.",
      back: "뒤로",
      successTitle: "등록되었습니다.",
      successCopy:
        "호스팅 Rakazo가 준비되면 메일로 알려 드립니다. 오늘 시작하려면 이 페이지의 셀프 호스트 섹션으로 이동하세요.",
      done: "완료",
      viewOnGithub: "GitHub에서 보기",
    },
    waitlist: {
      emailLabel: "이메일 주소",
      placeholder: "you@company.com",
      submit: "계속",
      joining: "등록 중…",
      success: "등록되었습니다.",
      added: "추가됨",
      error: "등록하지 못했습니다. 다시 시도하세요.",
    },
    footer: {
      navLabel: "푸터",
      languagesLabel: "언어",
    },
  },
};

export function getHomeCopy(locale: Locale): HomeCopy {
  return HOME_COPY[locale];
}
