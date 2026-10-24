import type { RosterBot } from "../demo";
import { SITE_DESCRIPTION } from "../site";
import { CLAUDE_CHATGPT_SUBSCRIPTION_FAQ } from "../subscription-faq";
import type { Locale } from "./locales";

export const HOME_MODEL_PROVIDERS = ["Claude", "ChatGPT", "OpenRouter", "Grok", "Ollama", "LM Studio"];

export type HomeCopy = {
  title: string;
  description: string;
  ogImageAlt: string;
  availableLanguage: string;
  skipToContent: string;
  starFallback: string;
  nav: {
    home: string;
    primary: string;
    menu: string;
    docs: string;
    blog: string;
    github: string;
    getStarted: string;
  };
  hero: {
    eyebrow: string;
    heading: string;
    lead: string;
    getStarted: string;
    download: Record<"mac" | "windows" | "linux" | "ios" | "android", string>;
    viewOnGithub: string;
    setupWithAgent: string;
    copiedForAgent: string;
    copyFailed: string;
  };
  selfHost: {
    heading: string;
    copy: string;
    worksWith: string;
    mock: { model: string; weekdays: string; approval: string; approve: string; deny: string };
    features: Array<{ title: string; body: string }>;
  };
  platforms: {
    heading: string;
    web: string;
    desktop: string;
    mobile: string;
  };
  roster: {
    eyebrow: string;
    heading: string;
    copy: string;
    bots: RosterBot[];
  };
  testimonials: {
    heading: string;
    pause: string;
    play: string;
    items: ReadonlyArray<{ quote: string; attribution: string }>;
  };
  faq: {
    heading: string;
    items: Array<{ question: string; answer: string }>;
  };
  openSource: {
    heading: string;
    copy: string;
    starOnGithub: string;
    readTheDocs: string;
    cloudTitle: string;
    cloudBadge: string;
  };
  cta: {
    heading: string;
    copy: string;
    openSourceValue: string;
    selfHostValue: string;
    stats: Array<{ value: "stars" | "license" | "openSource" | "selfHost"; label: string }>;
  };
  footer: {
    navLabel: string;
    languagesLabel: string;
    links: {
      docs: string;
      product: string;
      changelog: string;
      alternatives: string;
      all: string;
      about: string;
      support: string;
      privacy: string;
      terms: string;
      company: string;
      blog: string;
      iosApp: string;
      androidApp: string;
    };
  };
};

const EN_ROSTER: RosterBot[] = [
  {
    name: "Sales Outbound",
    color: "#F5A03C",
    slug: "rakazo/sales-outbound",
    desc: "Research prospects and draft follow-ups.",
  },
  {
    name: "Inbox Manager",
    color: "#6A6BF5",
    slug: "rakazo/inbox-manager",
    desc: "Sort email and draft replies.",
  },
  {
    name: "Talent Scout",
    color: "#3B82F6",
    slug: "rakazo/talent-scout",
    desc: "Review applications and shortlist candidates.",
  },
  {
    name: "Expense Manager",
    color: "#F2622A",
    slug: "rakazo/expense-manager",
    desc: "Match receipts to payments.",
  },
  {
    name: "Coding Agent",
    color: "#5B6EE1",
    slug: "rakazo/coding-agent",
    desc: "Make code changes on your computer.",
  },
  {
    name: "Account Manager",
    color: "#9B5CF6",
    slug: "rakazo/account-manager",
    desc: "Prepare replies and track renewals.",
  },
  {
    name: "Paid Media",
    color: "#3EC5A8",
    slug: "rakazo/paid-media",
    desc: "Review ad spend and report changes.",
  },
  {
    name: "Chief of Staff",
    color: "#8B93A8",
    slug: "rakazo/chief-of-staff",
    desc: "Prepare briefings and coordinate your bots.",
  },
];

const DE_ROSTER: RosterBot[] = [
  {
    name: "Sales Outbound",
    color: "#F5A03C",
    slug: "rakazo/sales-outbound",
    desc: "Recherchiert Kunden und entwirft Follow-ups.",
  },
  {
    name: "Inbox Manager",
    color: "#6A6BF5",
    slug: "rakazo/inbox-manager",
    desc: "Sortiert E-Mails und entwirft Antworten.",
  },
  {
    name: "Talent Scout",
    color: "#3B82F6",
    slug: "rakazo/talent-scout",
    desc: "Prüft Bewerbungen und wählt Kandidaten aus.",
  },
  {
    name: "Expense Manager",
    color: "#F2622A",
    slug: "rakazo/expense-manager",
    desc: "Ordnet Belege den Zahlungen zu.",
  },
  {
    name: "Coding Agent",
    color: "#5B6EE1",
    slug: "rakazo/coding-agent",
    desc: "Ändert Code auf deinem Computer.",
  },
  {
    name: "Account Manager",
    color: "#9B5CF6",
    slug: "rakazo/account-manager",
    desc: "Bereitet Antworten vor und verfolgt Vertragsverlängerungen.",
  },
  {
    name: "Paid Media",
    color: "#3EC5A8",
    slug: "rakazo/paid-media",
    desc: "Prüft Werbeausgaben und meldet Änderungen.",
  },
  {
    name: "Chief of Staff",
    color: "#8B93A8",
    slug: "rakazo/chief-of-staff",
    desc: "Erstellt Briefings und koordiniert deine Bots.",
  },
];

const KO_ROSTER: RosterBot[] = [
  {
    name: "Sales Outbound",
    color: "#F5A03C",
    slug: "rakazo/sales-outbound",
    desc: "잠재 고객을 조사하고 후속 메일을 작성합니다.",
  },
  {
    name: "Inbox Manager",
    color: "#6A6BF5",
    slug: "rakazo/inbox-manager",
    desc: "메일을 분류하고 답장 초안을 씁니다.",
  },
  {
    name: "Talent Scout",
    color: "#3B82F6",
    slug: "rakazo/talent-scout",
    desc: "지원서를 검토하고 후보를 추립니다.",
  },
  {
    name: "Expense Manager",
    color: "#F2622A",
    slug: "rakazo/expense-manager",
    desc: "영수증과 결제 내역을 맞춥니다.",
  },
  {
    name: "Coding Agent",
    color: "#5B6EE1",
    slug: "rakazo/coding-agent",
    desc: "내 컴퓨터에서 코드를 수정합니다.",
  },
  {
    name: "Account Manager",
    color: "#9B5CF6",
    slug: "rakazo/account-manager",
    desc: "답변을 준비하고 계약 갱신을 챙깁니다.",
  },
  {
    name: "Paid Media",
    color: "#3EC5A8",
    slug: "rakazo/paid-media",
    desc: "광고 지출을 검토하고 변화를 보고합니다.",
  },
  {
    name: "Chief of Staff",
    color: "#8B93A8",
    slug: "rakazo/chief-of-staff",
    desc: "브리핑을 준비하고 봇을 조율합니다.",
  },
];

const ZH_ROSTER: RosterBot[] = [
  {
    name: "Sales Outbound",
    color: "#F5A03C",
    slug: "rakazo/sales-outbound",
    desc: "调研客户，起草跟进邮件。",
  },
  {
    name: "Inbox Manager",
    color: "#6A6BF5",
    slug: "rakazo/inbox-manager",
    desc: "整理邮件，起草回复。",
  },
  {
    name: "Talent Scout",
    color: "#3B82F6",
    slug: "rakazo/talent-scout",
    desc: "审核简历，筛选候选人。",
  },
  {
    name: "Expense Manager",
    color: "#F2622A",
    slug: "rakazo/expense-manager",
    desc: "核对收据与付款。",
  },
  {
    name: "Coding Agent",
    color: "#5B6EE1",
    slug: "rakazo/coding-agent",
    desc: "在你的电脑上修改代码。",
  },
  {
    name: "Account Manager",
    color: "#9B5CF6",
    slug: "rakazo/account-manager",
    desc: "准备回复，跟进续约。",
  },
  {
    name: "Paid Media",
    color: "#3EC5A8",
    slug: "rakazo/paid-media",
    desc: "检查广告支出，汇报变化。",
  },
  {
    name: "Chief of Staff",
    color: "#8B93A8",
    slug: "rakazo/chief-of-staff",
    desc: "准备简报，协调 Bot。",
  },
];

const JA_ROSTER: RosterBot[] = [
  {
    name: "Sales Outbound",
    color: "#F5A03C",
    slug: "rakazo/sales-outbound",
    desc: "見込み客を調べて、フォローアップを下書きします。",
  },
  {
    name: "Inbox Manager",
    color: "#6A6BF5",
    slug: "rakazo/inbox-manager",
    desc: "メールを仕分けて、返信を下書きします。",
  },
  {
    name: "Talent Scout",
    color: "#3B82F6",
    slug: "rakazo/talent-scout",
    desc: "応募書類を確認して、候補者を絞り込みます。",
  },
  {
    name: "Expense Manager",
    color: "#F2622A",
    slug: "rakazo/expense-manager",
    desc: "領収書と支払いを照合します。",
  },
  {
    name: "Coding Agent",
    color: "#5B6EE1",
    slug: "rakazo/coding-agent",
    desc: "あなたのコンピューターでコードを変更します。",
  },
  {
    name: "Account Manager",
    color: "#9B5CF6",
    slug: "rakazo/account-manager",
    desc: "返信を準備して、契約更新を管理します。",
  },
  {
    name: "Paid Media",
    color: "#3EC5A8",
    slug: "rakazo/paid-media",
    desc: "広告費を確認して、変化を報告します。",
  },
  {
    name: "Chief of Staff",
    color: "#8B93A8",
    slug: "rakazo/chief-of-staff",
    desc: "ブリーフィングを準備して、ボットたちを取りまとめます。",
  },
];

const TESTIMONIALS: HomeCopy["testimonials"]["items"] = [
  {
    quote:
      "landed here after a first experience with Grok Bot … then found this alternative, and i can confirm that your work rocks. it replaced totally grok bot for me. mobile app is very smooth too",
    attribution: "@dilog1114",
  },
  {
    quote:
      "Im a co-founder and cto, loving rakazo, we have it running against private on qwen 3.8 with strong hw/gpus - all private.",
    attribution: "@bc101101",
  },
  {
    quote:
      "I use it to find cheap servers and computer parts on ebay and all other marketplaces and send me everything he decided is a good deal.",
    attribution: "@michaelortnerit",
  },
  {
    quote:
      "Hermes is good but more complicated setup. Rakazo has better multi agent workflow and simpler to setup",
    attribution: "@notabot_92732",
  },
  {
    quote: "ive been using rakazo for 1 month in claude oauth no problems yet",
    attribution: "@hey_cabron",
  },
  {
    quote:
      "I set up the mobile app today with expo, first time using expo but was easy with rakazo walking me through",
    attribution: "@mithril0x",
  },
];

const HOME_COPY: Record<Locale, HomeCopy> = {
  en: {
    title: "Rakazo | Open source Grok Bot alternative",
    description: SITE_DESCRIPTION,
    ogImageAlt:
      "Rakazo. AI teammates you actually own. Your keys, your model, your machine.",
    availableLanguage: "English",
    skipToContent: "Skip to content",
    starFallback: "Star",
    nav: {
      home: "Rakazo home",
      primary: "Primary",
      menu: "Menu",
      docs: "Docs",
      blog: "Blog",
      github: "GitHub",
      getStarted: "Get started",
    },
    hero: {
      eyebrow: "Open source",
      heading: "The open source Grok Bot alternative you actually own",
      lead: "Give your bots a job. Check in from any device.",
      getStarted: "Get started",
      download: {
        mac: "Download for macOS",
        windows: "Download for Windows",
        linux: "Download for Linux",
        ios: "Download for iOS",
        android: "Download for Android",
      },
      viewOnGithub: "View on GitHub",
      setupWithAgent: "Set up with your agent",
      copiedForAgent: "Copied for your agent",
      copyFailed: "Copy failed. Try again.",
    },
    selfHost: {
      heading: "Self-hosted",
      copy: "Your machine, your models, your control.",
      worksWith: "Works with",
      mock: { model: "Model", weekdays: "Weekdays at 9:00", approval: "Approval required", approve: "Approve", deny: "Deny" },
      features: [
        { title: "Your model", body: "Choose a different model for each bot." },
        { title: "Work on a schedule", body: "Run recurring tasks while your computer stays on." },
        { title: "You set the limits", body: "Decide which actions need your approval." },
      ],
    },
    platforms: {
      heading: "Wherever you are",
      web: "Web",
      desktop: "Desktop",
      mobile: "Mobile",
    },
    roster: {
      eyebrow: "Your bot team",
      heading: "Give each bot a job",
      copy: "Start with a template. Make it yours.",
      bots: EN_ROSTER,
    },
    testimonials: {
      heading: "People love it",
      pause: "Pause",
      play: "Play",
      items: TESTIMONIALS,
    },
    faq: {
      heading: "FAQ",
      items: [
        CLAUDE_CHATGPT_SUBSCRIPTION_FAQ,
        {
          question: "Do I need an API key if I already pay for Claude or ChatGPT?",
          answer:
            "No. Sign in with Claude Pro/Max or ChatGPT Plus/Pro and that subscription covers the model. An API key is the other path, for Anthropic, OpenAI, OpenRouter, or Grok. Rakazo does not pay either way.",
        },
        {
          question: "Can I run a local model?",
          answer:
            "Yes. Point a bot at a local OpenAI-compatible server such as Ollama or LM Studio. Each bot can use a different model.",
        },
      ],
    },
    openSource: {
      heading: "Open source",
      copy: "Apache-2.0. Run it, change it, make it yours.",
      starOnGithub: "Star on GitHub",
      readTheDocs: "Read the docs",
      cloudTitle: "Cloud",
      cloudBadge: "Beta",
    },
    cta: {
      heading: "Meet your first bot",
      copy: "Hand over your next task.",
      openSourceValue: "Open source",
      selfHostValue: "Self-host",
      stats: [
        { value: "stars", label: "GitHub stars" },
        { value: "license", label: "License" },
        { value: "openSource", label: "No seats, no gates" },
        { value: "selfHost", label: "Your machine" },
      ],
    },
    footer: {
      navLabel: "Footer",
      languagesLabel: "Language",
      links: {
        docs: "Docs",
        product: "Product",
        changelog: "Changelog",
        alternatives: "Alternatives",
        all: "All",
        about: "About",
        support: "Support",
        privacy: "Privacy",
        terms: "Terms",
        company: "Company",
        blog: "Blog",
        iosApp: "iPhone app",
        androidApp: "Android app",
      },
    },
  },
  de: {
    title: "Rakazo | Open-Source-Alternative zu Grok Bot",
    description:
      "Rakazo ist eine Open-Source-Alternative zu Grok Bot für persistente KI-Teamkollegen, die echte Arbeit erledigen. Deine Keys, dein Modell, deine Maschine.",
    ogImageAlt:
      "Rakazo. KI-Teamkollegen, die dir wirklich gehören. Deine Keys, dein Modell, deine Maschine.",
    availableLanguage: "German",
    skipToContent: "Zum Inhalt springen",
    starFallback: "Star",
    nav: {
      home: "Rakazo-Startseite",
      primary: "Hauptnavigation",
      menu: "Menü",
      docs: "Docs",
      blog: "Blog",
      github: "GitHub",
      getStarted: "Loslegen",
    },
    hero: {
      eyebrow: "Open Source",
      heading: "Die Open-Source-Alternative zu Grok Bot, die dir wirklich gehört",
      lead: "Gib deinen Bots eine Aufgabe. Schau von jedem Gerät nach.",
      getStarted: "Loslegen",
      download: {
        mac: "Für macOS laden",
        windows: "Für Windows laden",
        linux: "Für Linux laden",
        ios: "Für iOS laden",
        android: "Für Android laden",
      },
      viewOnGithub: "Auf GitHub ansehen",
      setupWithAgent: "Mit deinem Agenten einrichten",
      copiedForAgent: "Für deinen Agenten kopiert",
      copyFailed: "Kopieren fehlgeschlagen. Erneut versuchen.",
    },
    selfHost: {
      heading: "Self-hosted",
      copy: "Deine Maschine, deine Modelle, deine Kontrolle.",
      worksWith: "Funktioniert mit",
      mock: { model: "Modell", weekdays: "Mo–Fr um 9:00", approval: "Freigabe erforderlich", approve: "Genehmigen", deny: "Ablehnen" },
      features: [
        { title: "Dein Modell", body: "Wähle für jeden Bot ein anderes Modell." },
        { title: "Arbeitet nach Zeitplan", body: "Wiederkehrende Aufgaben laufen, solange dein Computer an ist." },
        { title: "Du setzt die Grenzen", body: "Bestimme, welche Aktionen deine Freigabe brauchen." },
      ],
    },
    platforms: {
      heading: "Überall, wo du bist",
      web: "Web",
      desktop: "Desktop",
      mobile: "Mobil",
    },
    roster: {
      eyebrow: "Dein Bot-Team",
      heading: "Gib jedem Bot eine Aufgabe",
      copy: "Wähle eine Vorlage und passe sie an.",
      bots: DE_ROSTER,
    },
    testimonials: {
      heading: "Die Leute lieben es",
      pause: "Pause",
      play: "Weiter",
      items: TESTIMONIALS,
    },
    faq: {
      heading: "FAQ",
      items: [
        {
          question: "Kann ich mein Claude Pro/Max- oder ChatGPT Plus/Pro-Abo nutzen?",
          answer:
            "Ja — melde dich mit diesem Abo an, oder nutze einen API-Key, OpenRouter oder einen lokalen OpenAI-kompatiblen Server (Ollama, LM Studio usw.). Rakazo zahlt die Modellrechnung nicht.",
        },
        {
          question: "Brauche ich einen API-Key, wenn ich schon für Claude oder ChatGPT zahle?",
          answer:
            "Nein. Melde dich mit Claude Pro/Max oder ChatGPT Plus/Pro an. Dieses Abo deckt das Modell ab. Ein API-Key ist der andere Weg, für Anthropic, OpenAI, OpenRouter oder Grok. Rakazo zahlt so oder so nicht.",
        },
        {
          question: "Kann ich ein lokales Modell nutzen?",
          answer:
            "Ja. Richte einen Bot auf einen lokalen OpenAI-kompatiblen Server wie Ollama oder LM Studio. Jeder Bot kann ein anderes Modell nutzen.",
        },
      ],
    },
    openSource: {
      heading: "Open Source",
      copy: "Apache-2.0. Selbst betreiben, ändern und anpassen.",
      starOnGithub: "Auf GitHub mit Stern markieren",
      readTheDocs: "Docs lesen",
      cloudTitle: "Cloud",
      cloudBadge: "Beta",
    },
    cta: {
      heading: "Triff deinen ersten Bot",
      copy: "Gib deine nächste Aufgabe ab.",
      openSourceValue: "Open Source",
      selfHostValue: "Self-host",
      stats: [
        { value: "stars", label: "GitHub Stars" },
        { value: "license", label: "Lizenz" },
        { value: "openSource", label: "Keine Seats, keine Gates" },
        { value: "selfHost", label: "Deine Maschine" },
      ],
    },
    footer: {
      navLabel: "Fußzeile",
      languagesLabel: "Sprache",
      links: {
        docs: "Dokumentation",
        product: "Produkt",
        changelog: "Änderungsprotokoll",
        alternatives: "Alternativen",
        all: "Alle",
        about: "Über uns",
        support: "Support",
        privacy: "Datenschutz",
        terms: "AGB",
        company: "Unternehmen",
        blog: "Blog",
        iosApp: "iPhone-App",
        androidApp: "Android-App",
      },
    },
  },
  ko: {
    title: "Rakazo | 오픈소스 Grok Bot 대안",
    description:
      "Rakazo는 실제 업무를 수행하는 지속형 AI 팀원을 위한 오픈소스 Grok Bot 대안입니다. 키, 모델, 머신, 모두 당신 것.",
    ogImageAlt: "Rakazo. 진짜로 내 것인 AI 팀원. 키, 모델, 머신, 모두 당신 것.",
    availableLanguage: "Korean",
    skipToContent: "본문으로 건너뛰기",
    starFallback: "Star",
    nav: {
      home: "Rakazo 홈",
      primary: "주 메뉴",
      menu: "메뉴",
      docs: "Docs",
      blog: "블로그",
      github: "GitHub",
      getStarted: "시작하기",
    },
    hero: {
      eyebrow: "오픈 소스",
      heading: "진짜로 내 것인 오픈소스 Grok Bot 대안",
      lead: "봇에게 일을 맡기세요. 어떤 기기에서든 확인하세요.",
      getStarted: "시작하기",
      download: {
        mac: "macOS용 다운로드",
        windows: "Windows용 다운로드",
        linux: "Linux용 다운로드",
        ios: "iOS용 다운로드",
        android: "Android용 다운로드",
      },
      viewOnGithub: "GitHub에서 보기",
      setupWithAgent: "에이전트로 설정하기",
      copiedForAgent: "에이전트용으로 복사됨",
      copyFailed: "복사 실패. 다시 시도하세요.",
    },
    selfHost: {
      heading: "셀프 호스트",
      copy: "컴퓨터도, 모델도, 제어권도 내 손에.",
      worksWith: "지원 모델·서비스",
      mock: { model: "모델", weekdays: "평일 9:00", approval: "승인 필요", approve: "승인", deny: "거부" },
      features: [
        { title: "원하는 모델", body: "봇마다 다른 모델을 선택하세요." },
        { title: "예약한 시간에 실행", body: "컴퓨터를 켜 두면 반복 작업을 실행합니다." },
        { title: "내가 정하는 권한", body: "승인이 필요한 작업을 정하세요." },
      ],
    },
    platforms: {
      heading: "어디서든",
      web: "웹",
      desktop: "데스크톱",
      mobile: "모바일",
    },
    roster: {
      eyebrow: "나만의 봇 팀",
      heading: "봇마다 역할을 주세요",
      copy: "템플릿을 골라 내 일에 맞추세요.",
      bots: KO_ROSTER,
    },
    testimonials: {
      heading: "다들 좋아해요",
      pause: "일시정지",
      play: "재생",
      items: TESTIMONIALS,
    },
    faq: {
      heading: "질문",
      items: [
        {
          question: "Claude Pro/Max 또는 ChatGPT Plus/Pro 구독을 쓸 수 있나요?",
          answer:
            "네 — 그 구독으로 로그인하거나, API 키, OpenRouter, 로컬 OpenAI 호환 서버(Ollama, LM Studio 등)를 사용하세요. 모델 요금은 Rakazo가 내지 않습니다.",
        },
        {
          question: "이미 Claude나 ChatGPT를 결제 중이면 API 키가 필요한가요?",
          answer:
            "아니요. Claude Pro/Max 또는 ChatGPT Plus/Pro로 로그인하면 그 구독이 모델을 부담합니다. API 키는 Anthropic, OpenAI, OpenRouter, Grok을 쓰는 다른 경로입니다. 어느 쪽이든 Rakazo가 요금을 내지 않습니다.",
        },
        {
          question: "로컬 모델을 쓸 수 있나요?",
          answer:
            "네. Ollama나 LM Studio 같은 로컬 OpenAI 호환 서버에 봇을 연결하세요. 봇마다 다른 모델을 쓸 수 있습니다.",
        },
      ],
    },
    openSource: {
      heading: "오픈소스",
      copy: "Apache-2.0. 직접 실행하고 원하는 대로 수정하세요.",
      starOnGithub: "GitHub에서 Star",
      readTheDocs: "문서 읽기",
      cloudTitle: "Cloud",
      cloudBadge: "베타",
    },
    cta: {
      heading: "첫 봇을 만나보세요",
      copy: "다음 할 일을 맡겨 보세요.",
      openSourceValue: "오픈소스",
      selfHostValue: "셀프 호스트",
      stats: [
        { value: "stars", label: "GitHub 스타" },
        { value: "license", label: "라이선스" },
        { value: "openSource", label: "시트·게이트 없음" },
        { value: "selfHost", label: "당신 머신" },
      ],
    },
    footer: {
      navLabel: "푸터",
      languagesLabel: "언어",
      links: {
        docs: "문서",
        product: "제품",
        changelog: "변경 내역",
        alternatives: "대안",
        all: "전체",
        about: "소개",
        support: "지원",
        privacy: "개인정보 처리방침",
        terms: "이용약관",
        company: "회사",
        blog: "블로그",
        iosApp: "iPhone 앱",
        androidApp: "Android 앱",
      },
    },
  },
  zh: {
    title: "Rakazo | 开源 Grok Bot 替代品",
    description:
      "Rakazo 是一个开源 Grok Bot 替代品，用于运行真正干活的持久化 AI 队友。密钥、模型、机器，都归你所有。",
    ogImageAlt: "Rakazo：真正属于你的 AI 队友。密钥、模型、机器，都归你所有。",
    availableLanguage: "Chinese",
    skipToContent: "跳到主要内容",
    starFallback: "加星",
    nav: {
      home: "Rakazo 首页",
      primary: "主导航",
      menu: "菜单",
      docs: "文档",
      blog: "博客",
      github: "GitHub",
      getStarted: "开始使用",
    },
    hero: {
      eyebrow: "开源",
      heading: "真正属于你的开源 Grok Bot 替代品",
      lead: "把工作交给 Bot，随时用任意设备查看。",
      getStarted: "开始使用",
      download: {
        mac: "下载 macOS 版",
        windows: "下载 Windows 版",
        linux: "下载 Linux 版",
        ios: "下载 iOS 版",
        android: "下载 Android 版",
      },
      viewOnGithub: "在 GitHub 上查看",
      setupWithAgent: "用你的智能体安装",
      copiedForAgent: "已为你的智能体复制",
      copyFailed: "复制失败。请重试。",
    },
    selfHost: {
      heading: "自托管",
      copy: "电脑、模型、控制权，都归你。",
      worksWith: "支持",
      mock: { model: "模型", weekdays: "工作日 9:00", approval: "需要审批", approve: "批准", deny: "拒绝" },
      features: [
        { title: "自选模型", body: "为每个 Bot 选择不同的模型。" },
        { title: "按时自动执行", body: "电脑保持开机，重复任务按时执行。" },
        { title: "由你设定权限", body: "决定哪些操作需要你批准。" },
      ],
    },
    platforms: {
      heading: "随时随地",
      web: "网页版",
      desktop: "桌面端",
      mobile: "移动端",
    },
    roster: {
      eyebrow: "你的 Bot 团队",
      heading: "给每个 Bot 分配工作",
      copy: "选个模板，按你的需求调整。",
      bots: ZH_ROSTER,
    },
    testimonials: {
      heading: "大家都爱它",
      pause: "暂停",
      play: "播放",
      items: TESTIMONIALS,
    },
    faq: {
      heading: "常见问题",
      items: [
        {
          question: "可以用我的 Claude Pro/Max 或 ChatGPT Plus/Pro 订阅吗？",
          answer:
            "可以 — 用该订阅登录，或使用 API 密钥、OpenRouter，或本地的 OpenAI 兼容服务（Ollama、LM Studio 等）。模型费用不由 Rakazo 支付。",
        },
        {
          question: "已经在为 Claude 或 ChatGPT 付费，还需要 API 密钥吗？",
          answer:
            "不需要。用 Claude Pro/Max 或 ChatGPT Plus/Pro 登录，由该订阅承担模型费用。API 密钥是另一条路，用于 Anthropic、OpenAI、OpenRouter 或 Grok。两种方式都不是 Rakazo 付费。",
        },
        {
          question: "可以用本地模型吗？",
          answer:
            "可以。把 Bot 指向 Ollama 或 LM Studio 这类本地 OpenAI 兼容服务。每个 Bot 可以使用不同的模型。",
        },
      ],
    },
    openSource: {
      heading: "开源",
      copy: "Apache-2.0。自由运行、修改，按需定制。",
      starOnGithub: "在 GitHub 上点星",
      readTheDocs: "阅读文档",
      cloudTitle: "云端",
      cloudBadge: "测试版",
    },
    cta: {
      heading: "认识你的第一个 Bot",
      copy: "把下一项任务交给 Bot。",
      openSourceValue: "开源",
      selfHostValue: "自托管",
      stats: [
        { value: "stars", label: "GitHub 星标" },
        { value: "license", label: "许可证" },
        { value: "openSource", label: "无席位、无门槛" },
        { value: "selfHost", label: "你的机器" },
      ],
    },
    footer: {
      navLabel: "页脚",
      languagesLabel: "语言",
      links: {
        docs: "文档",
        product: "产品",
        changelog: "更新日志",
        alternatives: "替代方案",
        all: "全部",
        about: "关于",
        support: "支持",
        privacy: "隐私",
        terms: "条款",
        company: "公司",
        blog: "博客",
        iosApp: "iPhone 应用",
        androidApp: "Android 应用",
      },
    },
  },
  ja: {
    title: "Rakazo | オープンソースの Grok Bot 代替ツール",
    description:
      "Rakazo は、実際の仕事をこなす常駐型 AI チームメイトのための、オープンソースの Grok Bot 代替ツールです。キーもモデルもマシンも、すべてあなたのものです。",
    ogImageAlt:
      "Rakazo。本当に自分のものにできる AI チームメイト。キーもモデルもマシンも、すべてあなたのもの。",
    availableLanguage: "Japanese",
    skipToContent: "本文へスキップ",
    starFallback: "Star",
    nav: {
      home: "Rakazo ホーム",
      primary: "メインナビゲーション",
      menu: "メニュー",
      docs: "ドキュメント",
      blog: "ブログ",
      github: "GitHub",
      getStarted: "はじめる",
    },
    hero: {
      eyebrow: "オープンソース",
      heading: "本当に自分のものにできる、オープンソースの Grok Bot 代替ツール",
      lead: "ボットに仕事を任せて、どのデバイスからでも確認できます。",
      getStarted: "はじめる",
      download: {
        mac: "macOS 版をダウンロード",
        windows: "Windows 版をダウンロード",
        linux: "Linux 版をダウンロード",
        ios: "iOS 版をダウンロード",
        android: "Android 版をダウンロード",
      },
      viewOnGithub: "GitHub で見る",
      setupWithAgent: "エージェントでセットアップ",
      copiedForAgent: "エージェント用にコピーしました",
      copyFailed: "コピーできませんでした。もう一度お試しください。",
    },
    selfHost: {
      heading: "セルフホスト",
      copy: "マシンもモデルも、コントロールもあなたの手に。",
      worksWith: "対応サービス",
      mock: { model: "モデル", weekdays: "平日 9:00", approval: "承認が必要", approve: "承認", deny: "拒否" },
      features: [
        { title: "好きなモデルで", body: "ボットごとに別のモデルを選べます。" },
        { title: "スケジュールどおりに実行", body: "コンピューターが起動している間、定期タスクを実行します。" },
        { title: "制限はあなたが決める", body: "どの操作に承認が必要かを決められます。" },
      ],
    },
    platforms: {
      heading: "どこにいても",
      web: "Web",
      desktop: "デスクトップ",
      mobile: "モバイル",
    },
    roster: {
      eyebrow: "あなたのボットチーム",
      heading: "ボットごとに仕事を任せましょう",
      copy: "テンプレートから始めて、自分好みに。",
      bots: JA_ROSTER,
    },
    testimonials: {
      heading: "多くの人に愛用されています",
      pause: "一時停止",
      play: "再生",
      items: TESTIMONIALS,
    },
    faq: {
      heading: "よくある質問",
      items: [
        {
          question: "Claude Pro/Max や ChatGPT Plus/Pro のサブスクリプションを使えますか？",
          answer:
            "はい。そのサブスクリプションでサインインするか、API キー、OpenRouter、ローカルの OpenAI 互換サーバー（Ollama、LM Studio など）を使えます。モデルの利用料を Rakazo が支払うことはありません。",
        },
        {
          question: "Claude や ChatGPT にすでに課金している場合、API キーは必要ですか？",
          answer:
            "いいえ。Claude Pro/Max または ChatGPT Plus/Pro でサインインすれば、そのサブスクリプションでモデルを利用できます。もう一つの方法は API キーで、Anthropic、OpenAI、OpenRouter、Grok に対応しています。どちらの場合も、Rakazo が料金を支払うことはありません。",
        },
        {
          question: "ローカルモデルを使えますか？",
          answer:
            "はい。Ollama や LM Studio などのローカルの OpenAI 互換サーバーにボットを接続できます。ボットごとに別のモデルを使えます。",
        },
      ],
    },
    openSource: {
      heading: "オープンソース",
      copy: "Apache-2.0。自由に実行し、変更して、自分のものに。",
      starOnGithub: "GitHub で Star する",
      readTheDocs: "ドキュメントを読む",
      cloudTitle: "クラウド",
      cloudBadge: "ベータ",
    },
    cta: {
      heading: "最初のボットを迎えましょう",
      copy: "次のタスクを任せてみましょう。",
      openSourceValue: "オープンソース",
      selfHostValue: "セルフホスト",
      stats: [
        { value: "stars", label: "GitHub スター" },
        { value: "license", label: "ライセンス" },
        { value: "openSource", label: "シート課金なし、機能制限なし" },
        { value: "selfHost", label: "あなたのマシン" },
      ],
    },
    footer: {
      navLabel: "フッター",
      languagesLabel: "言語",
      links: {
        docs: "ドキュメント",
        product: "製品",
        changelog: "変更履歴",
        alternatives: "代替ツール",
        all: "すべて",
        about: "概要",
        support: "サポート",
        privacy: "プライバシー",
        terms: "利用規約",
        company: "会社情報",
        blog: "ブログ",
        iosApp: "iPhone アプリ",
        androidApp: "Android アプリ",
      },
    },
  },
};

export function getHomeCopy(locale: Locale): HomeCopy {
  return HOME_COPY[locale];
}
