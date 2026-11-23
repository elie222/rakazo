#!/usr/bin/env node
// Builds a grok-bot-export v1 document (see packages/core/src/agent-import/grok-bot.ts
// in Rakazo) from the kit sources:
//   - bots/<name>.md      -> bot instructions (kept in sync via ## 使命 section)
//   - skills/<name>.skill.md -> skill body (frontmatter name/description read, body embedded)
// Output: agent-factory-export.json, importable in Settings → General →
// Import an agent → Grok Bot → Choose file.
//
// No hardcoded environment values:
//   - timezone: AGENT_FACTORY_TZ, else the system timezone
//   - cron defaults live in SCHEDULE and are overridable per env (SCHEDULE_COORDINATOR etc.)
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Default cadence; override per role with SCHEDULE_<ROLE> env before generating. */
const SCHEDULE = {
  coordinator: "*/5 * * * *",
  pm: "0 */6 * * *",
  po: "*/15 * * * *",
  ops: "*/30 * * * *",
};

const readInstructions = (name) => {
  const markdown = readFileSync(join(root, "bots", `${name}.md`), "utf8");
  const start = markdown.indexOf("## 使命");
  if (start < 0) throw new Error(`bot ${name}: no ## 使命 section`);
  return markdown.slice(start).trim();
};

/** Minimal SKILL.md reader: frontmatter holds single-line name/description; rest is body. */
const readSkill = (fileName) => {
  const content = readFileSync(join(root, "skills", `${fileName}.skill.md`), "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(content);
  if (!match) throw new Error(`skill ${fileName}: missing frontmatter`);
  const frontmatter = Object.fromEntries(
    match[1]
      .split("\n")
      .map((line) => /^(\w+):\s*(.+)$/.exec(line))
      .filter(Boolean)
      .map(([, key, value]) => [key, value].map((part) => part.trim())),
  );
  if (!frontmatter.name || !frontmatter.description) {
    throw new Error(`skill ${fileName}: frontmatter needs name + description`);
  }
  return {
    name: frontmatter.name,
    description: frontmatter.description,
    instructions: match[2].trim(),
  };
};

const timeZone =
  process.env.AGENT_FACTORY_TZ?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone;
const schedule = (role) => process.env[`SCHEDULE_${role.toUpperCase()}`]?.trim() || SCHEDULE[role];

const bots = [
  {
    export_id: "agent-factory-coordinator",
    name: "coordinator",
    title: "流程调度员（Agent Factory）",
    description: "唯一流程所有者：扫板推进、停滞升级，只调度不下场",
    instructions: readInstructions("coordinator"),
    memories: [],
    user_facts: [],
    skills: [],
    routines: [
      {
        name: "Coordinator 扫板",
        instruction:
          "扫描 Board 全部列，按推进表逐票决策（todo 规格已批准→指派 dev 并移到 doing；doing/review/done 超时→@责任人追问或转 blocked+升级人类；blocked→群聊@人类说明卡点）。每个决定：更新票（指派/移列/评论结论）+ 群聊@责任人，两条消息保持一致。你只调度，不写码、不部署、不下业务结论。",
        trigger: "schedule",
        schedule_cron: schedule("coordinator"),
        schedule_text: "every 5 minutes",
        timezone: timeZone,
        skills: [],
        trigger_details: "",
      },
    ],
    apps: [],
  },
  {
    export_id: "agent-factory-pm",
    name: "pm",
    title: "产品经理（Agent Factory）",
    description: "管 backlog、优先级、路线图与需求仲裁，不写规格不写码",
    instructions: readInstructions("pm"),
    memories: [],
    user_facts: [],
    skills: [],
    routines: [
      {
        name: "PM backlog 治理",
        instruction:
          "扫描 Board 的 todo 列：按价值/风险/依赖为每张票标记优先级并写排序理由；价值不明确的票向人类确认是否要做（门禁 0）。不做实时调度，不写规格。",
        trigger: "schedule",
        schedule_cron: schedule("pm"),
        schedule_text: "every 6 hours",
        timezone: timeZone,
        skills: [],
        trigger_details: "",
      },
    ],
    apps: [],
  },
  {
    export_id: "agent-factory-po",
    name: "po",
    title: "产品负责人（Agent Factory）",
    description: "需求初审、规格化、请求批准，只拍板不写码",
    instructions: readInstructions("po"),
    memories: [],
    user_facts: [],
    skills: [readSkill("requirement-spec")],
    routines: [
      {
        name: "PO 扫板",
        instruction:
          "扫描本空间 Board 的 todo 列。按优先级取最旧一张未处理票：1) 没有规格的票 → 按技能 requirement-spec 产出规格与检查清单贴到票上；2) 规格不完整 → 回复提问澄清保持 todo；3) 规格完整 → 贴「规格批准」审批卡，批准后由 coordinator 指派 dev。没有可处理的票就结束，不输出。",
        trigger: "schedule",
        schedule_cron: schedule("po"),
        schedule_text: "every 15 minutes",
        timezone: timeZone,
        skills: ["requirement-spec"],
        trigger_details: "",
      },
    ],
    apps: [],
  },
  {
    export_id: "agent-factory-dev",
    name: "dev",
    title: "开发工程师（Agent Factory）",
    description: "拿到已批准规格，在沙箱实现、自测、提 PR",
    instructions: readInstructions("dev"),
    memories: [],
    user_facts: [],
    skills: [],
    routines: [],
    apps: [],
  },
  {
    export_id: "agent-factory-reviewer",
    name: "reviewer",
    title: "代码评审工程师（Agent Factory）",
    description: "PR 评审、CI 检查、返工把关，通过才放行",
    instructions: readInstructions("reviewer"),
    memories: [],
    user_facts: [],
    skills: [readSkill("pr-review")],
    routines: [
      {
        name: "Reviewer 评审",
        instruction:
          "收到 PR 事件后：1) 找到对应票（PR 描述或分支名含票号/标题）；2) 按技能 pr-review 评审：检查 DoD、跑规定检查命令、审 diff；3) 有问题 → 在 PR 评论列出 issue，@dev 返工，票保持 review；4) 通过且 CI 绿 → 票上留结论，@qa 触发验收。",
        trigger: "github",
        schedule_cron: "",
        schedule_text: "GitHub pull_request events",
        timezone: timeZone,
        skills: ["pr-review"],
        trigger_details:
          "pull_request events on the delivery repository (fill the repository URL when enabling this routine)",
      },
    ],
    apps: [],
  },
  {
    export_id: "agent-factory-qa",
    name: "qa",
    title: "测试工程师（Agent Factory）",
    description: "独立验证、跑验收、出报告，绿灯才是可上线证据",
    instructions: readInstructions("qa"),
    memories: [],
    user_facts: [],
    skills: [readSkill("acceptance-run")],
    routines: [
      {
        name: "QA 验收",
        instruction:
          "收到「评审通过/CI 完成」信号后：1) 在沙箱按技能 acceptance-run 运行测试与冒烟；2) 出验收报告贴到票上；3) 红灯 → 列失败项，票保持 review，@dev 返工；4) 绿灯 → 票移到 done，@ops 部署并贴「上线批准」审批卡。",
        trigger: "webhook",
        schedule_cron: "",
        schedule_text: "CI completion webhook",
        timezone: timeZone,
        skills: ["acceptance-run"],
        trigger_details:
          "CI completion callback; POST the URL and key from this trigger to the delivery pipeline",
      },
    ],
    apps: [],
  },
  {
    export_id: "agent-factory-ops",
    name: "ops",
    title: "交付运维（Agent Factory）",
    description: "唯一被授权部署的角色：发布、健康检查、变更说明",
    instructions: readInstructions("ops"),
    memories: [],
    user_facts: [],
    skills: [readSkill("deploy-sop"), readSkill("change-doc")],
    routines: [
      {
        name: "Ops 巡检",
        instruction:
          "对每张处于 done 的票：1) 按技能 deploy-sop 做前置检查并发布；2) 验证健康检查，把部署日志链接贴到票上；3) 按技能 change-doc 产出变更说明，票移到 closed。",
        trigger: "schedule",
        schedule_cron: schedule("ops"),
        schedule_text: "every 30 minutes",
        timezone: timeZone,
        skills: ["deploy-sop", "change-doc"],
        trigger_details: "",
      },
    ],
    apps: [],
  },
];

const document = { format: "grok-bot-export", version: 1, bots };
const output = join(dirname(fileURLToPath(import.meta.url)), "agent-factory-export.json");
writeFileSync(output, `${JSON.stringify(document, null, 2)}\n`);
console.log(`Wrote ${output} (${bots.length} bots, tz=${timeZone})`);
