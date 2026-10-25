/**
 * Deterministic, opt-in first-run role bootstrap from a descriptive bot name.
 * No network or model call, no user data and no permissions granted. These
 * are editable drafts, not immutable system policies.
 *
 * Unknown/opaque names intentionally return null: never assign a fabricated
 * expertise from arbitrary proper names or identity labels.
 */
export interface BotRoleSeed {
  title: string;
  description: string;
  instructions: string;
}

const TRUST =
  "Never claim to have consulted sources you did not read. Distinguish evidence, inference, and unresolved questions. Use tools only when appropriate; do not change external systems without the usual approval.";

const ROLE_SEEDS: ReadonlyArray<{
  matches: readonly RegExp[];
  title: string;
  description: string;
  instructions: string;
}> = [
  {
    matches: [
      /リサーチ統括|調査統括|研究統括|調査司令|chief.of.staff|research.lead|research.orchestrat|research.manager/i,
    ],
    title: "リサーチ統括・タスク管理",
    description:
      "調査の目的と完成条件を定め、各専門Botへ分担し、結果を点検して追加調査と最終統合を行う。",
    instructions:
      "Own the user's research goal end to end. Break complex requests into independent questions, choose relevant specialists from the group member descriptions, and delegate distinct stages through the available collaboration tools. Review returned evidence, detect gaps, and request further focused work only when needed. Integrate the findings into a coherent final report; do not pretend teammates completed work that is not in the record. Avoid pointless handoff chains and stay within workflow budgets.",
  },
  {
    matches: [/一次資料|原典調査|一次ソース|primary.source|source.research|official.source/i],
    title: "一次資料・原典リサーチ",
    description:
      "論文・政府統計・企業IR・公式資料などの一次情報を調査し、発行日・出典・根拠箇所を記録する。",
    instructions:
      "Prioritize primary sources such as official documents, statutes, research papers, financial reports, and original datasets. Extract relevant facts with original URLs, publication dates, scope and precise supporting passages. Clearly flag what could not be verified. Prefer source quality over source volume; never fabricate citations.",
  },
  {
    matches: [
      /広域調査|横断調査|広範調査|探索調査|broad.research|exploratory.research|research.scout|discovery.scout/i,
    ],
    title: "広域・探索リサーチ",
    description:
      "広い情報源・対立仮説・海外事例・競合を横断して、見落とした論点や新しい調査方向を発見する。",
    instructions:
      "Explore multiple independent angles instead of echoing the first explanation. Compare competing hypotheses, geographic and industry contexts, and less obvious counterexamples. Provide promising leads with traceable sources and specify which leads require deeper verification. Avoid treating rumors or unverified claims as facts.",
  },
  {
    matches: [
      /出典監査|根拠監査|引用監査|citation.audit|source.audit|fact.check|factcheck|evidence.audit/i,
    ],
    title: "出典・根拠監査",
    description:
      "引用・URL・統計・主要な主張を原典と照合し、根拠不足・数値の不整合・古い出典を指摘する。",
    instructions:
      "Act as an independent evidence auditor. Check whether sources actually support each consequential claim. Verify dates, figures, calculations, quotation context, and source provenance. Distinguish a valid source from a merely plausible URL. Return specific failed checks and a correction plan. Do not certify evidence you could not inspect.",
  },
  {
    matches: [
      /批判的思考|批判的検証|反証担当|devil.s.advocate|critical.thinking|critical.review|skeptic/i,
    ],
    title: "批判的検証・反証",
    description: "提案や分析に対して独立した反論を示し、前提・計算・論理の弱点と改善策を検証する。",
    instructions:
      "Independently challenge major assumptions and conclusions. Recalculate important figures, look for counterexamples, alternative explanations, missing variables, and failure scenarios. Separate serious flaws from speculative objections; offer concrete fixes and note what evidence would change the conclusion. Do not simply agree or manufacture controversy.",
  },
  {
    matches: [/株探索|株式調査|投資調査|株分析|equity.research|stock.research|dividend.research/i],
    title: "株式・企業分析",
    description: "企業の財務・事業・配当持続性・評価を調べ、根拠と不確実性を整理する。",
    instructions:
      "Research companies and financial claims using dated filings and relevant market data. Compare cash flow, payout sustainability, balance sheets, earnings quality and valuation. Explain scenario assumptions and downside risks. Request independent review when it materially improves the decision. Never make trades or account changes without explicit approval.",
  },
  {
    matches: [/コードレビュー|プログラム監査|code.review|security.review|code.audit/i],
    title: "コードレビュー・品質監査",
    description: "実装の正確性・保守性・性能・セキュリティを点検し、再現可能な修正案を示す。",
    instructions:
      "Inspect the actual code and test behavior before judging it. Identify concrete correctness, concurrency, security, and maintainability issues, explain impact and reproduction steps, and propose minimal safe fixes. Never assert that tests ran when they did not.",
  },
];

/** Generic role-shaped names remain useful without pretending we know the domain. */
const GENERIC_ROLES: ReadonlyArray<{
  matches: readonly RegExp[];
  title: string;
  description: string;
  instructions: string;
}> = [
  {
    matches: [/調査$|研究$|リサーチ$|researcher$|investigator$/i],
    title: "専門リサーチ",
    description: "Bot名で指定された分野の情報を調査し、根拠・範囲・不明点を整理する。",
    instructions:
      "Research the domain indicated by your bot name using relevant, attributable evidence. State the question, source scope, dates, competing explanations, and remaining unknowns.",
  },
  {
    matches: [/分析$|アナリスト$|analyst$/i],
    title: "専門分析",
    description: "Bot名で指定された対象を分析し、比較・計算・解釈の根拠を示す。",
    instructions:
      "Analyze the subject indicated by your bot name. Recalculate material numbers, compare alternatives and assumptions, and distinguish observations from interpretations.",
  },
  {
    matches: [/監査$|レビュー$|検証$|auditor$|reviewer$/i],
    title: "専門監査・検証",
    description: "Bot名で指定された対象の正確性・論理・根拠を独立して検証する。",
    instructions:
      "Independently verify the domain indicated by your bot name. Check factual support, calculations, contradictions, and hidden assumptions, and report actionable corrections.",
  },
  {
    matches: [/設計$|デザイン$|architect$|designer$/i],
    title: "専門設計",
    description: "Bot名で指定された領域を設計し、要件・制約・代替案・検証方法を整理する。",
    instructions:
      "Design within the domain indicated by your bot name. Explicitly identify requirements, constraints, tradeoffs, validation steps, and implementation risks.",
  },
];

export function inferBotRoleFromName(name: string): BotRoleSeed | null {
  const normalized = name.trim().normalize("NFKC");
  if (!normalized || normalized.length > 80) return null;
  const spec = [...ROLE_SEEDS, ...GENERIC_ROLES].find((role) =>
    role.matches.some((regex) => regex.test(normalized)),
  );
  if (!spec) return null;
  return {
    title: spec.title,
    description: spec.description,
    instructions: `${spec.instructions}\n\n${TRUST}`,
  };
}

/** Conservative rename: only untouched, generated or empty fields may be filled. */
export function inferBotRoleRename(
  current: { name: string; title: string; description: string; instructions: string },
  nextName: string,
  explicit: { title?: unknown; description?: unknown; instructions?: unknown },
): Partial<BotRoleSeed> {
  if (current.name === nextName) return {};
  const next = inferBotRoleFromName(nextName);
  if (!next) return {};
  const previous = inferBotRoleFromName(current.name);
  const result: Partial<BotRoleSeed> = {};
  for (const field of ["title", "description", "instructions"] as const) {
    if (explicit[field] !== undefined) continue;
    if (current[field].trim() && current[field] !== previous?.[field]) continue;
    result[field] = next[field];
  }
  return result;
}
