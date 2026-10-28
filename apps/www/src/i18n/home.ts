import type { RosterBot } from "../demo";
import { SITE_DESCRIPTION } from "../site";
import { CLAUDE_CHATGPT_SUBSCRIPTION_FAQ } from "../subscription-faq";
import type { Locale } from "./locales";

export const HOME_MODEL_PROVIDERS = ["Claude", "ChatGPT", "OpenRouter", "Grok", "Ollama", "LM Studio"];

export const HOME_CHANNELS = [
  { id: "slack", name: "Slack", selfHosted: false },
  { id: "imessage", name: "iMessage & SMS", selfHosted: true },
  { id: "whatsapp", name: "WhatsApp", selfHosted: true },
  { id: "telegram", name: "Telegram", selfHosted: true },
] as const;

export const HOME_FEATURE_KINDS = ["apps", "teach", "memory", "triggers", "team", "call"] as const;
export type HomeFeatureKind = (typeof HOME_FEATURE_KINDS)[number];


export type HomeCopy = {
  title: string;
  description: string;
  ogImageAlt: string;
  availableLanguage: string;
  skipToContent: string;
  nav: {
    home: string;
    primary: string;
    menu: string;
    docs: string;
    integrations: string;
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
  channels: {
    heading: string;
    copy: string;
    mock: { ask: string; reply: string };
  };
  features: {
    heading: string;
    items: Record<HomeFeatureKind, { title: string; body: string }>;
    mock: {
      calling: string;
      memory: string;
      memoryNotes: [string, string];
      triggers: [string, string, string];
      recording: string;
      skillSaved: string;
    };
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

const ES_ROSTER: RosterBot[] = [
  {
    name: "Sales Outbound",
    color: "#F5A03C",
    slug: "rakazo/sales-outbound",
    desc: "Investiga prospectos y redacta seguimientos.",
  },
  {
    name: "Inbox Manager",
    color: "#6A6BF5",
    slug: "rakazo/inbox-manager",
    desc: "Ordena el correo y redacta respuestas.",
  },
  {
    name: "Talent Scout",
    color: "#3B82F6",
    slug: "rakazo/talent-scout",
    desc: "Revisa solicitudes y preselecciona candidatos.",
  },
  {
    name: "Expense Manager",
    color: "#F2622A",
    slug: "rakazo/expense-manager",
    desc: "Concilia recibos con pagos.",
  },
  {
    name: "Coding Agent",
    color: "#5B6EE1",
    slug: "rakazo/coding-agent",
    desc: "Hace cambios en el código en tu computadora.",
  },
  {
    name: "Account Manager",
    color: "#9B5CF6",
    slug: "rakazo/account-manager",
    desc: "Prepara respuestas y sigue las renovaciones.",
  },
  {
    name: "Paid Media",
    color: "#3EC5A8",
    slug: "rakazo/paid-media",
    desc: "Revisa el gasto en anuncios e informa de los cambios.",
  },
  {
    name: "Chief of Staff",
    color: "#8B93A8",
    slug: "rakazo/chief-of-staff",
    desc: "Prepara resúmenes y coordina a tus bots.",
  },
];

const FR_ROSTER: RosterBot[] = [
  {
    name: "Sales Outbound",
    color: "#F5A03C",
    slug: "rakazo/sales-outbound",
    desc: "Recherche des prospects et rédige des relances.",
  },
  {
    name: "Inbox Manager",
    color: "#6A6BF5",
    slug: "rakazo/inbox-manager",
    desc: "Trie les e-mails et rédige des réponses.",
  },
  {
    name: "Talent Scout",
    color: "#3B82F6",
    slug: "rakazo/talent-scout",
    desc: "Examine les candidatures et présélectionne les candidats.",
  },
  {
    name: "Expense Manager",
    color: "#F2622A",
    slug: "rakazo/expense-manager",
    desc: "Rapproche les reçus des paiements.",
  },
  {
    name: "Coding Agent",
    color: "#5B6EE1",
    slug: "rakazo/coding-agent",
    desc: "Modifie le code sur votre ordinateur.",
  },
  {
    name: "Account Manager",
    color: "#9B5CF6",
    slug: "rakazo/account-manager",
    desc: "Prépare des réponses et suit les renouvellements.",
  },
  {
    name: "Paid Media",
    color: "#3EC5A8",
    slug: "rakazo/paid-media",
    desc: "Analyse les dépenses publicitaires et signale les changements.",
  },
  {
    name: "Chief of Staff",
    color: "#8B93A8",
    slug: "rakazo/chief-of-staff",
    desc: "Prépare des briefings et coordonne vos bots.",
  },
];

const PT_BR_ROSTER: RosterBot[] = [
  {
    name: "Sales Outbound",
    color: "#F5A03C",
    slug: "rakazo/sales-outbound",
    desc: "Pesquisa prospects e escreve follow-ups.",
  },
  {
    name: "Inbox Manager",
    color: "#6A6BF5",
    slug: "rakazo/inbox-manager",
    desc: "Organiza e-mails e escreve respostas.",
  },
  {
    name: "Talent Scout",
    color: "#3B82F6",
    slug: "rakazo/talent-scout",
    desc: "Analisa candidaturas e pré-seleciona candidatos.",
  },
  {
    name: "Expense Manager",
    color: "#F2622A",
    slug: "rakazo/expense-manager",
    desc: "Concilia recibos com pagamentos.",
  },
  {
    name: "Coding Agent",
    color: "#5B6EE1",
    slug: "rakazo/coding-agent",
    desc: "Faz alterações no código no seu computador.",
  },
  {
    name: "Account Manager",
    color: "#9B5CF6",
    slug: "rakazo/account-manager",
    desc: "Prepara respostas e acompanha renovações.",
  },
  {
    name: "Paid Media",
    color: "#3EC5A8",
    slug: "rakazo/paid-media",
    desc: "Analisa gastos com anúncios e relata mudanças.",
  },
  {
    name: "Chief of Staff",
    color: "#8B93A8",
    slug: "rakazo/chief-of-staff",
    desc: "Prepara resumos e coordena seus bots.",
  },
];

const NL_ROSTER: RosterBot[] = [
  {
    name: "Sales Outbound",
    color: "#F5A03C",
    slug: "rakazo/sales-outbound",
    desc: "Onderzoekt prospects en schrijft follow-ups.",
  },
  {
    name: "Inbox Manager",
    color: "#6A6BF5",
    slug: "rakazo/inbox-manager",
    desc: "Sorteert e-mail en schrijft conceptantwoorden.",
  },
  {
    name: "Talent Scout",
    color: "#3B82F6",
    slug: "rakazo/talent-scout",
    desc: "Beoordeelt sollicitaties en maakt een shortlist.",
  },
  {
    name: "Expense Manager",
    color: "#F2622A",
    slug: "rakazo/expense-manager",
    desc: "Koppelt bonnetjes aan betalingen.",
  },
  {
    name: "Coding Agent",
    color: "#5B6EE1",
    slug: "rakazo/coding-agent",
    desc: "Past code aan op je computer.",
  },
  {
    name: "Account Manager",
    color: "#9B5CF6",
    slug: "rakazo/account-manager",
    desc: "Bereidt antwoorden voor en volgt verlengingen.",
  },
  {
    name: "Paid Media",
    color: "#3EC5A8",
    slug: "rakazo/paid-media",
    desc: "Controleert advertentie-uitgaven en meldt wijzigingen.",
  },
  {
    name: "Chief of Staff",
    color: "#8B93A8",
    slug: "rakazo/chief-of-staff",
    desc: "Maakt briefings en coördineert je bots.",
  },
];

const RU_ROSTER: RosterBot[] = [
  {
    name: "Sales Outbound",
    color: "#F5A03C",
    slug: "rakazo/sales-outbound",
    desc: "Изучает потенциальных клиентов и готовит повторные письма.",
  },
  {
    name: "Inbox Manager",
    color: "#6A6BF5",
    slug: "rakazo/inbox-manager",
    desc: "Сортирует почту и готовит черновики ответов.",
  },
  {
    name: "Talent Scout",
    color: "#3B82F6",
    slug: "rakazo/talent-scout",
    desc: "Разбирает отклики и отбирает кандидатов.",
  },
  {
    name: "Expense Manager",
    color: "#F2622A",
    slug: "rakazo/expense-manager",
    desc: "Сопоставляет чеки с платежами.",
  },
  {
    name: "Coding Agent",
    color: "#5B6EE1",
    slug: "rakazo/coding-agent",
    desc: "Вносит изменения в код на вашем компьютере.",
  },
  {
    name: "Account Manager",
    color: "#9B5CF6",
    slug: "rakazo/account-manager",
    desc: "Готовит ответы и следит за продлениями.",
  },
  {
    name: "Paid Media",
    color: "#3EC5A8",
    slug: "rakazo/paid-media",
    desc: "Проверяет рекламные расходы и сообщает об изменениях.",
  },
  {
    name: "Chief of Staff",
    color: "#8B93A8",
    slug: "rakazo/chief-of-staff",
    desc: "Готовит сводки и координирует ваших ботов.",
  },
];

const TR_ROSTER: RosterBot[] = [
  {
    name: "Sales Outbound",
    color: "#F5A03C",
    slug: "rakazo/sales-outbound",
    desc: "Potansiyel müşterileri araştırır ve takip e-postaları hazırlar.",
  },
  {
    name: "Inbox Manager",
    color: "#6A6BF5",
    slug: "rakazo/inbox-manager",
    desc: "E-postaları düzenler ve yanıt taslakları hazırlar.",
  },
  {
    name: "Talent Scout",
    color: "#3B82F6",
    slug: "rakazo/talent-scout",
    desc: "Başvuruları inceler ve adayları kısa listeye alır.",
  },
  {
    name: "Expense Manager",
    color: "#F2622A",
    slug: "rakazo/expense-manager",
    desc: "Fişleri ödemelerle eşleştirir.",
  },
  {
    name: "Coding Agent",
    color: "#5B6EE1",
    slug: "rakazo/coding-agent",
    desc: "Bilgisayarınızda kod değişiklikleri yapar.",
  },
  {
    name: "Account Manager",
    color: "#9B5CF6",
    slug: "rakazo/account-manager",
    desc: "Yanıtları hazırlar ve yenilemeleri takip eder.",
  },
  {
    name: "Paid Media",
    color: "#3EC5A8",
    slug: "rakazo/paid-media",
    desc: "Reklam harcamalarını inceler ve değişiklikleri raporlar.",
  },
  {
    name: "Chief of Staff",
    color: "#8B93A8",
    slug: "rakazo/chief-of-staff",
    desc: "Brifingler hazırlar ve botlarınızı koordine eder.",
  },
];

const HE_ROSTER: RosterBot[] = [
  {
    name: "Sales Outbound",
    color: "#F5A03C",
    slug: "rakazo/sales-outbound",
    desc: "חוקר לקוחות פוטנציאליים ומנסח הודעות המשך.",
  },
  {
    name: "Inbox Manager",
    color: "#6A6BF5",
    slug: "rakazo/inbox-manager",
    desc: "ממיין אימיילים ומנסח תשובות.",
  },
  {
    name: "Talent Scout",
    color: "#3B82F6",
    slug: "rakazo/talent-scout",
    desc: "בודק מועמדויות ובוחר מועמדים לשלב הבא.",
  },
  {
    name: "Expense Manager",
    color: "#F2622A",
    slug: "rakazo/expense-manager",
    desc: "מתאים קבלות לתשלומים.",
  },
  {
    name: "Coding Agent",
    color: "#5B6EE1",
    slug: "rakazo/coding-agent",
    desc: "מבצע שינויים בקוד במחשב שלך.",
  },
  {
    name: "Account Manager",
    color: "#9B5CF6",
    slug: "rakazo/account-manager",
    desc: "מכין תשובות ועוקב אחרי חידושי חוזים.",
  },
  {
    name: "Paid Media",
    color: "#3EC5A8",
    slug: "rakazo/paid-media",
    desc: "בודק הוצאות פרסום ומדווח על שינויים.",
  },
  {
    name: "Chief of Staff",
    color: "#8B93A8",
    slug: "rakazo/chief-of-staff",
    desc: "מכין תדריכים ומתאם את הבוטים שלך.",
  },
];

const HI_ROSTER: RosterBot[] = [
  {
    name: "Sales Outbound",
    color: "#F5A03C",
    slug: "rakazo/sales-outbound",
    desc: "संभावित ग्राहकों पर रिसर्च करता है और फ़ॉलो-अप ड्राफ़्ट करता है।",
  },
  {
    name: "Inbox Manager",
    color: "#6A6BF5",
    slug: "rakazo/inbox-manager",
    desc: "ईमेल छांटता है और जवाब ड्राफ़्ट करता है।",
  },
  {
    name: "Talent Scout",
    color: "#3B82F6",
    slug: "rakazo/talent-scout",
    desc: "आवेदनों की समीक्षा करता है और उम्मीदवारों को शॉर्टलिस्ट करता है।",
  },
  {
    name: "Expense Manager",
    color: "#F2622A",
    slug: "rakazo/expense-manager",
    desc: "रसीदों का भुगतानों से मिलान करता है।",
  },
  {
    name: "Coding Agent",
    color: "#5B6EE1",
    slug: "rakazo/coding-agent",
    desc: "आपके कंप्यूटर पर कोड में बदलाव करता है।",
  },
  {
    name: "Account Manager",
    color: "#9B5CF6",
    slug: "rakazo/account-manager",
    desc: "जवाब तैयार करता है और रिन्यूअल पर नज़र रखता है।",
  },
  {
    name: "Paid Media",
    color: "#3EC5A8",
    slug: "rakazo/paid-media",
    desc: "विज्ञापन खर्च की समीक्षा करता है और बदलावों की रिपोर्ट देता है।",
  },
  {
    name: "Chief of Staff",
    color: "#8B93A8",
    slug: "rakazo/chief-of-staff",
    desc: "ब्रीफ़िंग तैयार करता है और आपके बॉट्स के बीच तालमेल बिठाता है।",
  },
];

const ZH_TW_ROSTER: RosterBot[] = [
  {
    name: "Sales Outbound",
    color: "#F5A03C",
    slug: "rakazo/sales-outbound",
    desc: "研究潛在客戶，草擬跟進信件。",
  },
  {
    name: "Inbox Manager",
    color: "#6A6BF5",
    slug: "rakazo/inbox-manager",
    desc: "整理郵件，草擬回覆。",
  },
  {
    name: "Talent Scout",
    color: "#3B82F6",
    slug: "rakazo/talent-scout",
    desc: "審閱履歷，篩選候選人。",
  },
  {
    name: "Expense Manager",
    color: "#F2622A",
    slug: "rakazo/expense-manager",
    desc: "比對收據與付款。",
  },
  {
    name: "Coding Agent",
    color: "#5B6EE1",
    slug: "rakazo/coding-agent",
    desc: "在你的電腦上修改程式碼。",
  },
  {
    name: "Account Manager",
    color: "#9B5CF6",
    slug: "rakazo/account-manager",
    desc: "準備回覆，追蹤續約。",
  },
  {
    name: "Paid Media",
    color: "#3EC5A8",
    slug: "rakazo/paid-media",
    desc: "檢視廣告支出，回報變化。",
  },
  {
    name: "Chief of Staff",
    color: "#8B93A8",
    slug: "rakazo/chief-of-staff",
    desc: "準備簡報，協調你的機器人。",
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
    nav: {
      home: "Rakazo home",
      primary: "Primary",
      menu: "Menu",
      docs: "Docs",
      integrations: "Integrations",
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
    channels: {
      heading: "Message them anywhere",
      copy: "Mention a bot in Slack or text it from your phone.",
      mock: { ask: "who needs a follow-up today?", reply: "Three leads went quiet this week. Drafts are in the thread." },
    },
    features: {
      heading: "More than chat",
      items: {
        call: { title: "It calls you", body: "When something needs you, your bot calls you in the app. Talk it through." },
        apps: { title: "Works in your apps", body: "Connect Gmail, GitHub, Notion, and any MCP server." },
        memory: { title: "Remembers", body: "Bots keep what they learn and share it with the team." },
        triggers: { title: "Wakes up on its own", body: "On a schedule, a webhook, a GitHub event, or a change it watches." },
        team: { title: "Hands off work", body: "Bots delegate to each other and work together in groups." },
        teach: { title: "Learns by watching", body: "Show a task once on its computer. It saves the steps as a skill." },
      },
      mock: {
        calling: "Calling…",
        memory: "Memory",
        memoryNotes: ["Prefers short replies", "Acme renews in March"],
        triggers: ["Weekdays at 9:00", "New GitHub issue", "Webhook"],
        recording: "Recording",
        skillSaved: "Saved as a skill",
      },
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
        {
          question: "What does the hosted plan include?",
          answer:
            "Up to 100 computer-hours a month and 5 computers running at once. That is more than enough for most people, and there are no overage charges.",
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
    nav: {
      home: "Rakazo-Startseite",
      primary: "Hauptnavigation",
      menu: "Menü",
      docs: "Docs",
      integrations: "Integrationen",
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
    channels: {
      heading: "Schreib ihnen überall",
      copy: "Erwähne einen Bot in Slack oder schreib ihm vom Handy.",
      mock: { ask: "wer braucht heute ein Follow-up?", reply: "Drei Leads sind diese Woche still geworden. Die Entwürfe sind im Thread." },
    },
    features: {
      heading: "Mehr als Chat",
      items: {
        call: { title: "Er ruft dich an", body: "Wenn etwas dich braucht, ruft dein Bot dich in der App an. Sprecht es durch." },
        apps: { title: "Arbeitet in deinen Apps", body: "Verbinde Gmail, GitHub, Notion und jeden MCP-Server." },
        memory: { title: "Merkt sich Dinge", body: "Bots behalten, was sie lernen, und teilen es mit dem Team." },
        triggers: { title: "Wird von selbst aktiv", body: "Nach Zeitplan, per Webhook, bei GitHub-Events oder wenn sich etwas ändert." },
        team: { title: "Gibt Arbeit ab", body: "Bots delegieren untereinander und arbeiten in Gruppen zusammen." },
        teach: { title: "Lernt durch Zuschauen", body: "Zeig eine Aufgabe einmal auf seinem Computer. Er speichert die Schritte als Skill." },
      },
      mock: {
        calling: "Ruft an…",
        memory: "Gedächtnis",
        memoryNotes: ["Mag kurze Antworten", "Acme verlängert im März"],
        triggers: ["Mo–Fr um 9:00", "Neues GitHub-Issue", "Webhook"],
        recording: "Aufnahme",
        skillSaved: "Als Skill gespeichert",
      },
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
        {
          question: "Was ist im gehosteten Plan enthalten?",
          answer:
            "Bis zu 100 Computerstunden im Monat und 5 gleichzeitig laufende Computer. Das reicht den meisten mehr als aus, und es gibt keine Zusatzkosten.",
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
    nav: {
      home: "Rakazo 홈",
      primary: "주 메뉴",
      menu: "메뉴",
      docs: "Docs",
      integrations: "통합",
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
    channels: {
      heading: "어디서든 메시지하세요",
      copy: "Slack에서 봇을 멘션하거나 휴대폰으로 문자를 보내세요.",
      mock: { ask: "오늘 팔로업할 사람이 누구야?", reply: "이번 주에 연락이 끊긴 리드가 세 명 있어요. 초안은 스레드에 있어요." },
    },
    features: {
      heading: "채팅 그 이상",
      items: {
        call: { title: "먼저 전화해요", body: "당신이 필요할 때 봇이 앱에서 전화를 걸어요. 말로 해결하세요." },
        apps: { title: "쓰던 앱에서 일해요", body: "Gmail, GitHub, Notion, 그리고 모든 MCP 서버를 연결하세요." },
        memory: { title: "기억해요", body: "봇은 배운 것을 기억하고 팀과 공유해요." },
        triggers: { title: "스스로 깨어나요", body: "일정, 웹훅, GitHub 이벤트, 또는 지켜보던 변화에 맞춰 움직여요." },
        team: { title: "일을 넘겨요", body: "봇끼리 일을 맡기고 그룹으로 함께 일해요." },
        teach: { title: "보고 배워요", body: "봇의 컴퓨터에서 한 번 보여 주세요. 그 과정을 스킬로 저장해요." },
      },
      mock: {
        calling: "전화 거는 중…",
        memory: "메모리",
        memoryNotes: ["짧은 답장을 선호함", "Acme 3월 갱신"],
        triggers: ["평일 9:00", "새 GitHub 이슈", "웹훅"],
        recording: "녹화 중",
        skillSaved: "스킬로 저장됨",
      },
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
        {
          question: "호스팅 플랜에는 무엇이 포함되나요?",
          answer:
            "월 최대 100 컴퓨터 시간과 동시에 실행되는 컴퓨터 5대가 포함됩니다. 대부분의 사용자에게 충분하며 초과 요금은 없습니다.",
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
    nav: {
      home: "Rakazo 首页",
      primary: "主导航",
      menu: "菜单",
      docs: "文档",
      integrations: "集成",
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
    channels: {
      heading: "随时随地发消息",
      copy: "在 Slack 里 @ 一个机器人，或用手机给它发短信。",
      mock: { ask: "今天该跟进谁？", reply: "本周有三个潜在客户没回音了。草稿已放在线程里。" },
    },
    features: {
      heading: "不止聊天",
      items: {
        call: { title: "它会给你打电话", body: "需要你的时候，机器人会在应用里给你打电话。当面说清楚。" },
        apps: { title: "在你的应用里工作", body: "连接 Gmail、GitHub、Notion 以及任何 MCP 服务器。" },
        memory: { title: "记得住", body: "机器人会记住学到的东西，并与团队共享。" },
        triggers: { title: "自己醒来", body: "按计划、Webhook、GitHub 事件，或它关注的变化触发。" },
        team: { title: "把工作交出去", body: "机器人之间互相委派，也能在群组里协作。" },
        teach: { title: "看一遍就会", body: "在它的电脑上演示一次任务，它会把步骤存成技能。" },
      },
      mock: {
        calling: "呼叫中…",
        memory: "记忆",
        memoryNotes: ["喜欢简短回复", "Acme 三月续约"],
        triggers: ["工作日 9:00", "新的 GitHub issue", "Webhook"],
        recording: "录制中",
        skillSaved: "已存为技能",
      },
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
        {
          question: "托管套餐包含什么？",
          answer:
            "每月最多 100 个计算机小时，最多同时运行 5 台计算机。对大多数人来说绰绰有余，并且没有超额费用。",
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
    nav: {
      home: "Rakazo ホーム",
      primary: "メインナビゲーション",
      menu: "メニュー",
      docs: "ドキュメント",
      integrations: "連携",
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
    channels: {
      heading: "どこからでもメッセージ",
      copy: "Slack でボットをメンション。スマホからテキストも送れます。",
      mock: { ask: "今日フォローすべき相手は？", reply: "今週返信が止まったリードが3件あります。下書きはスレッドにあります。" },
    },
    features: {
      heading: "チャットだけじゃない",
      items: {
        call: { title: "ボットから電話", body: "あなたが必要なとき、ボットがアプリで電話をかけてきます。話して片付けましょう。" },
        apps: { title: "いつものアプリで", body: "Gmail、GitHub、Notion、あらゆる MCP サーバーとつなげます。" },
        memory: { title: "覚えている", body: "ボットは学んだことを覚え、チームと共有します。" },
        triggers: { title: "自分で動き出す", body: "スケジュール、Webhook、GitHub のイベント、見張っている変化をきっかけに動きます。" },
        team: { title: "仕事を任せ合う", body: "ボット同士で仕事を任せ、グループで協力します。" },
        teach: { title: "見て覚える", body: "ボットのコンピューターで一度やって見せれば、手順をスキルとして保存します。" },
      },
      mock: {
        calling: "発信中…",
        memory: "メモリー",
        memoryNotes: ["短い返信が好み", "Acme は3月に更新"],
        triggers: ["平日 9:00", "新しい GitHub issue", "Webhook"],
        recording: "録画中",
        skillSaved: "スキルとして保存",
      },
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
        {
          question: "ホスト型プランには何が含まれますか？",
          answer:
            "月に最大 100 コンピューター時間、同時に 5 台までのコンピューターを使えます。ほとんどの人には十分で、超過料金はありません。",
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
  "es": {
    title: "Rakazo | Alternativa de código abierto a Grok Bot",
    description:
      "Rakazo es una alternativa de código abierto a Grok Bot para compañeros de IA persistentes que hacen trabajo real. Tus claves, tu modelo, tu máquina.",
    ogImageAlt:
      "Rakazo. Compañeros de IA que de verdad son tuyos. Tus claves, tu modelo, tu máquina.",
    availableLanguage: "Spanish",
    skipToContent: "Saltar al contenido",
    nav: {
      home: "Inicio de Rakazo",
      primary: "Navegación principal",
      menu: "Menú",
      docs: "Documentación",
      integrations: "Integraciones",
      blog: "Blog",
      github: "GitHub",
      getStarted: "Empezar",
    },
    hero: {
      eyebrow: "Código abierto",
      heading: "La alternativa de código abierto a Grok Bot que de verdad es tuya",
      lead: "Dale un trabajo a tus bots. Síguelos desde cualquier dispositivo.",
      getStarted: "Empezar",
      download: {
        mac: "Descargar para macOS",
        windows: "Descargar para Windows",
        linux: "Descargar para Linux",
        ios: "Descargar para iOS",
        android: "Descargar para Android",
      },
      viewOnGithub: "Ver en GitHub",
      setupWithAgent: "Configurar con tu agente",
      copiedForAgent: "Copiado para tu agente",
      copyFailed: "No se pudo copiar. Inténtalo de nuevo.",
    },
    selfHost: {
      heading: "Autoalojado",
      copy: "Tu máquina, tus modelos, tu control.",
      worksWith: "Funciona con",
      mock: { model: "Modelo", weekdays: "Días laborables a las 9:00", approval: "Requiere aprobación", approve: "Aprobar", deny: "Denegar" },
      features: [
        { title: "Tu modelo", body: "Elige un modelo distinto para cada bot." },
        { title: "Trabaja según un horario", body: "Ejecuta tareas recurrentes mientras tu computadora siga encendida." },
        { title: "Tú pones los límites", body: "Decide qué acciones necesitan tu aprobación." },
      ],
    },
    platforms: {
      heading: "Dondequiera que estés",
      web: "Web",
      desktop: "Escritorio",
      mobile: "Móvil",
    },
    roster: {
      eyebrow: "Tu equipo de bots",
      heading: "Dale un trabajo a cada bot",
      copy: "Empieza con una plantilla. Hazla tuya.",
      bots: ES_ROSTER,
    },
    channels: {
      heading: "Escríbeles desde cualquier lugar",
      copy: "Menciona a un bot en Slack o escríbele desde tu teléfono.",
      mock: { ask: "¿quién necesita un seguimiento hoy?", reply: "Tres leads dejaron de responder esta semana. Los borradores están en el hilo." },
    },
    features: {
      heading: "Más que un chat",
      items: {
        call: { title: "Te llama", body: "Cuando algo te necesita, tu bot te llama en la app. Háblalo con él." },
        apps: { title: "Trabaja en tus apps", body: "Conecta Gmail, GitHub, Notion y cualquier servidor MCP." },
        memory: { title: "Recuerda", body: "Los bots guardan lo que aprenden y lo comparten con el equipo." },
        triggers: { title: "Se activa solo", body: "Según un horario, un webhook, un evento de GitHub o un cambio que vigila." },
        team: { title: "Reparte el trabajo", body: "Los bots se delegan tareas entre sí y trabajan juntos en grupos." },
        teach: { title: "Aprende observando", body: "Muéstrale una tarea una vez en su computadora. Guarda los pasos como una habilidad." },
      },
      mock: {
        calling: "Llamando…",
        memory: "Memoria",
        memoryNotes: ["Prefiere respuestas cortas", "Acme renueva en marzo"],
        triggers: ["Días laborables a las 9:00", "Nuevo issue de GitHub", "Webhook"],
        recording: "Grabando",
        skillSaved: "Guardado como habilidad",
      },
    },
    testimonials: {
      heading: "A la gente le encanta",
      pause: "Pausar",
      play: "Reproducir",
      items: TESTIMONIALS,
    },
    faq: {
      heading: "Preguntas frecuentes",
      items: [
        {
          question: "¿Puedo usar mi suscripción a Claude Pro/Max o ChatGPT Plus/Pro?",
          answer:
            "Sí — inicia sesión con esa suscripción, o usa una clave de API, OpenRouter o un servidor local compatible con OpenAI (Ollama, LM Studio, etc.). Rakazo no paga la factura del modelo.",
        },
        {
          question: "¿Necesito una clave de API si ya pago Claude o ChatGPT?",
          answer:
            "No. Inicia sesión con Claude Pro/Max o ChatGPT Plus/Pro y esa suscripción cubre el modelo. Una clave de API es la otra opción, para Anthropic, OpenAI, OpenRouter o Grok. Rakazo no paga en ningún caso.",
        },
        {
          question: "¿Puedo usar un modelo local?",
          answer:
            "Sí. Conecta un bot a un servidor local compatible con OpenAI, como Ollama o LM Studio. Cada bot puede usar un modelo distinto.",
        },
        {
          question: "¿Qué incluye el plan alojado?",
          answer:
            "Hasta 100 horas de computadora al mes y 5 computadoras funcionando a la vez. Es más que suficiente para la mayoría, y no hay cargos por exceso.",
        },
      ],
    },
    openSource: {
      heading: "Código abierto",
      copy: "Apache-2.0. Ejecútalo, modifícalo, hazlo tuyo.",
      starOnGithub: "Dar una estrella en GitHub",
      readTheDocs: "Leer la documentación",
      cloudTitle: "Cloud",
      cloudBadge: "Beta",
    },
    cta: {
      heading: "Conoce a tu primer bot",
      copy: "Delégale tu próxima tarea.",
      openSourceValue: "Código abierto",
      selfHostValue: "Autoalojado",
      stats: [
        { value: "stars", label: "Estrellas en GitHub" },
        { value: "license", label: "Licencia" },
        { value: "openSource", label: "Sin licencias por usuario ni bloqueos" },
        { value: "selfHost", label: "Tu máquina" },
      ],
    },
    footer: {
      navLabel: "Pie de página",
      languagesLabel: "Idioma",
      links: {
        docs: "Documentación",
        product: "Producto",
        changelog: "Novedades",
        alternatives: "Alternativas",
        all: "Todas",
        about: "Acerca de",
        support: "Soporte",
        privacy: "Privacidad",
        terms: "Términos",
        company: "Empresa",
        blog: "Blog",
        iosApp: "App para iPhone",
        androidApp: "App para Android",
      },
    },
  },
  "fr": {
    title: "Rakazo | Alternative open source à Grok Bot",
    description:
      "Rakazo est une alternative open source à Grok Bot pour des coéquipiers IA persistants qui font un vrai travail. Vos clés, votre modèle, votre machine.",
    ogImageAlt:
      "Rakazo. Des coéquipiers IA qui vous appartiennent vraiment. Vos clés, votre modèle, votre machine.",
    availableLanguage: "French",
    skipToContent: "Aller au contenu",
    nav: {
      home: "Accueil Rakazo",
      primary: "Navigation principale",
      menu: "Menu",
      docs: "Documentation",
      integrations: "Intégrations",
      blog: "Blog",
      github: "GitHub",
      getStarted: "Commencer",
    },
    hero: {
      eyebrow: "Open source",
      heading: "L’alternative open source à Grok Bot qui vous appartient vraiment",
      lead: "Confiez une mission à vos bots. Suivez-les depuis n’importe quel appareil.",
      getStarted: "Commencer",
      download: {
        mac: "Télécharger pour macOS",
        windows: "Télécharger pour Windows",
        linux: "Télécharger pour Linux",
        ios: "Télécharger pour iOS",
        android: "Télécharger pour Android",
      },
      viewOnGithub: "Voir sur GitHub",
      setupWithAgent: "Configurer avec votre agent",
      copiedForAgent: "Copié pour votre agent",
      copyFailed: "Échec de la copie. Réessayez.",
    },
    selfHost: {
      heading: "Auto-hébergé",
      copy: "Votre machine, vos modèles, votre contrôle.",
      worksWith: "Fonctionne avec",
      mock: { model: "Modèle", weekdays: "Jours ouvrés à 9:00", approval: "Approbation requise", approve: "Approuver", deny: "Refuser" },
      features: [
        { title: "Votre modèle", body: "Choisissez un modèle différent pour chaque bot." },
        { title: "Travaille selon un planning", body: "Exécutez des tâches récurrentes tant que votre ordinateur reste allumé." },
        { title: "Vous fixez les limites", body: "Décidez quelles actions nécessitent votre approbation." },
      ],
    },
    platforms: {
      heading: "Où que vous soyez",
      web: "Web",
      desktop: "Ordinateur",
      mobile: "Mobile",
    },
    roster: {
      eyebrow: "Votre équipe de bots",
      heading: "Confiez une mission à chaque bot",
      copy: "Partez d’un modèle. Adaptez-le à vos besoins.",
      bots: FR_ROSTER,
    },
    channels: {
      heading: "Écrivez-leur partout",
      copy: "Mentionnez un bot dans Slack ou envoyez-lui un SMS depuis votre téléphone.",
      mock: { ask: "qui a besoin d’une relance aujourd’hui ?", reply: "Trois prospects ne répondent plus cette semaine. Les brouillons sont dans le fil." },
    },
    features: {
      heading: "Plus qu’un chat",
      items: {
        call: { title: "Il vous appelle", body: "Quand quelque chose a besoin de vous, votre bot vous appelle dans l’app. Parlez-en ensemble." },
        apps: { title: "Travaille dans vos apps", body: "Connectez Gmail, GitHub, Notion et n’importe quel serveur MCP." },
        memory: { title: "Se souvient", body: "Les bots retiennent ce qu’ils apprennent et le partagent avec l’équipe." },
        triggers: { title: "Se lance tout seul", body: "Selon un planning, un webhook, un événement GitHub ou un changement qu’il surveille." },
        team: { title: "Passe le relais", body: "Les bots se délèguent des tâches et travaillent ensemble en groupes." },
        teach: { title: "Apprend en observant", body: "Montrez-lui une tâche une fois sur son ordinateur. Il enregistre les étapes comme compétence." },
      },
      mock: {
        calling: "Appel en cours…",
        memory: "Mémoire",
        memoryNotes: ["Préfère les réponses courtes", "Acme renouvelle en mars"],
        triggers: ["Jours ouvrés à 9:00", "Nouvelle issue GitHub", "Webhook"],
        recording: "Enregistrement",
        skillSaved: "Enregistré comme compétence",
      },
    },
    testimonials: {
      heading: "Ils l’adorent",
      pause: "Pause",
      play: "Lecture",
      items: TESTIMONIALS,
    },
    faq: {
      heading: "FAQ",
      items: [
        {
          question: "Puis-je utiliser mon abonnement Claude Pro/Max ou ChatGPT Plus/Pro ?",
          answer:
            "Oui — connectez-vous avec cet abonnement, ou utilisez une clé API, OpenRouter ou un serveur local compatible OpenAI (Ollama, LM Studio, etc.). Rakazo ne paie pas la facture du modèle.",
        },
        {
          question: "Ai-je besoin d’une clé API si je paie déjà Claude ou ChatGPT ?",
          answer:
            "Non. Connectez-vous avec Claude Pro/Max ou ChatGPT Plus/Pro et cet abonnement couvre le modèle. Une clé API est l’autre option, pour Anthropic, OpenAI, OpenRouter ou Grok. Rakazo ne paie dans aucun des cas.",
        },
        {
          question: "Puis-je utiliser un modèle local ?",
          answer:
            "Oui. Reliez un bot à un serveur local compatible OpenAI comme Ollama ou LM Studio. Chaque bot peut utiliser un modèle différent.",
        },
        {
          question: "Que comprend l’offre hébergée ?",
          answer:
            "Jusqu’à 100 heures-ordinateur par mois et 5 ordinateurs en même temps. C’est largement suffisant pour la plupart des gens, et il n’y a aucun frais de dépassement.",
        },
      ],
    },
    openSource: {
      heading: "Open source",
      copy: "Apache-2.0. Exécutez-le, modifiez-le, appropriez-le-vous.",
      starOnGithub: "Ajouter une étoile sur GitHub",
      readTheDocs: "Lire la documentation",
      cloudTitle: "Cloud",
      cloudBadge: "Bêta",
    },
    cta: {
      heading: "Rencontrez votre premier bot",
      copy: "Confiez-lui votre prochaine tâche.",
      openSourceValue: "Open source",
      selfHostValue: "Auto-hébergé",
      stats: [
        { value: "stars", label: "Étoiles GitHub" },
        { value: "license", label: "Licence" },
        { value: "openSource", label: "Ni licences par siège, ni restrictions" },
        { value: "selfHost", label: "Votre machine" },
      ],
    },
    footer: {
      navLabel: "Pied de page",
      languagesLabel: "Langue",
      links: {
        docs: "Documentation",
        product: "Produit",
        changelog: "Nouveautés",
        alternatives: "Alternatives",
        all: "Toutes",
        about: "À propos",
        support: "Support",
        privacy: "Confidentialité",
        terms: "Conditions",
        company: "Entreprise",
        blog: "Blog",
        iosApp: "App iPhone",
        androidApp: "App Android",
      },
    },
  },
  "pt-br": {
    title: "Rakazo | Alternativa de código aberto ao Grok Bot",
    description:
      "Rakazo é uma alternativa de código aberto ao Grok Bot para colegas de IA persistentes que fazem trabalho de verdade. Suas chaves, seu modelo, sua máquina.",
    ogImageAlt:
      "Rakazo. Colegas de IA que são realmente seus. Suas chaves, seu modelo, sua máquina.",
    availableLanguage: "Portuguese",
    skipToContent: "Pular para o conteúdo",
    nav: {
      home: "Página inicial do Rakazo",
      primary: "Navegação principal",
      menu: "Menu",
      docs: "Documentação",
      integrations: "Integrações",
      blog: "Blog",
      github: "GitHub",
      getStarted: "Começar",
    },
    hero: {
      eyebrow: "Código aberto",
      heading: "A alternativa de código aberto ao Grok Bot que é realmente sua",
      lead: "Dê um trabalho aos seus bots. Acompanhe de qualquer dispositivo.",
      getStarted: "Começar",
      download: {
        mac: "Baixar para macOS",
        windows: "Baixar para Windows",
        linux: "Baixar para Linux",
        ios: "Baixar para iOS",
        android: "Baixar para Android",
      },
      viewOnGithub: "Ver no GitHub",
      setupWithAgent: "Configurar com seu agente",
      copiedForAgent: "Copiado para seu agente",
      copyFailed: "Falha ao copiar. Tente novamente.",
    },
    selfHost: {
      heading: "Auto-hospedado",
      copy: "Sua máquina, seus modelos, seu controle.",
      worksWith: "Funciona com",
      mock: { model: "Modelo", weekdays: "Dias úteis às 9:00", approval: "Aprovação necessária", approve: "Aprovar", deny: "Negar" },
      features: [
        { title: "Seu modelo", body: "Escolha um modelo diferente para cada bot." },
        { title: "Trabalha com agendamento", body: "Execute tarefas recorrentes enquanto seu computador estiver ligado." },
        { title: "Você define os limites", body: "Decida quais ações precisam da sua aprovação." },
      ],
    },
    platforms: {
      heading: "Onde você estiver",
      web: "Web",
      desktop: "Desktop",
      mobile: "Celular",
    },
    roster: {
      eyebrow: "Sua equipe de bots",
      heading: "Dê um trabalho a cada bot",
      copy: "Comece com um template. Deixe do seu jeito.",
      bots: PT_BR_ROSTER,
    },
    channels: {
      heading: "Fale com eles em qualquer lugar",
      copy: "Mencione um bot no Slack ou mande uma mensagem pelo celular.",
      mock: { ask: "quem precisa de um follow-up hoje?", reply: "Três leads sumiram esta semana. Os rascunhos estão na conversa." },
    },
    features: {
      heading: "Mais que um chat",
      items: {
        call: { title: "Ele liga para você", body: "Quando algo precisa de você, seu bot liga para você no app. Converse com ele." },
        apps: { title: "Funciona nos seus apps", body: "Conecte Gmail, GitHub, Notion e qualquer servidor MCP." },
        memory: { title: "Lembra", body: "Os bots guardam o que aprendem e compartilham com a equipe." },
        triggers: { title: "Entra em ação sozinho", body: "Por agendamento, webhook, evento do GitHub ou uma mudança que ele monitora." },
        team: { title: "Divide o trabalho", body: "Os bots delegam tarefas entre si e trabalham juntos em grupos." },
        teach: { title: "Aprende observando", body: "Mostre uma tarefa uma vez no computador dele. Ele salva os passos como uma habilidade." },
      },
      mock: {
        calling: "Ligando…",
        memory: "Memória",
        memoryNotes: ["Prefere respostas curtas", "Acme renova em março"],
        triggers: ["Dias úteis às 9:00", "Nova issue no GitHub", "Webhook"],
        recording: "Gravando",
        skillSaved: "Salvo como habilidade",
      },
    },
    testimonials: {
      heading: "As pessoas adoram",
      pause: "Pausar",
      play: "Reproduzir",
      items: TESTIMONIALS,
    },
    faq: {
      heading: "Perguntas frequentes",
      items: [
        {
          question: "Posso usar minha assinatura do Claude Pro/Max ou ChatGPT Plus/Pro?",
          answer:
            "Sim — entre com essa assinatura, ou use uma chave de API, OpenRouter ou um servidor local compatível com OpenAI (Ollama, LM Studio etc.). O Rakazo não paga a conta do modelo.",
        },
        {
          question: "Preciso de uma chave de API se já pago pelo Claude ou ChatGPT?",
          answer:
            "Não. Entre com Claude Pro/Max ou ChatGPT Plus/Pro e essa assinatura cobre o modelo. A chave de API é o outro caminho, para Anthropic, OpenAI, OpenRouter ou Grok. O Rakazo não paga em nenhum dos casos.",
        },
        {
          question: "Posso usar um modelo local?",
          answer:
            "Sim. Aponte um bot para um servidor local compatível com OpenAI, como Ollama ou LM Studio. Cada bot pode usar um modelo diferente.",
        },
        {
          question: "O que o plano hospedado inclui?",
          answer:
            "Até 100 horas de computador por mês e 5 computadores rodando ao mesmo tempo. É mais que suficiente para a maioria das pessoas, e não há cobrança por excedente.",
        },
      ],
    },
    openSource: {
      heading: "Código aberto",
      copy: "Apache-2.0. Rode, modifique, deixe do seu jeito.",
      starOnGithub: "Dar estrela no GitHub",
      readTheDocs: "Ler a documentação",
      cloudTitle: "Cloud",
      cloudBadge: "Beta",
    },
    cta: {
      heading: "Conheça seu primeiro bot",
      copy: "Entregue sua próxima tarefa.",
      openSourceValue: "Código aberto",
      selfHostValue: "Auto-hospedado",
      stats: [
        { value: "stars", label: "Estrelas no GitHub" },
        { value: "license", label: "Licença" },
        { value: "openSource", label: "Sem licenças por usuário, sem bloqueios" },
        { value: "selfHost", label: "Sua máquina" },
      ],
    },
    footer: {
      navLabel: "Rodapé",
      languagesLabel: "Idioma",
      links: {
        docs: "Documentação",
        product: "Produto",
        changelog: "Novidades",
        alternatives: "Alternativas",
        all: "Todas",
        about: "Sobre",
        support: "Suporte",
        privacy: "Privacidade",
        terms: "Termos",
        company: "Empresa",
        blog: "Blog",
        iosApp: "App para iPhone",
        androidApp: "App para Android",
      },
    },
  },
  "nl": {
    title: "Rakazo | Open source alternatief voor Grok Bot",
    description:
      "Rakazo is een open source alternatief voor Grok Bot voor blijvende AI-teamgenoten die echt werk doen. Jouw keys, jouw model, jouw machine.",
    ogImageAlt:
      "Rakazo. AI-teamgenoten die echt van jou zijn. Jouw keys, jouw model, jouw machine.",
    availableLanguage: "Dutch",
    skipToContent: "Naar inhoud springen",
    nav: {
      home: "Rakazo-startpagina",
      primary: "Hoofdnavigatie",
      menu: "Menu",
      docs: "Docs",
      integrations: "Integraties",
      blog: "Blog",
      github: "GitHub",
      getStarted: "Aan de slag",
    },
    hero: {
      eyebrow: "Open source",
      heading: "Het open source alternatief voor Grok Bot dat echt van jou is",
      lead: "Geef je bots een taak. Kijk mee vanaf elk apparaat.",
      getStarted: "Aan de slag",
      download: {
        mac: "Downloaden voor macOS",
        windows: "Downloaden voor Windows",
        linux: "Downloaden voor Linux",
        ios: "Downloaden voor iOS",
        android: "Downloaden voor Android",
      },
      viewOnGithub: "Bekijken op GitHub",
      setupWithAgent: "Instellen met je agent",
      copiedForAgent: "Gekopieerd voor je agent",
      copyFailed: "Kopiëren mislukt. Probeer het opnieuw.",
    },
    selfHost: {
      heading: "Zelf gehost",
      copy: "Jouw machine, jouw modellen, jouw controle.",
      worksWith: "Werkt met",
      mock: { model: "Model", weekdays: "Werkdagen om 9:00", approval: "Goedkeuring vereist", approve: "Goedkeuren", deny: "Weigeren" },
      features: [
        { title: "Jouw model", body: "Kies voor elke bot een ander model." },
        { title: "Werkt volgens schema", body: "Terugkerende taken draaien zolang je computer aanstaat." },
        { title: "Jij bepaalt de grenzen", body: "Bepaal welke acties jouw goedkeuring nodig hebben." },
      ],
    },
    platforms: {
      heading: "Waar je ook bent",
      web: "Web",
      desktop: "Desktop",
      mobile: "Mobiel",
    },
    roster: {
      eyebrow: "Je botteam",
      heading: "Geef elke bot een taak",
      copy: "Begin met een sjabloon. Maak het je eigen.",
      bots: NL_ROSTER,
    },
    channels: {
      heading: "Stuur ze overal een bericht",
      copy: "Noem een bot in Slack of stuur hem een bericht vanaf je telefoon.",
      mock: { ask: "wie heeft vandaag een follow-up nodig?", reply: "Drie leads zijn deze week stil geworden. De concepten staan in de thread." },
    },
    features: {
      heading: "Meer dan chat",
      items: {
        call: { title: "Hij belt je", body: "Als iets jou nodig heeft, belt je bot je in de app. Bespreek het samen." },
        apps: { title: "Werkt in je apps", body: "Koppel Gmail, GitHub, Notion en elke MCP-server." },
        memory: { title: "Onthoudt", body: "Bots bewaren wat ze leren en delen het met het team." },
        triggers: { title: "Komt zelf in actie", body: "Volgens schema, via een webhook, bij een GitHub-event of bij een wijziging die hij in de gaten houdt." },
        team: { title: "Draagt werk over", body: "Bots delegeren aan elkaar en werken samen in groepen." },
        teach: { title: "Leert door te kijken", body: "Doe een taak één keer voor op zijn computer. Hij slaat de stappen op als skill." },
      },
      mock: {
        calling: "Belt…",
        memory: "Geheugen",
        memoryNotes: ["Houdt van korte antwoorden", "Acme verlengt in maart"],
        triggers: ["Werkdagen om 9:00", "Nieuw GitHub-issue", "Webhook"],
        recording: "Opname",
        skillSaved: "Opgeslagen als skill",
      },
    },
    testimonials: {
      heading: "Mensen zijn er dol op",
      pause: "Pauzeren",
      play: "Afspelen",
      items: TESTIMONIALS,
    },
    faq: {
      heading: "FAQ",
      items: [
        {
          question: "Kan ik mijn Claude Pro/Max- of ChatGPT Plus/Pro-abonnement gebruiken?",
          answer:
            "Ja — log in met dat abonnement, of gebruik een API-key, OpenRouter of een lokale OpenAI-compatibele server (Ollama, LM Studio enz.). Rakazo betaalt de modelrekening niet.",
        },
        {
          question: "Heb ik een API-key nodig als ik al voor Claude of ChatGPT betaal?",
          answer:
            "Nee. Log in met Claude Pro/Max of ChatGPT Plus/Pro en dat abonnement dekt het model. Een API-key is de andere route, voor Anthropic, OpenAI, OpenRouter of Grok. Rakazo betaalt in geen van beide gevallen.",
        },
        {
          question: "Kan ik een lokaal model draaien?",
          answer:
            "Ja. Laat een bot naar een lokale OpenAI-compatibele server wijzen, zoals Ollama of LM Studio. Elke bot kan een ander model gebruiken.",
        },
        {
          question: "Wat zit er in het gehoste abonnement?",
          answer:
            "Tot 100 computeruren per maand en 5 computers tegelijk. Dat is voor de meeste mensen ruim voldoende, en er zijn geen extra kosten bij overschrijding.",
        },
      ],
    },
    openSource: {
      heading: "Open source",
      copy: "Apache-2.0. Draai het, pas het aan, maak het je eigen.",
      starOnGithub: "Ster geven op GitHub",
      readTheDocs: "Lees de docs",
      cloudTitle: "Cloud",
      cloudBadge: "Bèta",
    },
    cta: {
      heading: "Maak kennis met je eerste bot",
      copy: "Draag je volgende taak over.",
      openSourceValue: "Open source",
      selfHostValue: "Zelf hosten",
      stats: [
        { value: "stars", label: "GitHub-sterren" },
        { value: "license", label: "Licentie" },
        { value: "openSource", label: "Geen seats, geen drempels" },
        { value: "selfHost", label: "Jouw machine" },
      ],
    },
    footer: {
      navLabel: "Voettekst",
      languagesLabel: "Taal",
      links: {
        docs: "Documentatie",
        product: "Product",
        changelog: "Wijzigingslog",
        alternatives: "Alternatieven",
        all: "Alle",
        about: "Over ons",
        support: "Support",
        privacy: "Privacy",
        terms: "Voorwaarden",
        company: "Bedrijf",
        blog: "Blog",
        iosApp: "iPhone-app",
        androidApp: "Android-app",
      },
    },
  },
  "ru": {
    title: "Rakazo | Альтернатива Grok Bot с открытым исходным кодом",
    description:
      "Rakazo — альтернатива Grok Bot с открытым исходным кодом: постоянные ИИ-коллеги, которые выполняют реальную работу. Ваши ключи, ваша модель, ваш компьютер.",
    ogImageAlt:
      "Rakazo. ИИ-коллеги, которые действительно принадлежат вам. Ваши ключи, ваша модель, ваш компьютер.",
    availableLanguage: "Russian",
    skipToContent: "Перейти к содержимому",
    nav: {
      home: "Главная Rakazo",
      primary: "Основная навигация",
      menu: "Меню",
      docs: "Документация",
      integrations: "Интеграции",
      blog: "Блог",
      github: "GitHub",
      getStarted: "Начать",
    },
    hero: {
      eyebrow: "Открытый исходный код",
      heading: "Альтернатива Grok Bot с открытым исходным кодом, которая действительно ваша",
      lead: "Дайте ботам работу. Следите за ней с любого устройства.",
      getStarted: "Начать",
      download: {
        mac: "Скачать для macOS",
        windows: "Скачать для Windows",
        linux: "Скачать для Linux",
        ios: "Скачать для iOS",
        android: "Скачать для Android",
      },
      viewOnGithub: "Открыть на GitHub",
      setupWithAgent: "Настроить с помощью агента",
      copiedForAgent: "Скопировано для агента",
      copyFailed: "Не удалось скопировать. Попробуйте ещё раз.",
    },
    selfHost: {
      heading: "На своём сервере",
      copy: "Ваш компьютер, ваши модели, ваш контроль.",
      worksWith: "Работает с",
      mock: { model: "Модель", weekdays: "По будням в 9:00", approval: "Требуется одобрение", approve: "Утвердить", deny: "Запретить" },
      features: [
        { title: "Ваша модель", body: "Выберите свою модель для каждого бота." },
        { title: "Работа по расписанию", body: "Повторяющиеся задачи выполняются, пока ваш компьютер включён." },
        { title: "Границы задаёте вы", body: "Решайте, какие действия требуют вашего одобрения." },
      ],
    },
    platforms: {
      heading: "Где бы вы ни были",
      web: "Веб",
      desktop: "Компьютер",
      mobile: "Телефон",
    },
    roster: {
      eyebrow: "Ваша команда ботов",
      heading: "Дайте каждому боту работу",
      copy: "Начните с шаблона. Настройте под себя.",
      bots: RU_ROSTER,
    },
    channels: {
      heading: "Пишите им где угодно",
      copy: "Упомяните бота в Slack или напишите ему с телефона.",
      mock: { ask: "кому сегодня нужно напомнить о себе?", reply: "Три лида замолчали на этой неделе. Черновики в треде." },
    },
    features: {
      heading: "Больше, чем чат",
      items: {
        call: { title: "Он вам звонит", body: "Когда нужно ваше участие, бот звонит вам в приложении. Обсудите всё голосом." },
        apps: { title: "Работает в ваших приложениях", body: "Подключите Gmail, GitHub, Notion и любой MCP-сервер." },
        memory: { title: "Помнит", body: "Боты сохраняют то, что узнали, и делятся этим с командой." },
        triggers: { title: "Запускается сам", body: "По расписанию, по вебхуку, по событию GitHub или при изменении, за которым он следит." },
        team: { title: "Передаёт работу", body: "Боты поручают задачи друг другу и работают вместе в группах." },
        teach: { title: "Учится, наблюдая", body: "Покажите задачу один раз на его компьютере. Он сохранит шаги как навык." },
      },
      mock: {
        calling: "Вызов…",
        memory: "Память",
        memoryNotes: ["Предпочитает короткие ответы", "Acme продлевает в марте"],
        triggers: ["По будням в 9:00", "Новый issue в GitHub", "Вебхук"],
        recording: "Запись",
        skillSaved: "Сохранено как навык",
      },
    },
    testimonials: {
      heading: "Людям нравится",
      pause: "Пауза",
      play: "Воспроизвести",
      items: TESTIMONIALS,
    },
    faq: {
      heading: "Частые вопросы",
      items: [
        {
          question: "Можно ли использовать подписку Claude Pro/Max или ChatGPT Plus/Pro?",
          answer:
            "Да — войдите с этой подпиской или используйте API-ключ, OpenRouter или локальный OpenAI-совместимый сервер (Ollama, LM Studio и т. д.). Rakazo не оплачивает счёт за модель.",
        },
        {
          question: "Нужен ли API-ключ, если я уже плачу за Claude или ChatGPT?",
          answer:
            "Нет. Войдите с Claude Pro/Max или ChatGPT Plus/Pro, и эта подписка покроет модель. API-ключ — другой путь: для Anthropic, OpenAI, OpenRouter или Grok. В любом случае Rakazo не платит.",
        },
        {
          question: "Можно ли запустить локальную модель?",
          answer:
            "Да. Направьте бота на локальный OpenAI-совместимый сервер, например Ollama или LM Studio. Каждый бот может использовать свою модель.",
        },
        {
          question: "Что входит в облачный тариф?",
          answer:
            "До 100 компьютеро-часов в месяц и до 5 компьютеров одновременно. Большинству этого более чем достаточно, и платы за превышение нет.",
        },
      ],
    },
    openSource: {
      heading: "Открытый исходный код",
      copy: "Apache-2.0. Запускайте, меняйте, настраивайте под себя.",
      starOnGithub: "Поставить звезду на GitHub",
      readTheDocs: "Читать документацию",
      cloudTitle: "Облако",
      cloudBadge: "Бета",
    },
    cta: {
      heading: "Познакомьтесь с первым ботом",
      copy: "Передайте ему следующую задачу.",
      openSourceValue: "Открытый код",
      selfHostValue: "Свой сервер",
      stats: [
        { value: "stars", label: "Звёзды на GitHub" },
        { value: "license", label: "Лицензия" },
        { value: "openSource", label: "Без платы за места, без ограничений" },
        { value: "selfHost", label: "Ваш компьютер" },
      ],
    },
    footer: {
      navLabel: "Нижнее меню",
      languagesLabel: "Язык",
      links: {
        docs: "Документация",
        product: "Продукт",
        changelog: "Журнал изменений",
        alternatives: "Альтернативы",
        all: "Все",
        about: "О нас",
        support: "Поддержка",
        privacy: "Конфиденциальность",
        terms: "Условия",
        company: "Компания",
        blog: "Блог",
        iosApp: "Приложение для iPhone",
        androidApp: "Приложение для Android",
      },
    },
  },
  "tr": {
    title: "Rakazo | Açık kaynaklı Grok Bot alternatifi",
    description:
      "Rakazo, gerçek işler yapan kalıcı yapay zekâ ekip arkadaşları için açık kaynaklı bir Grok Bot alternatifidir. Sizin anahtarlarınız, sizin modeliniz, sizin makineniz.",
    ogImageAlt:
      "Rakazo. Gerçekten size ait yapay zekâ ekip arkadaşları. Sizin anahtarlarınız, sizin modeliniz, sizin makineniz.",
    availableLanguage: "Turkish",
    skipToContent: "İçeriğe geç",
    nav: {
      home: "Rakazo ana sayfa",
      primary: "Ana menü",
      menu: "Menü",
      docs: "Belgeler",
      integrations: "Entegrasyonlar",
      blog: "Blog",
      github: "GitHub",
      getStarted: "Başlayın",
    },
    hero: {
      eyebrow: "Açık kaynak",
      heading: "Gerçekten size ait, açık kaynaklı Grok Bot alternatifi",
      lead: "Botlarınıza bir iş verin. Her cihazdan takip edin.",
      getStarted: "Başlayın",
      download: {
        mac: "macOS için indir",
        windows: "Windows için indir",
        linux: "Linux için indir",
        ios: "iOS için indir",
        android: "Android için indir",
      },
      viewOnGithub: "GitHub'da görüntüle",
      setupWithAgent: "Ajanınızla kurun",
      copiedForAgent: "Ajanınız için kopyalandı",
      copyFailed: "Kopyalanamadı. Tekrar deneyin.",
    },
    selfHost: {
      heading: "Kendi sunucunuzda",
      copy: "Sizin makineniz, sizin modelleriniz, sizin kontrolünüz.",
      worksWith: "Şunlarla çalışır",
      mock: { model: "Model", weekdays: "Hafta içi 9:00'da", approval: "Onay gerekli", approve: "Onayla", deny: "Reddet" },
      features: [
        { title: "Sizin modeliniz", body: "Her bot için farklı bir model seçin." },
        { title: "Zamanlanmış çalışma", body: "Bilgisayarınız açık kaldığı sürece tekrarlanan görevleri çalıştırın." },
        { title: "Sınırları siz belirlersiniz", body: "Hangi işlemlerin onayınızı gerektirdiğine karar verin." },
      ],
    },
    platforms: {
      heading: "Nerede olursanız olun",
      web: "Web",
      desktop: "Masaüstü",
      mobile: "Mobil",
    },
    roster: {
      eyebrow: "Bot ekibiniz",
      heading: "Her bota bir iş verin",
      copy: "Bir şablonla başlayın. Size göre uyarlayın.",
      bots: TR_ROSTER,
    },
    channels: {
      heading: "Onlara her yerden yazın",
      copy: "Slack'te bir botu etiketleyin veya telefonunuzdan mesaj atın.",
      mock: { ask: "bugün kimin takibe ihtiyacı var?", reply: "Bu hafta üç potansiyel müşteriden ses çıkmadı. Taslaklar başlıkta." },
    },
    features: {
      heading: "Sohbetten fazlası",
      items: {
        call: { title: "Sizi arar", body: "Size ihtiyaç duyulduğunda botunuz sizi uygulamada arar. Konuşarak halledin." },
        apps: { title: "Uygulamalarınızda çalışır", body: "Gmail, GitHub, Notion ve herhangi bir MCP sunucusunu bağlayın." },
        memory: { title: "Hatırlar", body: "Botlar öğrendiklerini saklar ve ekiple paylaşır." },
        triggers: { title: "Kendiliğinden devreye girer", body: "Bir zamanlamayla, bir webhook ile, bir GitHub olayıyla veya izlediği bir değişiklikle." },
        team: { title: "İşi devreder", body: "Botlar birbirine görev verir ve gruplar halinde birlikte çalışır." },
        teach: { title: "İzleyerek öğrenir", body: "Bir görevi kendi bilgisayarında bir kez gösterin. Adımları beceri olarak kaydeder." },
      },
      mock: {
        calling: "Aranıyor…",
        memory: "Hafıza",
        memoryNotes: ["Kısa yanıtları tercih eder", "Acme mart ayında yeniliyor"],
        triggers: ["Hafta içi 9:00'da", "Yeni GitHub issue'su", "Webhook"],
        recording: "Kaydediliyor",
        skillSaved: "Beceri olarak kaydedildi",
      },
    },
    testimonials: {
      heading: "Kullanıcılar bayılıyor",
      pause: "Duraklat",
      play: "Oynat",
      items: TESTIMONIALS,
    },
    faq: {
      heading: "SSS",
      items: [
        {
          question: "Claude Pro/Max veya ChatGPT Plus/Pro aboneliğimi kullanabilir miyim?",
          answer:
            "Evet — bu abonelikle giriş yapın ya da bir API anahtarı, OpenRouter veya yerel bir OpenAI uyumlu sunucu (Ollama, LM Studio vb.) kullanın. Model faturasını Rakazo ödemez.",
        },
        {
          question: "Claude veya ChatGPT için zaten ödeme yapıyorsam API anahtarına ihtiyacım var mı?",
          answer:
            "Hayır. Claude Pro/Max veya ChatGPT Plus/Pro ile giriş yapın; model bu abonelikle karşılanır. Diğer yol Anthropic, OpenAI, OpenRouter veya Grok için bir API anahtarıdır. Her iki durumda da Rakazo ödeme yapmaz.",
        },
        {
          question: "Yerel bir model çalıştırabilir miyim?",
          answer:
            "Evet. Bir botu Ollama veya LM Studio gibi yerel bir OpenAI uyumlu sunucuya yönlendirin. Her bot farklı bir model kullanabilir.",
        },
        {
          question: "Barındırılan plana neler dahil?",
          answer:
            "Ayda 100 bilgisayar saatine kadar kullanım ve aynı anda çalışan 5 bilgisayar. Bu çoğu kişi için fazlasıyla yeterli ve aşım ücreti yok.",
        },
      ],
    },
    openSource: {
      heading: "Açık kaynak",
      copy: "Apache-2.0. Çalıştırın, değiştirin, size göre uyarlayın.",
      starOnGithub: "GitHub'da yıldız verin",
      readTheDocs: "Belgeleri okuyun",
      cloudTitle: "Bulut",
      cloudBadge: "Beta",
    },
    cta: {
      heading: "İlk botunuzla tanışın",
      copy: "Sıradaki görevinizi devredin.",
      openSourceValue: "Açık kaynak",
      selfHostValue: "Kendi sunucunuz",
      stats: [
        { value: "stars", label: "GitHub yıldızı" },
        { value: "license", label: "Lisans" },
        { value: "openSource", label: "Kullanıcı başı ücret yok, kısıtlama yok" },
        { value: "selfHost", label: "Sizin makineniz" },
      ],
    },
    footer: {
      navLabel: "Alt bilgi",
      languagesLabel: "Dil",
      links: {
        docs: "Belgeler",
        product: "Ürün",
        changelog: "Değişiklik günlüğü",
        alternatives: "Alternatifler",
        all: "Tümü",
        about: "Hakkımızda",
        support: "Destek",
        privacy: "Gizlilik",
        terms: "Koşullar",
        company: "Şirket",
        blog: "Blog",
        iosApp: "iPhone uygulaması",
        androidApp: "Android uygulaması",
      },
    },
  },
  "he": {
    title: "Rakazo | חלופת קוד פתוח ל-Grok Bot",
    description:
      "Rakazo היא חלופת קוד פתוח ל-Grok Bot לעמיתי AI קבועים שעושים עבודה אמיתית. המפתחות שלך, המודל שלך, המכונה שלך.",
    ogImageAlt:
      "Rakazo. עמיתי AI ששייכים לך באמת. המפתחות שלך, המודל שלך, המכונה שלך.",
    availableLanguage: "Hebrew",
    skipToContent: "דילוג לתוכן",
    nav: {
      home: "דף הבית של Rakazo",
      primary: "ניווט ראשי",
      menu: "תפריט",
      docs: "תיעוד",
      integrations: "אינטגרציות",
      blog: "בלוג",
      github: "GitHub",
      getStarted: "להתחיל",
    },
    hero: {
      eyebrow: "קוד פתוח",
      heading: "חלופת הקוד הפתוח ל-Grok Bot ששייכת לך באמת",
      lead: "נותנים לבוטים משימה. מתעדכנים מכל מכשיר.",
      getStarted: "להתחיל",
      download: {
        mac: "הורדה ל-macOS",
        windows: "הורדה ל-Windows",
        linux: "הורדה ל-Linux",
        ios: "הורדה ל-iOS",
        android: "הורדה ל-Android",
      },
      viewOnGithub: "צפייה ב-GitHub",
      setupWithAgent: "הגדרה עם הסוכן שלך",
      copiedForAgent: "הועתק עבור הסוכן שלך",
      copyFailed: "ההעתקה נכשלה. אפשר לנסות שוב.",
    },
    selfHost: {
      heading: "באירוח עצמי",
      copy: "המכונה שלך, המודלים שלך, השליטה שלך.",
      worksWith: "עובד עם",
      mock: { model: "מודל", weekdays: "שני עד שישי ב-9:00", approval: "נדרש אישור", approve: "אישור", deny: "דחייה" },
      features: [
        { title: "המודל שלך", body: "אפשר לבחור מודל אחר לכל בוט." },
        { title: "עבודה לפי לוח זמנים", body: "משימות חוזרות רצות כל עוד המחשב שלך דולק." },
        { title: "הגבולות בידיים שלך", body: "קובעים אילו פעולות דורשות את האישור שלך." },
      ],
    },
    platforms: {
      heading: "בכל מקום",
      web: "ווב",
      desktop: "דסקטופ",
      mobile: "מובייל",
    },
    roster: {
      eyebrow: "צוות הבוטים שלך",
      heading: "לכל בוט תפקיד משלו",
      copy: "מתחילים מתבנית ומתאימים אותה.",
      bots: HE_ROSTER,
    },
    channels: {
      heading: "שולחים להם הודעה מכל מקום",
      copy: "מתייגים בוט ב-Slack או שולחים לו הודעה מהטלפון.",
      mock: { ask: "למי צריך לחזור היום?", reply: "שלושה לידים השתתקו השבוע. הטיוטות בשרשור." },
    },
    features: {
      heading: "יותר מצ'אט",
      items: {
        call: { title: "הוא מתקשר אליך", body: "כשמשהו צריך אותך, הבוט מתקשר אליך באפליקציה. מדברים על זה." },
        apps: { title: "עובד באפליקציות שלך", body: "אפשר לחבר את Gmail, GitHub, Notion וכל שרת MCP." },
        memory: { title: "זוכר", body: "הבוטים שומרים את מה שהם לומדים ומשתפים את זה עם הצוות." },
        triggers: { title: "מתעורר מעצמו", body: "לפי לוח זמנים, דרך Webhook, באירוע GitHub או כשמשהו שהוא עוקב אחריו משתנה." },
        team: { title: "מעביר עבודה הלאה", body: "הבוטים מאצילים משימות זה לזה ועובדים יחד בקבוצות." },
        teach: { title: "לומד מצפייה", body: "מראים לו משימה פעם אחת במחשב שלו. הוא שומר את השלבים כמיומנות." },
      },
      mock: {
        calling: "מתקשר…",
        memory: "זיכרון",
        memoryNotes: ["מעדיף תשובות קצרות", "Acme מחדשת במרץ"],
        triggers: ["שני עד שישי ב-9:00", "Issue חדש ב-GitHub", "Webhook"],
        recording: "מקליט",
        skillSaved: "נשמר כמיומנות",
      },
    },
    testimonials: {
      heading: "אנשים אוהבים את זה",
      pause: "השהיה",
      play: "הפעלה",
      items: TESTIMONIALS,
    },
    faq: {
      heading: "שאלות נפוצות",
      items: [
        {
          question: "אפשר להשתמש במנוי Claude Pro/Max או ChatGPT Plus/Pro שלי?",
          answer:
            "כן — אפשר להתחבר עם המנוי הזה, או להשתמש במפתח API, ב-OpenRouter או בשרת מקומי תואם OpenAI (Ollama, LM Studio וכו'). Rakazo לא משלמת את חשבון המודל.",
        },
        {
          question: "צריך מפתח API אם כבר יש לי מנוי בתשלום ל-Claude או ל-ChatGPT?",
          answer:
            "לא. מתחברים עם Claude Pro/Max או ChatGPT Plus/Pro, והמנוי הזה מכסה את המודל. מפתח API הוא הדרך השנייה, עבור Anthropic, OpenAI, OpenRouter או Grok. בכל מקרה, Rakazo לא משלמת.",
        },
        {
          question: "אפשר להריץ מודל מקומי?",
          answer:
            "כן. מכוונים בוט לשרת מקומי תואם OpenAI כמו Ollama או LM Studio. כל בוט יכול להשתמש במודל אחר.",
        },
        {
          question: "מה כולל המסלול המנוהל?",
          answer:
            "עד 100 שעות מחשב בחודש ו-5 מחשבים שרצים במקביל. זה יותר ממספיק לרוב האנשים, ואין חיובים על חריגה.",
        },
      ],
    },
    openSource: {
      heading: "קוד פתוח",
      copy: "Apache-2.0. אפשר להריץ, לשנות ולהתאים לעצמך.",
      starOnGithub: "סימון בכוכב ב-GitHub",
      readTheDocs: "לקריאת התיעוד",
      cloudTitle: "ענן",
      cloudBadge: "בטא",
    },
    cta: {
      heading: "הכירו את הבוט הראשון שלכם",
      copy: "העבירו לו את המשימה הבאה.",
      openSourceValue: "קוד פתוח",
      selfHostValue: "אירוח עצמי",
      stats: [
        { value: "stars", label: "כוכבים ב-GitHub" },
        { value: "license", label: "רישיון" },
        { value: "openSource", label: "בלי מושבים, בלי חסימות" },
        { value: "selfHost", label: "המכונה שלך" },
      ],
    },
    footer: {
      navLabel: "כותרת תחתונה",
      languagesLabel: "שפה",
      links: {
        docs: "תיעוד",
        product: "מוצר",
        changelog: "יומן שינויים",
        alternatives: "חלופות",
        all: "הכול",
        about: "אודות",
        support: "תמיכה",
        privacy: "פרטיות",
        terms: "תנאים",
        company: "חברה",
        blog: "בלוג",
        iosApp: "אפליקציית iPhone",
        androidApp: "אפליקציית Android",
      },
    },
  },
  "hi": {
    title: "Rakazo | Grok Bot का ओपन सोर्स विकल्प",
    description:
      "Rakazo, Grok Bot का ओपन सोर्स विकल्प है, ऐसे स्थायी AI साथियों के लिए जो असली काम करते हैं। आपकी कुंजियाँ, आपका मॉडल, आपकी मशीन।",
    ogImageAlt:
      "Rakazo. ऐसे AI साथी जो सच में आपके अपने हैं। आपकी कुंजियाँ, आपका मॉडल, आपकी मशीन।",
    availableLanguage: "Hindi",
    skipToContent: "सामग्री पर जाएं",
    nav: {
      home: "Rakazo होम",
      primary: "मुख्य नेविगेशन",
      menu: "मेनू",
      docs: "दस्तावेज़",
      integrations: "इंटीग्रेशन",
      blog: "ब्लॉग",
      github: "GitHub",
      getStarted: "शुरू करें",
    },
    hero: {
      eyebrow: "ओपन सोर्स",
      heading: "Grok Bot का ओपन सोर्स विकल्प, जो सच में आपका अपना है",
      lead: "अपने बॉट्स को काम दें। किसी भी डिवाइस से हाल देखें।",
      getStarted: "शुरू करें",
      download: {
        mac: "macOS के लिए डाउनलोड करें",
        windows: "Windows के लिए डाउनलोड करें",
        linux: "Linux के लिए डाउनलोड करें",
        ios: "iOS के लिए डाउनलोड करें",
        android: "Android के लिए डाउनलोड करें",
      },
      viewOnGithub: "GitHub पर देखें",
      setupWithAgent: "अपने एजेंट से सेट अप करें",
      copiedForAgent: "आपके एजेंट के लिए कॉपी किया गया",
      copyFailed: "कॉपी नहीं हो सका। फिर से कोशिश करें।",
    },
    selfHost: {
      heading: "सेल्फ़-होस्टेड",
      copy: "आपकी मशीन, आपके मॉडल, आपका नियंत्रण।",
      worksWith: "इनके साथ काम करता है",
      mock: { model: "मॉडल", weekdays: "कार्यदिवस, 9:00 बजे", approval: "अनुमोदन ज़रूरी", approve: "अनुमोदित करें", deny: "अस्वीकार करें" },
      features: [
        { title: "आपका मॉडल", body: "हर बॉट के लिए अलग मॉडल चुनें।" },
        { title: "शेड्यूल पर काम", body: "जब तक आपका कंप्यूटर चालू है, दोहराए जाने वाले काम चलते रहते हैं।" },
        { title: "सीमाएं आप तय करें", body: "तय करें कि किन कार्रवाइयों के लिए आपका अनुमोदन चाहिए।" },
      ],
    },
    platforms: {
      heading: "आप जहां भी हों",
      web: "वेब",
      desktop: "डेस्कटॉप",
      mobile: "मोबाइल",
    },
    roster: {
      eyebrow: "आपकी बॉट टीम",
      heading: "हर बॉट को एक काम दें",
      copy: "किसी टेम्पलेट से शुरू करें। उसे अपने हिसाब से बनाएं।",
      bots: HI_ROSTER,
    },
    channels: {
      heading: "कहीं से भी मैसेज करें",
      copy: "Slack में किसी बॉट को मेंशन करें या अपने फ़ोन से उसे मैसेज भेजें।",
      mock: { ask: "आज किसे फ़ॉलो-अप चाहिए?", reply: "इस हफ़्ते तीन लीड्स ने जवाब देना बंद कर दिया। ड्राफ़्ट थ्रेड में हैं।" },
    },
    features: {
      heading: "चैट से कहीं ज़्यादा",
      items: {
        call: { title: "यह आपको कॉल करता है", body: "जब किसी काम में आपकी ज़रूरत हो, आपका बॉट ऐप में आपको कॉल करता है। बात करके सुलझाएं।" },
        apps: { title: "आपके ऐप्स में काम करता है", body: "Gmail, GitHub, Notion और किसी भी MCP सर्वर से कनेक्ट करें।" },
        memory: { title: "याद रखता है", body: "बॉट्स जो सीखते हैं उसे याद रखते हैं और टीम के साथ शेयर करते हैं।" },
        triggers: { title: "अपने आप जाग जाता है", body: "शेड्यूल पर, Webhook से, GitHub इवेंट पर, या जिस चीज़ पर वह नज़र रखता है उसमें बदलाव होने पर।" },
        team: { title: "काम आगे सौंपता है", body: "बॉट्स एक-दूसरे को काम सौंपते हैं और समूहों में साथ काम करते हैं।" },
        teach: { title: "देखकर सीखता है", body: "उसके कंप्यूटर पर एक बार काम करके दिखाएं। वह उन स्टेप्स को स्किल के रूप में सहेज लेता है।" },
      },
      mock: {
        calling: "कॉल हो रही है…",
        memory: "मेमोरी",
        memoryNotes: ["छोटे जवाब पसंद हैं", "Acme का रिन्यूअल मार्च में है"],
        triggers: ["कार्यदिवस, 9:00 बजे", "नया GitHub issue", "Webhook"],
        recording: "रिकॉर्डिंग",
        skillSaved: "स्किल के रूप में सहेजा गया",
      },
    },
    testimonials: {
      heading: "लोगों को यह पसंद है",
      pause: "रोकें",
      play: "चलाएं",
      items: TESTIMONIALS,
    },
    faq: {
      heading: "अक्सर पूछे जाने वाले सवाल",
      items: [
        {
          question: "क्या मेरा Claude Pro/Max या ChatGPT Plus/Pro सब्सक्रिप्शन इस्तेमाल हो सकता है?",
          answer:
            "हाँ — उसी सब्सक्रिप्शन से साइन इन करें, या API कुंजी, OpenRouter या कोई लोकल OpenAI-संगत सर्वर (Ollama, LM Studio आदि) इस्तेमाल करें। मॉडल का बिल Rakazo नहीं भरता।",
        },
        {
          question: "अगर Claude या ChatGPT का पेड सब्सक्रिप्शन पहले से है, तो क्या API कुंजी चाहिए?",
          answer:
            "नहीं। Claude Pro/Max या ChatGPT Plus/Pro से साइन इन करें, और वही सब्सक्रिप्शन मॉडल का खर्च उठाता है। API कुंजी दूसरा रास्ता है, Anthropic, OpenAI, OpenRouter या Grok के लिए। दोनों में से किसी भी तरीके में Rakazo भुगतान नहीं करता।",
        },
        {
          question: "क्या लोकल मॉडल चलाया जा सकता है?",
          answer:
            "हाँ। बॉट को Ollama या LM Studio जैसे किसी लोकल OpenAI-संगत सर्वर से जोड़ें। हर बॉट अलग मॉडल इस्तेमाल कर सकता है।",
        },
        {
          question: "होस्टेड प्लान में क्या शामिल है?",
          answer:
            "हर महीने 100 कंप्यूटर-घंटे तक और एक साथ चलने वाले 5 कंप्यूटर। ज़्यादातर लोगों के लिए यह काफ़ी से भी ज़्यादा है, और कोई ओवरेज शुल्क नहीं है।",
        },
      ],
    },
    openSource: {
      heading: "ओपन सोर्स",
      copy: "Apache-2.0. इसे चलाएं, बदलें, अपने हिसाब से बनाएं।",
      starOnGithub: "GitHub पर स्टार करें",
      readTheDocs: "दस्तावेज़ पढ़ें",
      cloudTitle: "क्लाउड",
      cloudBadge: "बीटा",
    },
    cta: {
      heading: "अपने पहले बॉट से मिलें",
      copy: "अपना अगला काम सौंप दें।",
      openSourceValue: "ओपन सोर्स",
      selfHostValue: "सेल्फ़-होस्ट",
      stats: [
        { value: "stars", label: "GitHub स्टार्स" },
        { value: "license", label: "लाइसेंस" },
        { value: "openSource", label: "न सीट्स, न पाबंदियां" },
        { value: "selfHost", label: "आपकी मशीन" },
      ],
    },
    footer: {
      navLabel: "फ़ुटर",
      languagesLabel: "भाषा",
      links: {
        docs: "दस्तावेज़",
        product: "प्रोडक्ट",
        changelog: "चेंजलॉग",
        alternatives: "विकल्प",
        all: "सभी",
        about: "हमारे बारे में",
        support: "सहायता",
        privacy: "गोपनीयता",
        terms: "शर्तें",
        company: "कंपनी",
        blog: "ब्लॉग",
        iosApp: "iPhone ऐप",
        androidApp: "Android ऐप",
      },
    },
  },
  "zh-tw": {
    title: "Rakazo | 開源 Grok Bot 替代方案",
    description:
      "Rakazo 是開源的 Grok Bot 替代方案，讓常駐的 AI 隊友幫你完成實際工作。金鑰、模型、機器，全都屬於你。",
    ogImageAlt: "Rakazo：真正屬於你的 AI 隊友。金鑰、模型、機器，全都屬於你。",
    availableLanguage: "Chinese (Traditional)",
    skipToContent: "跳至主要內容",
    nav: {
      home: "Rakazo 首頁",
      primary: "主要導覽",
      menu: "選單",
      docs: "說明文件",
      integrations: "整合",
      blog: "部落格",
      github: "GitHub",
      getStarted: "開始使用",
    },
    hero: {
      eyebrow: "開源",
      heading: "真正屬於你的開源 Grok Bot 替代方案",
      lead: "把工作交給機器人，用任何裝置隨時查看。",
      getStarted: "開始使用",
      download: {
        mac: "下載 macOS 版",
        windows: "下載 Windows 版",
        linux: "下載 Linux 版",
        ios: "下載 iOS 版",
        android: "下載 Android 版",
      },
      viewOnGithub: "在 GitHub 上查看",
      setupWithAgent: "用你的代理程式設定",
      copiedForAgent: "已為你的代理程式複製",
      copyFailed: "複製失敗，請重試。",
    },
    selfHost: {
      heading: "自行託管",
      copy: "機器、模型、控制權，都由你掌握。",
      worksWith: "支援",
      mock: { model: "模型", weekdays: "工作日 9:00", approval: "需要核准", approve: "核准", deny: "拒絕" },
      features: [
        { title: "自選模型", body: "為每個機器人選擇不同的模型。" },
        { title: "依排程執行", body: "只要電腦保持開機，週期性任務就會照常執行。" },
        { title: "由你設定界線", body: "決定哪些動作需要你核准。" },
      ],
    },
    platforms: {
      heading: "隨時隨地",
      web: "網頁版",
      desktop: "桌面版",
      mobile: "行動版",
    },
    roster: {
      eyebrow: "你的機器人團隊",
      heading: "為每個機器人分配工作",
      copy: "從範本開始，調整成你要的樣子。",
      bots: ZH_TW_ROSTER,
    },
    channels: {
      heading: "隨處傳訊息",
      copy: "在 Slack 中提及機器人，或用手機傳訊息給它。",
      mock: { ask: "今天該跟進誰？", reply: "這週有三個潛在客戶沒有回音。草稿已放在討論串裡。" },
    },
    features: {
      heading: "不只是聊天",
      items: {
        call: { title: "它會打電話給你", body: "需要你的時候，機器人會在 App 裡打電話給你。直接講清楚。" },
        apps: { title: "在你的 App 裡工作", body: "連接 Gmail、GitHub、Notion 和任何 MCP 伺服器。" },
        memory: { title: "記得住", body: "機器人會記住學到的東西，並與團隊分享。" },
        triggers: { title: "自動啟動", body: "依排程、Webhook、GitHub 事件，或它關注的變化觸發。" },
        team: { title: "分派工作", body: "機器人彼此委派工作，也能在群組中協作。" },
        teach: { title: "看一次就會", body: "在它的電腦上示範一次任務，它會把步驟存成技能。" },
      },
      mock: {
        calling: "撥號中…",
        memory: "記憶",
        memoryNotes: ["偏好簡短回覆", "Acme 三月續約"],
        triggers: ["工作日 9:00", "新的 GitHub issue", "Webhook"],
        recording: "錄製中",
        skillSaved: "已存成技能",
      },
    },
    testimonials: {
      heading: "大家都愛用",
      pause: "暫停",
      play: "播放",
      items: TESTIMONIALS,
    },
    faq: {
      heading: "常見問題",
      items: [
        {
          question: "可以用我的 Claude Pro/Max 或 ChatGPT Plus/Pro 訂閱嗎？",
          answer:
            "可以 — 用該訂閱登入，或使用 API 金鑰、OpenRouter，或本機的 OpenAI 相容伺服器（Ollama、LM Studio 等）。模型費用不由 Rakazo 支付。",
        },
        {
          question: "已經付費使用 Claude 或 ChatGPT，還需要 API 金鑰嗎？",
          answer:
            "不需要。用 Claude Pro/Max 或 ChatGPT Plus/Pro 登入，模型費用由該訂閱涵蓋。API 金鑰是另一種方式，適用於 Anthropic、OpenAI、OpenRouter 或 Grok。無論哪種方式，Rakazo 都不會付費。",
        },
        {
          question: "可以執行本機模型嗎？",
          answer:
            "可以。將機器人指向 Ollama 或 LM Studio 等本機 OpenAI 相容伺服器。每個機器人都可以使用不同的模型。",
        },
        {
          question: "託管方案包含哪些內容？",
          answer:
            "每月最多 100 個電腦小時，最多同時執行 5 台電腦。對大多數人來說綽綽有餘，而且沒有超額費用。",
        },
      ],
    },
    openSource: {
      heading: "開源",
      copy: "Apache-2.0。自由執行、修改，打造成你要的樣子。",
      starOnGithub: "在 GitHub 上加星號",
      readTheDocs: "閱讀說明文件",
      cloudTitle: "雲端",
      cloudBadge: "Beta 版",
    },
    cta: {
      heading: "認識你的第一個機器人",
      copy: "把下一項任務交給它。",
      openSourceValue: "開源",
      selfHostValue: "自行託管",
      stats: [
        { value: "stars", label: "GitHub 星號" },
        { value: "license", label: "授權" },
        { value: "openSource", label: "不限席次，沒有門檻" },
        { value: "selfHost", label: "你的機器" },
      ],
    },
    footer: {
      navLabel: "頁尾",
      languagesLabel: "語言",
      links: {
        docs: "說明文件",
        product: "產品",
        changelog: "更新紀錄",
        alternatives: "替代方案",
        all: "全部",
        about: "關於我們",
        support: "支援",
        privacy: "隱私權",
        terms: "條款",
        company: "公司",
        blog: "部落格",
        iosApp: "iPhone App",
        androidApp: "Android App",
      },
    },
  },
};

export function getHomeCopy(locale: Locale): HomeCopy {
  return HOME_COPY[locale];
}
