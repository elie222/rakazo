import type { AgentSkill, AgentSkillCatalogEntry, Bot } from "@rakazo/contracts";
import { buildSkillMd, getSkillBotScope, parseSkillMd } from "@rakazo/core";
import {
  Badge,
  BotAvatar,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Input,
  Skeleton,
  Textarea,
} from "@rakazo/ui-web";
import {
  BookOpen,
  Check,
  Download,
  ExternalLink,
  Globe,
  Plus,
  Search,
  Settings2,
  Sparkles,
  Star,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { rpc } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";

export type MarketplaceSkill = {
  id: string;
  name: string;
  description: string;
  category: "productivity" | "finance" | "research" | "engineering" | "operations";
  author: string;
  content: string;
};

export type SkillsmpSearchResult = {
  id: string;
  name: string;
  author: string;
  description: string;
  githubUrl: string;
  skillUrl: string;
  stars?: number;
};

export const CURATED_MARKETPLACE_SKILLS: MarketplaceSkill[] = [
  {
    id: "lean-output",
    name: "Lean output",
    description:
      "Force ultra-lean, concise, zero-fluff responses. Saves 60-80% tokens, eliminates delay, accelerates task completion.",
    category: "productivity",
    author: "caveman / open-source",
    content: `---
name: Lean output
description: Use this when the user wants to save AI usage or quota, or asks for shorter, leaner replies, tool runs, and agent-to-agent messages; adapted from the open-source caveman project (Apache-2.0).
---
# Lean output

Write less and read less while keeping every bit of meaning. Use plain, short English, not broken grammar.
Most usage comes from what gets read (memory, history, tool outputs, files). Save the user time and tokens.

## Rules
1. **Lead with the answer.** No pleasantries, no recap of the question.
2. **One idea per sentence**, about 20 words at most, active voice, one term per thing.
3. **Never drop meaning.** Keep negations (not, never, no, only), numbers, units, dates, and names exact.
4. **Copy payloads verbatim.** Code, commands, paths, URLs, IDs, and error text stay character for character.
5. **Prefer structure to prose** for findings: one line per item, \`path:line — finding — fix\`, then a totals line.
`,
  },
  {
    id: "real-estate-deal-analyzer",
    name: "Real Estate Deal Analyzer",
    description:
      "Comprehensive underwriting framework for multi-family, residential, and commercial deals. Computes Cap Rate, NOI, Cash-on-Cash, DSCR, and vacancy stress tests.",
    category: "finance",
    author: "Rakazo Community",
    content: `---
name: Real Estate Deal Analyzer
description: Underwriting framework for analyzing real estate acquisitions, rental yields, cap rates, NOI, cash-on-cash return, and stress-testing pro-forma assumptions.
---
# Real Estate Deal Analyzer

Use this skill whenever evaluating a property listing, investment pitch, or multifamily underwriting model.

## Analysis Checklist
1. **Acquisition & Basis:**
   - Purchase price, renovation budget (capex), closing costs, total all-in basis.
   - Financing structure: LTV, interest rate, amortization period, debt service.
2. **Income & Operations:**
   - Gross Scheduled Rent (GSR) vs Gross Potential Rent (GPR).
   - Realistic economic vacancy deduction (minimum 5-8% unless market is ultra-tight).
   - Effective Gross Income (EGI).
3. **Operating Expenses (OpEx):**
   - Property taxes (re-assessed at purchase price!), insurance, management fee (6-10%), maintenance reserve ($300-$500/unit/yr).
   - Net Operating Income (NOI) = EGI - OpEx.
4. **Key Return Metrics:**
   - **Cap Rate** = NOI / Purchase Price.
   - **Cash-on-Cash (CoC)** = (NOI - Annual Debt Service) / Total Cash Invested.
   - **DSCR** = NOI / Annual Debt Service (target >= 1.25x).
5. **Verdict & Downside Scenarios:**
   - Stress-test vacancy at +5% and interest rates at +100bps.
   - Clear recommendation: Buy, Counteroffer, or Pass.
`,
  },
  {
    id: "market-hawk-financial",
    name: "Market Hawk & Financial Briefing",
    description:
      "Structured 4-step financial & equity analysis: Breaking News -> Fundamentals & Multiples -> Technicals & Momentum -> Call Packet with price targets.",
    category: "finance",
    author: "WallStreet / Quantitative",
    content: `---
name: Market Hawk & Financial Briefing
description: Perform rapid, quantitative equity and macro market research. Formulates a rigorous 4-step Call Packet before recommending any trade or investment thesis.
---
# Market Hawk & Financial Briefing

Always structure market analysis in four definitive sections:

### 1. Breaking News & Catalysts
- Recent SEC filings (10-K, 10-Q, 8-K), earnings surprise vs consensus, FDA or product announcements.
- Macro catalysts (Fed rates, inflation prints, supply chain shifts).

### 2. Fundamental Quality & Valuation
- Revenue growth rate (TTM and 3-yr CAGR), Gross & Operating margins.
- Valuation multiples: EV/EBITDA, P/E, P/FCF compared against direct industry peers.
- Balance sheet health: Net Debt to EBITDA, debt maturity schedule, cash burn rate.

### 3. Technical Structure & Liquidity
- Key moving averages (50-day and 200-day EMA), support/resistance levels.
- Relative Strength Index (RSI), volume expansion on breakouts vs low volume consolidations.

### 4. Trade Call & Execution Plan
- Thesis: Long, Short, or Neutral with explicit rationale.
- Risk/Reward ratio (minimum 1:2.5 required).
- Entry zone, invalidation price (stop loss), and profit targets (T1, T2).
`,
  },
  {
    id: "deep-web-researcher",
    name: "Deep Web & Fact-Checker",
    description:
      "Multi-stage entity and web research. Formulates distinct cross-verification queries, extracts primary source evidence, and validates factual claims.",
    category: "research",
    author: "Investigative Intelligence",
    content: `---
name: Deep Web & Fact-Checker
description: Autonomous multi-source verification and deep web research. Cross-references primary citations, validates claims, and compiles rigorous structured dossiers.
---
# Deep Web & Fact-Checker

Conduct research systematically across multiple angles:

## Research Protocol
1. **Deconstruct the Query:**
   - Break complex research topics into 3-5 distinct search vectors (primary source, contrarian view, data/numbers, timeline).
2. **Source Hierarchy:**
   - Prefer official documentation, regulatory filings, audited reports, academic papers over blog summaries.
3. **Cross-Verification Rule:**
   - Never accept a single secondary source for critical figures or dates; confirm with at least two independent primary records.
4. **Structured Dossier Output:**
   - Executive Summary (3-4 bullet points).
   - Core Findings with exact citations and dates.
   - Identified Uncertainties or conflicting narratives.
`,
  },
  {
    id: "code-reviewer-security",
    name: "Code Reviewer & Security Sentry",
    description:
      "Audits codebases for security vulnerabilities (OWASP Top 10), concurrency race conditions, memory leaks, performance bottlenecks, and architectural anti-patterns.",
    category: "engineering",
    author: "AppSec Team",
    content: `---
name: Code Reviewer & Security Sentry
description: Security and architecture auditor. Inspects code for injection, authentication leaks, race conditions, memory bloat, and performance bottlenecks.
---
# Code Reviewer & Security Sentry

Audit code pull requests and snippets using rigorous defense-in-depth criteria:

## Review Checkpoints
1. **Security Vulnerabilities:**
   - Injection (SQL, command, XSS, template injection).
   - Insecure direct object references (IDOR) and tenant isolation checks.
   - Secret leaks, hardcoded credentials, unsanitized logging of PII.
2. **Reliability & Edge Cases:**
   - Missing error handling, unhandled promise rejections, race conditions.
   - Memory leaks, unclosed streams or file handles, unbounded loops or unbounded arrays in memory.
3. **Performance & Scalability:**
   - N+1 database queries, missing indexes, unnecessary synchronous serialization.
4. **Output Format:**
   - \`File:Line — Severity (Critical / High / Medium / Low) — Finding — Concrete Fix\`.
`,
  },
  {
    id: "job-search-career-scout",
    name: "Job Search & Career Scout",
    description:
      "Autonomous career intelligence and resume tailoring. Benchmarks candidate credentials against role requirements, highlights keywords, and crafts outreach.",
    category: "productivity",
    author: "Career Navigator",
    content: `---
name: Job Search & Career Scout
description: Discovers open job opportunities, compares candidate resumes to role descriptions, flags qualification gaps, and drafts targeted outreach messages.
---
# Job Search & Career Scout

## Workflow
1. **Requirement Extraction:**
   - Identify must-have technical skills, domain experience, and leadership qualifications from job descriptions.
2. **Resume Gap Analysis:**
   - Match candidate strengths against the job specification.
   - Calculate match percentage (0-100%) and identify 2-3 specific gaps to address or mitigate.
3. **High-Impact Talking Points:**
   - Highlight 3 measurable achievements with metrics (revenue, scale, latency, efficiency) matching the role.
4. **Targeted Networking Outreach:**
   - Draft a 3-sentence personalized message to the hiring manager or recruiter.
`,
  },
  {
    id: "autonomous-task-decomposer",
    name: "Autonomous Task Decomposer",
    description:
      "Breaks complex, vague initiatives into dependency-ordered atomic work units with verification checklists and rollback contingencies.",
    category: "operations",
    author: "Agile Systems",
    content: `---
name: Autonomous Task Decomposer
description: Breaks down ambiguous or multi-step engineering and business projects into ordered atomic subtasks, acceptance criteria, and rollback paths.
---
# Autonomous Task Decomposer

When given a high-level goal, break it down before execution:

1. **Objective Statement:** One sentence defining success.
2. **Milestones & Dependency Graph:**
   - Phase 1: Prerequisites & Foundation (Setup, schema, contracts).
   - Phase 2: Core Implementation (Business logic, state machines).
   - Phase 3: Integration & Testing (End-to-end verification, error scenarios).
3. **Task Cards:**
   - For each task: \`Task ID\`, \`Actionable verb\`, \`Verification criteria\`, \`Dependencies\`.
4. **Rollback Contingency:**
   - Step-by-step recovery plan if any phase fails.
`,
  },
  {
    id: "meeting-standup-scribe",
    name: "Meeting & Standup Scribe",
    description:
      "Transforms messy meeting transcripts and notes into punchy executive summaries with key decisions, tagged owners, blocker triage, and deadline matrix.",
    category: "operations",
    author: "Ops Productivity",
    content: `---
name: Meeting & Standup Scribe
description: Converts meeting notes, transcripts, or standups into structured decisions, owners, blockers, and deliverables.
---
# Meeting & Standup Scribe

Transform raw conversation or audio notes into action:

## Structure
1. **TL;DR:** 2 sentences on the primary focus of the session.
2. **Decisions Made:** Bullet points with clear consensus reached (no ambiguity).
3. **Action Items Matrix:**
   - \`[Owner] — Task Description — Deadline / Milestone\`.
4. **Blockers & Risks:** Immediate impediments requiring escalation.
5. **Next Sync:** Date, focus, and required preparation.
`,
  },
];

export function SkillsTab({
  activeBotId,
  onSkillsCountChange,
}: {
  activeBotId?: string;
  onSkillsCountChange?: (count: number) => void;
}) {
  const [subTab, setSubTab] = useState<"installed" | "marketplace" | "import">("installed");
  const [marketSource, setMarketSource] = useState<"curated" | "skillsmp">("curated");
  const [skills, setSkills] = useState<AgentSkillCatalogEntry[]>([]);
  const [bots, setBots] = useState<Bot[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // SkillsMP Live Search state
  const [skillsmpQuery, setSkillsmpQuery] = useState("agent");
  const [skillsmpResults, setSkillsmpResults] = useState<SkillsmpSearchResult[]>([]);
  const [skillsmpLoading, setSkillsmpLoading] = useState(false);

  // Editor / View modal state
  const [activeSkill, setActiveSkill] = useState<AgentSkill | null>(null);
  const [editorDraft, setEditorDraft] = useState("");
  const [editorSaving, setEditorSaving] = useState(false);
  const [isCreatingCustom, setIsCreatingCustom] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  // Scope configurator modal state
  const [scopeModalSkill, setScopeModalSkill] = useState<AgentSkill | null>(null);
  const [scopeIsGlobal, setScopeIsGlobal] = useState(true);
  const [scopeBotIds, setScopeBotIds] = useState<string[]>([]);
  const [scopeSaving, setScopeSaving] = useState(false);

  // Marketplace install modal state
  const [installModalSkill, setInstallModalSkill] = useState<MarketplaceSkill | null>(null);
  const [installScopeGlobal, setInstallScopeGlobal] = useState(true);
  const [installScopeBotIds, setInstallScopeBotIds] = useState<string[]>(
    activeBotId ? [activeBotId] : [],
  );
  const [installing, setInstalling] = useState(false);

  // Import modal state
  const [importUrl, setImportUrl] = useState("");
  const [importMarkdown, setImportMarkdown] = useState("");
  const [importScopeGlobal, setImportScopeGlobal] = useState(true);
  const [importScopeBotIds, setImportScopeBotIds] = useState<string[]>(
    activeBotId ? [activeBotId] : [],
  );
  const [importing, setImporting] = useState(false);
  const [fetchingUrl, setFetchingUrl] = useState(false);

  const generation = useRef(0);
  const searchGeneration = useRef(0);

  async function loadData() {
    const gen = ++generation.current;
    try {
      const [skillsList, botsList] = await Promise.all([rpc.agentSkills.list(), rpc.bots.list()]);
      if (gen !== generation.current) return;
      setSkills(skillsList);
      setBots(botsList);
      onSkillsCountChange?.(skillsList.length);
      setLoading(false);
    } catch (err) {
      if (gen !== generation.current) return;
      setError(errorText(err, "Could not load skills"));
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadData();
    return () => {
      generation.current += 1;
      searchGeneration.current += 1;
    };
  }, []);

  function flashSuccess(msg: string) {
    setSuccessMessage(msg);
    setTimeout(() => setSuccessMessage(null), 3500);
  }

  // Live search SkillsMP
  async function searchSkillsmp(queryText: string) {
    const gen = ++searchGeneration.current;
    setSkillsmpLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/skills/skillsmp-search?q=${encodeURIComponent(queryText.trim() || "agent")}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as {
        success?: boolean;
        data?: { skills?: SkillsmpSearchResult[] };
      };
      if (gen !== searchGeneration.current) return;
      setSkillsmpResults(Array.isArray(json.data?.skills) ? json.data.skills : []);
    } catch (err) {
      if (gen !== searchGeneration.current) return;
      setSkillsmpResults([]);
      setError(errorText(err, "Could not reach SkillsMP API"));
    } finally {
      if (gen === searchGeneration.current) setSkillsmpLoading(false);
    }
  }

  // Load initial SkillsMP search when switching to skillsmp
  useEffect(() => {
    if (subTab === "marketplace" && marketSource === "skillsmp" && skillsmpResults.length === 0) {
      void searchSkillsmp(skillsmpQuery);
    }
  }, [subTab, marketSource]);

  // Filter installed skills
  const filteredInstalledSkills = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter(
      (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
    );
  }, [skills, searchQuery]);

  // Filter curated marketplace skills
  const filteredCuratedSkills = useMemo(() => {
    return CURATED_MARKETPLACE_SKILLS.filter((item) => {
      const matchesCategory = selectedCategory === "all" || item.category === selectedCategory;
      const q = searchQuery.trim().toLowerCase();
      const matchesSearch =
        !q ||
        item.name.toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q) ||
        item.author.toLowerCase().includes(q);
      return matchesCategory && matchesSearch;
    });
  }, [selectedCategory, searchQuery]);

  const installedSkillNames = useMemo(() => {
    return new Set(skills.map((s) => s.name.toLowerCase()));
  }, [skills]);

  // Open scope modal
  async function openScopeModal(entry: AgentSkillCatalogEntry) {
    setError(null);
    try {
      const skill = await rpc.agentSkills.get({ skillId: entry.id });
      const parsedScope = getSkillBotScope(skill.content);
      setScopeModalSkill(skill);
      setScopeIsGlobal(parsedScope.isGlobal);
      setScopeBotIds(parsedScope.botIds);
    } catch (err) {
      setError(errorText(err, "Could not load skill details"));
    }
  }

  // Save updated scope
  async function saveScope() {
    if (!scopeModalSkill) return;
    setScopeSaving(true);
    setError(null);
    try {
      // Re-fetch current content to prevent silently overwriting concurrent edits
      const latest = await rpc.agentSkills.get({ skillId: scopeModalSkill.id });
      if (latest.content !== scopeModalSkill.content) {
        setError(
          "Skill was modified elsewhere while editing scope. Please reopen to configure scope.",
        );
        return;
      }

      const parsed = parseSkillMd(latest.content);
      if ("error" in parsed) throw new Error(parsed.error);

      const nextFrontmatter = { ...parsed.frontmatter };
      if (scopeIsGlobal) {
        nextFrontmatter.scope = "global";
        nextFrontmatter.bots = ["all"];
      } else {
        if (scopeBotIds.length === 0) {
          setError("Select at least one bot for specific bot scope.");
          return;
        }
        nextFrontmatter.scope = "bot";
        nextFrontmatter.bots = scopeBotIds;
      }

      const updatedContent = buildSkillMd({
        name: parsed.name,
        description: parsed.description,
        body: parsed.body,
        frontmatter: nextFrontmatter,
      });

      await rpc.agentSkills.update({
        skillId: scopeModalSkill.id,
        content: updatedContent,
        expectedContent: scopeModalSkill.content,
      });

      setScopeModalSkill(null);
      await loadData();
      flashSuccess("Bot scope updated successfully");
    } catch (err) {
      setError(errorText(err, "Could not save skill scope"));
    } finally {
      setScopeSaving(false);
    }
  }

  // Open editor
  async function openSkillEditor(entry: AgentSkillCatalogEntry) {
    setError(null);
    try {
      const skill = await rpc.agentSkills.get({ skillId: entry.id });
      setActiveSkill(skill);
      setEditorDraft(skill.content);
      setIsCreatingCustom(false);
    } catch (err) {
      setError(errorText(err, "Could not load skill"));
    }
  }

  // New skill
  function openNewSkill() {
    setError(null);
    setIsCreatingCustom(true);
    setActiveSkill(null);
    setEditorDraft(`---
name: my-new-skill
description: Describe when and how agents should use this skill.
scope: global
bots:
  - all
---

# Instructions for Agent

1. Specify step-by-step guidance.
2. Outline decision rules or constraints.
`);
  }

  // Save editor content
  async function saveEditorContent() {
    if (!editorDraft.trim()) return;
    setEditorSaving(true);
    setError(null);
    try {
      if (isCreatingCustom) {
        await rpc.agentSkills.create({ content: editorDraft });
        flashSuccess("New skill created!");
      } else if (activeSkill) {
        await rpc.agentSkills.update({
          skillId: activeSkill.id,
          content: editorDraft,
          expectedContent: activeSkill.content,
        });
        flashSuccess("Skill updated!");
      }
      setActiveSkill(null);
      setIsCreatingCustom(false);
      await loadData();
    } catch (err) {
      setError(errorText(err, "Could not save skill"));
    } finally {
      setEditorSaving(false);
    }
  }

  // Delete skill
  async function removeSkill(skillId: string) {
    try {
      await rpc.agentSkills.remove({ skillId });
      setDeleteConfirmId(null);
      if (activeSkill?.id === skillId) setActiveSkill(null);
      await loadData();
      flashSuccess("Skill removed");
    } catch (err) {
      setError(errorText(err, "Could not delete skill"));
    }
  }

  // Install marketplace skill
  async function installMarketplaceSkill() {
    if (!installModalSkill) return;
    setInstalling(true);
    setError(null);
    try {
      const parsed = parseSkillMd(installModalSkill.content);
      if ("error" in parsed) throw new Error(parsed.error);

      const nextFrontmatter = { ...parsed.frontmatter };
      if (installScopeGlobal) {
        nextFrontmatter.scope = "global";
        nextFrontmatter.bots = ["all"];
      } else {
        if (installScopeBotIds.length === 0) {
          setError("Select at least one bot for specific bot scope.");
          return;
        }
        nextFrontmatter.scope = "bot";
        nextFrontmatter.bots = installScopeBotIds;
      }

      const contentWithScope = buildSkillMd({
        name: parsed.name,
        description: parsed.description,
        body: parsed.body,
        frontmatter: nextFrontmatter,
      });

      await rpc.agentSkills.create({ content: contentWithScope });
      setInstallModalSkill(null);
      await loadData();
      flashSuccess(`Skill "${installModalSkill.name}" installed successfully!`);
    } catch (err) {
      setError(errorText(err, "Could not install marketplace skill"));
    } finally {
      setInstalling(false);
    }
  }

  // Fetch from URL using server proxy (avoids CORS)
  async function fetchUrlContent(targetUrl: string) {
    const trimmed = targetUrl.trim();
    if (!trimmed) return;

    // If user provided https://skillsmp.com or https://skillsmp.com/
    if (/^https?:\/\/skillsmp\.com\/?$/i.test(trimmed)) {
      setSubTab("marketplace");
      setMarketSource("skillsmp");
      flashSuccess("Opened SkillsMP directory! Search or browse 3,000,000+ skills below.");
      return;
    }

    setFetchingUrl(true);
    setError(null);
    try {
      const res = await fetch(`/api/skills/fetch-url?url=${encodeURIComponent(trimmed)}`);
      const data = (await res.json()) as { ok?: boolean; content?: string; error?: string };
      if (!res.ok || !data.content) {
        throw new Error(data.error ?? `Failed to fetch URL (HTTP ${res.status})`);
      }
      setImportMarkdown(data.content);
      flashSuccess("Skill content fetched successfully! Preview and customize below.");
    } catch (err) {
      setError(errorText(err, "Could not fetch skill from URL"));
    } finally {
      setFetchingUrl(false);
    }
  }

  // Import and install
  async function executeImport() {
    setImporting(true);
    setError(null);
    try {
      let contentToImport = importMarkdown.trim();

      if (!contentToImport && importUrl.trim()) {
        const trimmed = importUrl.trim();
        if (/^https?:\/\/skillsmp\.com\/?$/i.test(trimmed)) {
          setSubTab("marketplace");
          setMarketSource("skillsmp");
          setImporting(false);
          return;
        }
        const res = await fetch(`/api/skills/fetch-url?url=${encodeURIComponent(trimmed)}`);
        const data = (await res.json()) as { ok?: boolean; content?: string; error?: string };
        if (!res.ok || !data.content) {
          throw new Error(data.error ?? "Could not fetch URL content");
        }
        contentToImport = data.content.trim();
      }

      if (!contentToImport) {
        throw new Error("Please enter a valid skill URL or paste SKILL.md markdown.");
      }

      const parsed = parseSkillMd(contentToImport);
      if ("error" in parsed) throw new Error(parsed.error);

      const nextFrontmatter = { ...parsed.frontmatter };
      if (importScopeGlobal) {
        nextFrontmatter.scope = "global";
        nextFrontmatter.bots = ["all"];
      } else {
        if (importScopeBotIds.length === 0) {
          setError("Select at least one bot for specific bot scope.");
          return;
        }
        nextFrontmatter.scope = "bot";
        nextFrontmatter.bots = importScopeBotIds;
      }

      const finalized = buildSkillMd({
        name: parsed.name,
        description: parsed.description,
        body: parsed.body,
        frontmatter: nextFrontmatter,
      });

      await rpc.agentSkills.create({ content: finalized });
      setImportUrl("");
      setImportMarkdown("");
      setSubTab("installed");
      await loadData();
      flashSuccess(`Skill "${parsed.name}" imported and installed!`);
    } catch (err) {
      setError(errorText(err, "Import failed"));
    } finally {
      setImporting(false);
    }
  }

  // Install from SkillsMP search item
  async function installFromSkillsmp(item: SkillsmpSearchResult) {
    setError(null);
    try {
      flashSuccess(`Fetching skill "${item.name}" from repository…`);
      const res = await fetch(`/api/skills/fetch-url?url=${encodeURIComponent(item.githubUrl)}`);
      const data = (await res.json()) as { ok?: boolean; content?: string; error?: string };
      if (!res.ok || !data.content) {
        throw new Error(data.error ?? "Failed to fetch skill content from repository");
      }
      setInstallModalSkill({
        id: item.id,
        name: item.name,
        description: item.description,
        category: "productivity",
        author: item.author,
        content: data.content,
      });
      setInstallScopeGlobal(true);
      setInstallScopeBotIds(activeBotId ? [activeBotId] : []);
    } catch (err) {
      setError(errorText(err, "Could not load skill details from SkillsMP"));
    }
  }

  // Resolve bot names for scope badge
  function renderBotScopeBadge(content?: string) {
    if (!content) {
      return (
        <Badge variant="secondary" className="gap-1 border border-border bg-muted text-foreground">
          <Globe className="h-3 w-3" />
          Global
        </Badge>
      );
    }
    const scope = getSkillBotScope(content);
    if (scope.isGlobal) {
      return (
        <Badge variant="secondary" className="gap-1 border border-border bg-muted text-foreground">
          <Globe className="h-3 w-3" />
          Global (All Bots)
        </Badge>
      );
    }
    if (scope.botIds.length === 1) {
      const b = bots.find((item) => item.id === scope.botIds[0] || item.name === scope.botIds[0]);
      return (
        <Badge
          variant="secondary"
          className="gap-1 border border-primary/30 bg-primary/10 text-primary"
        >
          <Zap className="h-3 w-3" />
          {b ? b.name : scope.botIds[0]}
        </Badge>
      );
    }
    return (
      <Badge
        variant="secondary"
        className="gap-1 border border-primary/30 bg-primary/10 text-primary"
      >
        <Zap className="h-3 w-3" />
        {scope.botIds.length} Bots
      </Badge>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Top Navigation Bar inside Skills Tab */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3 border-b border-border/40 pb-4">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setSubTab("installed")}
            className={`flex items-center gap-2 rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors ${
              subTab === "installed"
                ? "bg-accent text-foreground shadow-sm"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            }`}
          >
            <BookOpen className="h-4 w-4" />
            <span>Installed Skills</span>
            <span className="rounded-full bg-background/80 px-2 py-0.2 text-xs font-semibold">
              {skills.length}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setSubTab("marketplace")}
            className={`flex items-center gap-2 rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors ${
              subTab === "marketplace"
                ? "bg-accent text-foreground shadow-sm"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            }`}
          >
            <Sparkles className="h-4 w-4 text-primary" />
            <span>Marketplace Hub</span>
          </button>

          <button
            type="button"
            onClick={() => setSubTab("import")}
            className={`flex items-center gap-2 rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors ${
              subTab === "import"
                ? "bg-accent text-foreground shadow-sm"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            }`}
          >
            <Download className="h-4 w-4" />
            <span>Import from URL / MD</span>
          </button>
        </div>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={openNewSkill}
            className="gap-1.5 rounded-lg font-medium shadow"
          >
            <Plus className="h-4 w-4" />
            <span>New Custom Skill</span>
          </Button>
        </div>
      </div>

      {/* Notifications */}
      {error && !scopeModalSkill && !installModalSkill && !activeSkill && !isCreatingCustom ? (
        <div className="mb-4 flex items-center justify-between rounded-xl bg-destructive/15 px-4 py-2.5 text-sm text-destructive">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="opacity-70 hover:opacity-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : null}

      {successMessage ? (
        <div className="mb-4 flex items-center gap-2 rounded-xl bg-success/15 px-4 py-2.5 text-sm font-medium text-success">
          <Check className="h-4 w-4" />
          <span>{successMessage}</span>
        </div>
      ) : null}

      {/* Sub-view: Installed Skills */}
      {subTab === "installed" ? (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Filter installed skills by name or keyword..."
                className="pl-9"
              />
            </div>
          </div>

          {loading ? (
            <div className="space-y-3 pt-2">
              <Skeleton className="h-20 w-full rounded-xl" />
              <Skeleton className="h-20 w-full rounded-xl" />
              <Skeleton className="h-20 w-full rounded-xl" />
            </div>
          ) : filteredInstalledSkills.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border/80 p-8 text-center">
              <BookOpen className="mx-auto mb-3 h-10 w-10 text-muted-foreground/50" />
              <h3 className="text-base font-semibold text-foreground">No skills found</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Install ready-to-use skills from Marketplace Hub or write your own custom skill.
              </p>
              <div className="mt-4 flex justify-center gap-3">
                <Button variant="secondary" size="sm" onClick={() => setSubTab("marketplace")}>
                  <Sparkles className="mr-1.5 h-4 w-4 text-primary" />
                  <span>Explore Marketplace</span>
                </Button>
                <Button variant="outline" size="sm" onClick={openNewSkill}>
                  <Plus className="mr-1.5 h-4 w-4" />
                  <span>Create Skill</span>
                </Button>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 pb-8">
              {filteredInstalledSkills.map((skill) => (
                <div
                  key={skill.id}
                  className="flex flex-col justify-between gap-3 rounded-xl border border-border/50 bg-card/60 p-4 transition-colors hover:border-border hover:bg-card/90 sm:flex-row sm:items-center"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-foreground">{skill.name}</span>
                      <Badge
                        variant="secondary"
                        className="rounded-full px-2 py-0 text-[11px] font-normal text-muted-foreground"
                      >
                        {skill.source === "builtin"
                          ? "Built-in"
                          : skill.source === "plugin"
                            ? "Plugin"
                            : "Custom"}
                      </Badge>
                      {/* Bot Scope badge */}
                      {renderBotScopeBadge(skill.content)}
                    </div>
                    <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                      {skill.description}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    {/* Bot Scope Selector Trigger - only for user-editable skills */}
                    {!skill.readOnly ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => void openScopeModal(skill)}
                        className="gap-1.5 rounded-lg text-xs"
                        title="Configure whether this skill is active globally or on specific bots"
                      >
                        <Settings2 className="h-3.5 w-3.5" />
                        <span>Bot Scope</span>
                      </Button>
                    ) : null}

                    {/* View/Edit SKILL.md */}
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => void openSkillEditor(skill)}
                      className="rounded-lg text-xs"
                    >
                      {skill.readOnly ? "View Recipe" : "Edit"}
                    </Button>

                    {/* Delete button (only for non-readonly skills) */}
                    {!skill.readOnly ? (
                      deleteConfirmId === skill.id ? (
                        <div className="flex items-center gap-1">
                          <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            onClick={() => void removeSkill(skill.id)}
                            className="rounded-lg text-xs"
                          >
                            Confirm
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => setDeleteConfirmId(null)}
                            className="rounded-lg text-xs"
                          >
                            Cancel
                          </Button>
                        </div>
                      ) : (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => setDeleteConfirmId(skill.id)}
                          className="text-muted-foreground hover:text-destructive"
                          aria-label="Delete skill"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}

      {/* Sub-view: Marketplace Hub */}
      {subTab === "marketplace" ? (
        <div className="space-y-4">
          {/* Switcher: Curated vs Live SkillsMP */}
          <div className="flex items-center justify-between border-b border-border/30 pb-3">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setMarketSource("curated")}
                className={`rounded-lg px-3 py-1 text-xs font-medium transition-colors ${
                  marketSource === "curated"
                    ? "bg-primary text-primary-foreground"
                    : "bg-accent/40 text-muted-foreground hover:bg-accent hover:text-foreground"
                }`}
              >
                Curated High-Performance Skills
              </button>
              <button
                type="button"
                onClick={() => setMarketSource("skillsmp")}
                className={`flex items-center gap-1.5 rounded-lg px-3 py-1 text-xs font-medium transition-colors ${
                  marketSource === "skillsmp"
                    ? "bg-primary text-primary-foreground"
                    : "bg-accent/40 text-muted-foreground hover:bg-accent hover:text-foreground"
                }`}
              >
                <Globe className="h-3.5 w-3.5" />
                <span>SkillsMP Directory (3,000,000+ Skills)</span>
              </button>
            </div>
          </div>

          {marketSource === "curated" ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="relative min-w-[240px] flex-1">
                  <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search curated skills..."
                    className="pl-9"
                  />
                </div>

                {/* Category pills */}
                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  {(
                    [
                      { id: "all", label: "All" },
                      { id: "productivity", label: "Productivity" },
                      { id: "finance", label: "Finance & Real Estate" },
                      { id: "research", label: "Research" },
                      { id: "engineering", label: "Code & Security" },
                      { id: "operations", label: "Operations" },
                    ] as const
                  ).map((cat) => (
                    <button
                      key={cat.id}
                      type="button"
                      onClick={() => setSelectedCategory(cat.id)}
                      className={`rounded-full px-3 py-1 font-medium transition-colors ${
                        selectedCategory === cat.id
                          ? "bg-primary text-primary-foreground"
                          : "bg-accent/60 text-muted-foreground hover:bg-accent hover:text-foreground"
                      }`}
                    >
                      {cat.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3.5 pb-8 md:grid-cols-2">
                {filteredCuratedSkills.map((item) => {
                  const isInstalled = installedSkillNames.has(item.name.toLowerCase());
                  return (
                    <Card
                      key={item.id}
                      className="flex flex-col justify-between border-border/50 bg-card/60 transition-all hover:border-border hover:bg-card/90"
                    >
                      <CardHeader className="pb-2">
                        <div className="flex items-start justify-between gap-2">
                          <CardTitle className="text-base font-semibold text-foreground">
                            {item.name}
                          </CardTitle>
                          <Badge
                            variant="secondary"
                            className="rounded-full px-2 py-0.5 text-[10.5px] font-normal uppercase tracking-wider text-muted-foreground"
                          >
                            {item.category}
                          </Badge>
                        </div>
                        <div className="text-xs text-muted-foreground/75">By {item.author}</div>
                      </CardHeader>
                      <CardContent className="space-y-4 pt-0">
                        <p className="line-clamp-3 text-sm text-muted-foreground">
                          {item.description}
                        </p>
                        <div className="flex items-center justify-between pt-2">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setError(null);
                              setActiveSkill({
                                id: `preview:${item.id}`,
                                name: item.name,
                                description: item.description,
                                content: item.content,
                                source: "plugin",
                                readOnly: true,
                                createdAt: new Date().toISOString(),
                                updatedAt: new Date().toISOString(),
                              });
                              setEditorDraft(item.content);
                              setIsCreatingCustom(false);
                            }}
                            className="text-xs text-muted-foreground hover:text-foreground"
                          >
                            <span>Preview Recipe</span>
                          </Button>

                          {isInstalled ? (
                            <Button
                              type="button"
                              variant="secondary"
                              size="sm"
                              disabled
                              className="gap-1.5 rounded-lg text-xs font-medium text-foreground"
                            >
                              <Check className="h-3.5 w-3.5" />
                              <span>Installed</span>
                            </Button>
                          ) : (
                            <Button
                              type="button"
                              variant="default"
                              size="sm"
                              onClick={() => {
                                setError(null);
                                setInstallModalSkill(item);
                                setInstallScopeGlobal(true);
                                setInstallScopeBotIds(activeBotId ? [activeBotId] : []);
                              }}
                              className="gap-1.5 rounded-lg text-xs font-medium"
                            >
                              <Download className="h-3.5 w-3.5" />
                              <span>Install Skill</span>
                            </Button>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </>
          ) : (
            /* Live SkillsMP Search */
            <div className="space-y-4 pb-8">
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    value={skillsmpQuery}
                    onChange={(e) => setSkillsmpQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void searchSkillsmp(skillsmpQuery);
                    }}
                    placeholder="Search 3,000,000+ skills on SkillsMP (e.g. market research, react, seo, crypto)..."
                    className="pl-9"
                  />
                </div>
                <Button
                  type="button"
                  variant="default"
                  disabled={skillsmpLoading}
                  onClick={() => void searchSkillsmp(skillsmpQuery)}
                  className="gap-1.5"
                >
                  <Search className="h-4 w-4" />
                  <span>{skillsmpLoading ? "Searching…" : "Search SkillsMP"}</span>
                </Button>
              </div>

              {skillsmpLoading ? (
                <div className="space-y-3 pt-2">
                  <Skeleton className="h-20 w-full rounded-xl" />
                  <Skeleton className="h-20 w-full rounded-xl" />
                </div>
              ) : skillsmpResults.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border/80 p-8 text-center text-sm text-muted-foreground">
                  No skills found on SkillsMP for "{skillsmpQuery}". Try searching another keyword.
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  {skillsmpResults.map((item) => (
                    <Card
                      key={item.id}
                      className="flex flex-col justify-between border-border/50 bg-card/60 transition-all hover:border-border hover:bg-card/90"
                    >
                      <CardHeader className="pb-2">
                        <div className="flex items-start justify-between gap-2">
                          <CardTitle className="text-base font-semibold text-foreground">
                            {item.name}
                          </CardTitle>
                          {item.stars ? (
                            <Badge variant="secondary" className="gap-1 text-[11px]">
                              <Star className="h-3 w-3 fill-foreground/70 text-foreground/70" />
                              <span>{item.stars}</span>
                            </Badge>
                          ) : null}
                        </div>
                        <div className="text-xs text-muted-foreground/75">
                          By {item.author} ·{" "}
                          <a
                            href={item.skillUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-0.5 text-primary hover:underline"
                          >
                            SkillsMP <ExternalLink className="h-2.5 w-2.5" />
                          </a>
                        </div>
                      </CardHeader>
                      <CardContent className="space-y-4 pt-0">
                        <p className="line-clamp-3 text-sm text-muted-foreground">
                          {item.description}
                        </p>
                        <div className="flex items-center justify-end pt-2">
                          <Button
                            type="button"
                            variant="default"
                            size="sm"
                            onClick={() => void installFromSkillsmp(item)}
                            className="gap-1.5 rounded-lg text-xs font-medium"
                          >
                            <Download className="h-3.5 w-3.5" />
                            <span>1-Click Install</span>
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      ) : null}

      {/* Sub-view: Import from URL or Raw Markdown */}
      {subTab === "import" ? (
        <div className="max-w-2xl space-y-6 pb-8">
          <div>
            <h3 className="text-base font-semibold text-foreground">
              Import Claude Agent Skill (SKILL.md)
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Import skills by pasting any web link (e.g. SkillsMP, GitHub repo, or raw SKILL.md
              link) or pasting raw markdown.
            </p>
          </div>

          <div className="space-y-4 rounded-xl border border-border/60 bg-card/40 p-5">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Option A: Skill URL or SkillsMP Link
              </div>
              <div className="mt-1.5 flex gap-2">
                <Input
                  value={importUrl}
                  onChange={(e) => setImportUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void fetchUrlContent(importUrl);
                  }}
                  placeholder="https://skillsmp.com/... or https://github.com/user/repo/... or raw link"
                  className="flex-1"
                />
                <Button
                  type="button"
                  variant="secondary"
                  disabled={fetchingUrl || !importUrl.trim()}
                  onClick={() => void fetchUrlContent(importUrl)}
                  className="shrink-0"
                >
                  {fetchingUrl ? "Fetching…" : "Fetch Content"}
                </Button>
              </div>
            </div>

            <div className="relative flex items-center justify-center">
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t border-border/50" />
              </div>
              <span className="relative bg-card px-3 text-xs font-medium uppercase text-muted-foreground">
                Or
              </span>
            </div>

            <div>
              <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Option B: Paste or Edit Raw SKILL.md Content
              </div>
              <div className="mt-1.5">
                <Textarea
                  rows={10}
                  value={importMarkdown}
                  onChange={(e) => setImportMarkdown(e.target.value)}
                  placeholder={`---\nname: my-skill\ndescription: How and when to use this skill.\n---\n\n# Steps\n...`}
                  spellCheck={false}
                  className="h-[260px] w-full resize-none font-mono text-[13px] leading-relaxed"
                />
              </div>
            </div>

            {/* Scope Selection */}
            <div className="pt-2">
              <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Skill Availability (Bot Scope)
              </div>
              <div className="mt-2 space-y-2.5">
                <label className="flex cursor-pointer items-center gap-2.5 text-sm">
                  <input
                    type="radio"
                    name="import-scope"
                    checked={importScopeGlobal}
                    onChange={() => setImportScopeGlobal(true)}
                    className="accent-primary"
                  />
                  <div>
                    <span className="font-medium text-foreground">
                      Global (Available to all bots)
                    </span>
                  </div>
                </label>

                <label className="flex cursor-pointer items-center gap-2.5 text-sm">
                  <input
                    type="radio"
                    name="import-scope"
                    checked={!importScopeGlobal}
                    onChange={() => setImportScopeGlobal(false)}
                    className="accent-primary"
                  />
                  <div>
                    <span className="font-medium text-foreground">
                      Per-Bot (Assign to specific bots only)
                    </span>
                  </div>
                </label>

                {!importScopeGlobal ? (
                  <div className="ml-6 mt-2 space-y-2 rounded-lg border border-border/40 bg-accent/30 p-3">
                    {bots.map((bot) => {
                      const checked = importScopeBotIds.some(
                        (id) =>
                          id.toLowerCase() === bot.id.toLowerCase() ||
                          id.toLowerCase() === bot.name.toLowerCase(),
                      );
                      return (
                        <label
                          key={bot.id}
                          htmlFor={`import-bot-${bot.id}`}
                          className="flex cursor-pointer items-center gap-2.5 text-sm"
                        >
                          <Checkbox
                            id={`import-bot-${bot.id}`}
                            checked={checked}
                            onCheckedChange={(val) => {
                              if (val) {
                                setImportScopeBotIds((prev) => [...prev, bot.id]);
                              } else {
                                setImportScopeBotIds((prev) =>
                                  prev.filter(
                                    (id) =>
                                      id.toLowerCase() !== bot.id.toLowerCase() &&
                                      id.toLowerCase() !== bot.name.toLowerCase(),
                                  ),
                                );
                              }
                            }}
                          />
                          <BotAvatar color={bot.color} identity={bot.id} size={20} />
                          <span className="font-medium text-foreground">{bot.name}</span>
                          {bot.title ? (
                            <span className="text-xs text-muted-foreground">({bot.title})</span>
                          ) : null}
                        </label>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            </div>

            <Button
              type="button"
              variant="default"
              disabled={
                importing ||
                (!importUrl.trim() && !importMarkdown.trim()) ||
                (!importScopeGlobal && importScopeBotIds.length === 0)
              }
              onClick={() => void executeImport()}
              className="gap-2 rounded-lg"
            >
              <Download className="h-4 w-4" />
              <span>{importing ? "Importing…" : "Import & Install Skill"}</span>
            </Button>
          </div>
        </div>
      ) : null}

      {/* Scope Settings Modal for Installed Skill */}
      {scopeModalSkill ? (
        <Dialog open={Boolean(scopeModalSkill)} onOpenChange={() => setScopeModalSkill(null)}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-lg">
                <Settings2 className="h-5 w-5 text-primary" />
                <span>Configure Bot Scope: {scopeModalSkill.name}</span>
              </DialogTitle>
            </DialogHeader>
            {error ? (
              <div role="alert" className="text-sm text-destructive">
                {error}
              </div>
            ) : null}

            <div className="space-y-4 pt-2">
              <div className="space-y-3">
                <label className="flex cursor-pointer items-center gap-2.5 text-sm">
                  <input
                    type="radio"
                    name="skill-scope-modal"
                    checked={scopeIsGlobal}
                    onChange={() => setScopeIsGlobal(true)}
                    className="accent-primary"
                  />
                  <div>
                    <span className="font-medium text-foreground">Global (All Bots)</span>
                  </div>
                </label>

                <label className="flex cursor-pointer items-center gap-2.5 text-sm">
                  <input
                    type="radio"
                    name="skill-scope-modal"
                    checked={!scopeIsGlobal}
                    onChange={() => setScopeIsGlobal(false)}
                    className="accent-primary"
                  />
                  <div>
                    <span className="font-medium text-foreground">Specific Bots Only</span>
                  </div>
                </label>

                {!scopeIsGlobal ? (
                  <div className="ml-6 space-y-2.5 rounded-xl border border-border/50 bg-accent/25 p-3.5">
                    {bots.map((bot) => {
                      const checked = scopeBotIds.some(
                        (id) =>
                          id.toLowerCase() === bot.id.toLowerCase() ||
                          id.toLowerCase() === bot.name.toLowerCase(),
                      );
                      return (
                        <label
                          key={bot.id}
                          htmlFor={`scope-bot-${bot.id}`}
                          className="flex cursor-pointer items-center gap-2.5 text-sm"
                        >
                          <Checkbox
                            id={`scope-bot-${bot.id}`}
                            checked={checked}
                            onCheckedChange={(val) => {
                              if (val) {
                                setScopeBotIds((prev) => [...prev, bot.id]);
                              } else {
                                setScopeBotIds((prev) =>
                                  prev.filter(
                                    (id) =>
                                      id.toLowerCase() !== bot.id.toLowerCase() &&
                                      id.toLowerCase() !== bot.name.toLowerCase(),
                                  ),
                                );
                              }
                            }}
                          />
                          <BotAvatar color={bot.color} identity={bot.id} size={20} />
                          <span className="font-medium text-foreground">{bot.name}</span>
                          {bot.title ? (
                            <span className="text-xs text-muted-foreground">({bot.title})</span>
                          ) : null}
                        </label>
                      );
                    })}
                  </div>
                ) : null}
              </div>

              <div className="flex justify-end gap-2 pt-3">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => setScopeModalSkill(null)}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  disabled={scopeSaving || (!scopeIsGlobal && scopeBotIds.length === 0)}
                  onClick={() => void saveScope()}
                >
                  {scopeSaving ? "Saving…" : "Save Scope"}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}

      {/* Marketplace Install Modal */}
      {installModalSkill ? (
        <Dialog open={Boolean(installModalSkill)} onOpenChange={() => setInstallModalSkill(null)}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-lg">
                <Sparkles className="h-5 w-5 text-primary" />
                <span>Install Skill: {installModalSkill.name}</span>
              </DialogTitle>
            </DialogHeader>
            {error ? (
              <div role="alert" className="text-sm text-destructive">
                {error}
              </div>
            ) : null}

            <div className="space-y-4 pt-1">
              <p className="text-sm text-muted-foreground">{installModalSkill.description}</p>

              <div>
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Scope & Bot Assignment
                </div>
                <div className="mt-2 space-y-2.5">
                  <label className="flex cursor-pointer items-center gap-2.5 text-sm">
                    <input
                      type="radio"
                      name="install-scope"
                      checked={installScopeGlobal}
                      onChange={() => setInstallScopeGlobal(true)}
                      className="accent-primary"
                    />
                    <div>
                      <span className="font-medium text-foreground">Global (All Bots)</span>
                    </div>
                  </label>

                  <label className="flex cursor-pointer items-center gap-2.5 text-sm">
                    <input
                      type="radio"
                      name="install-scope"
                      checked={!installScopeGlobal}
                      onChange={() => setInstallScopeGlobal(false)}
                      className="accent-primary"
                    />
                    <div>
                      <span className="font-medium text-foreground">Selected Bots Only</span>
                    </div>
                  </label>

                  {!installScopeGlobal ? (
                    <div className="ml-6 space-y-2 rounded-xl border border-border/50 bg-accent/25 p-3">
                      {bots.map((bot) => {
                        const checked = installScopeBotIds.some(
                          (id) =>
                            id.toLowerCase() === bot.id.toLowerCase() ||
                            id.toLowerCase() === bot.name.toLowerCase(),
                        );
                        return (
                          <label
                            key={bot.id}
                            htmlFor={`install-bot-${bot.id}`}
                            className="flex cursor-pointer items-center gap-2.5 text-sm"
                          >
                            <Checkbox
                              id={`install-bot-${bot.id}`}
                              checked={checked}
                              onCheckedChange={(val) => {
                                if (val) {
                                  setInstallScopeBotIds((prev) => [...prev, bot.id]);
                                } else {
                                  setInstallScopeBotIds((prev) =>
                                    prev.filter(
                                      (id) =>
                                        id.toLowerCase() !== bot.id.toLowerCase() &&
                                        id.toLowerCase() !== bot.name.toLowerCase(),
                                    ),
                                  );
                                }
                              }}
                            />
                            <BotAvatar color={bot.color} identity={bot.id} size={20} />
                            <span className="font-medium text-foreground">{bot.name}</span>
                          </label>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => setInstallModalSkill(null)}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  disabled={installing || (!installScopeGlobal && installScopeBotIds.length === 0)}
                  onClick={() => void installMarketplaceSkill()}
                  className="gap-1.5"
                >
                  <Download className="h-4 w-4" />
                  <span>{installing ? "Installing…" : "Confirm Install"}</span>
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}

      {/* Editor / Viewer Dialog with Fixed-Sizing Smooth Scrolling */}
      {activeSkill || isCreatingCustom ? (
        <Dialog
          open={Boolean(activeSkill || isCreatingCustom)}
          onOpenChange={() => {
            setActiveSkill(null);
            setIsCreatingCustom(false);
          }}
        >
          <DialogContent className="flex h-[90vh] w-[95vw] max-w-5xl flex-col overflow-hidden p-6 sm:max-w-5xl">
            <DialogHeader className="shrink-0 pb-2">
              <DialogTitle className="flex items-center gap-2 text-xl font-semibold">
                <BookOpen className="h-5 w-5 text-primary" />
                <span>
                  {isCreatingCustom
                    ? "New Skill (SKILL.md)"
                    : activeSkill?.readOnly
                      ? `View Recipe: ${activeSkill.name}`
                      : `Edit Skill: ${activeSkill?.name}`}
                </span>
              </DialogTitle>
            </DialogHeader>
            {error ? (
              <div role="alert" className="text-sm text-destructive">
                {error}
              </div>
            ) : null}

            <div className="flex flex-1 min-h-0 flex-col space-y-3 pt-1">
              <p className="shrink-0 text-xs text-muted-foreground">
                Agent skills follow the Claude Agent Skills standard with YAML frontmatter.
                Frontmatter supports custom keys including `bots: [id1, id2]` or `bots: [all]`.
              </p>

              <div className="flex flex-1 min-h-0 flex-col overflow-hidden rounded-xl border border-border/80 bg-background/50 shadow-inner">
                {/* Editor Header Bar */}
                <div className="flex shrink-0 items-center justify-between border-b border-border/40 bg-muted/30 px-3.5 py-1.5 text-[11px] text-muted-foreground">
                  <div className="flex items-center gap-2 font-mono">
                    <span className="font-semibold text-foreground/80">SKILL.md</span>
                    <span>•</span>
                    <span>{editorDraft.split("\n").length} lines</span>
                    <span>•</span>
                    <span>{editorDraft.length} chars</span>
                  </div>
                  {activeSkill?.readOnly ? (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                      Read-Only
                    </span>
                  ) : null}
                </div>

                <Textarea
                  value={editorDraft}
                  onChange={(e) => setEditorDraft(e.target.value)}
                  readOnly={Boolean(activeSkill?.readOnly)}
                  spellCheck={false}
                  className="h-full w-full flex-1 resize-none border-0 bg-transparent p-4 font-mono text-[13px] leading-relaxed outline-none shadow-none focus-visible:ring-0 select-text"
                />
              </div>

              <div className="flex shrink-0 items-center justify-between pt-2">
                <div>
                  {activeSkill && !activeSkill.readOnly ? (
                    deleteConfirmId === activeSkill.id ? (
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs text-muted-foreground">Delete this skill?</span>
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          onClick={() => void removeSkill(activeSkill.id)}
                        >
                          Confirm
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setDeleteConfirmId(null)}
                        >
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setDeleteConfirmId(activeSkill.id)}
                        className="text-destructive hover:bg-destructive/10"
                      >
                        <Trash2 className="mr-1.5 h-4 w-4" />
                        <span>Delete Skill</span>
                      </Button>
                    )
                  ) : null}
                </div>

                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setActiveSkill(null);
                      setIsCreatingCustom(false);
                    }}
                  >
                    {activeSkill?.readOnly ? "Close" : "Cancel"}
                  </Button>
                  {!activeSkill?.readOnly ? (
                    <Button
                      type="button"
                      variant="default"
                      size="sm"
                      disabled={editorSaving || !editorDraft.trim()}
                      onClick={() => void saveEditorContent()}
                    >
                      {editorSaving ? "Saving…" : "Save Skill"}
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
