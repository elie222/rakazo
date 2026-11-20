# 端到端跑通验证清单（1-2 天）

用一条样例需求把整条流水线走一遍。每步记录证据，卡住即修配置，不写代码。

## 准备（半天）

- [ ] 自托管/账户开启 Board（Labs 或 `TICKET_BOARD_ENABLED=true`）
- [ ] 导入 7 个 bot（`coordinator/pm/po/dev/reviewer/qa/ops`）：Settings → General → Import an agent → Grok Bot → 选 `import/agent-factory-export.json`，逐个导入；Instructions 已含在导入文件里
- [ ] 建群聊，把 5 个 bot 加入；账号审批模式设 `Auto` + 审批模型
- [ ] 建技能池 5 个技能（`skills.md`）
- [ ] 启用 6 条 routine（导入后默认暂停，`routines.md`）；GitHub 仓库配好 webhook
- [ ] 配置 `dev`/`qa`/`ops` 的沙箱电脑与仓库访问；`ops` 配部署凭证（Vault 类机制）
- [ ] 按 `skills.md` 权限预设禁用/Block 各 bot 的越权工具

## 主线跑通（1 天）

1. 在 Board 建一张样例票（用 `board.md` 模板，写一个真实小需求）
2. **门禁 1**：等 PO routine 扫板 → 票上出现规格+检查清单 → 收到规格批准卡 → 人工批准 → `coordinator` 指派 `dev`、移 `doing`
3. **开发**：`dev` 在沙箱完成实现与自测 → 提出 PR → 票移 `review`
4. **评审**：GitHub webhook 唤醒 `reviewer` → 评审通过、CI 绿 → @qa
5. **验收**：`qa` 跑验收 → 报告绿灯 → 票移 `done`
6. **门禁 2**：收到上线批准卡 → 人工批准 → `ops` 部署 + 健康检查 → 变更说明回写 → 票移 `closed`

## 异常路径（半天）

- [ ] 让 `dev` 提交一个带失败的变更 → 验证 `reviewer`/`qa` 能把它打回返工，流程回到 `review`
- [ ] 人为制造一个卡点（如环境不可用）→ 验证 bot 转 `blocked` 并触发**门禁 3**（人工决策）
- [ ] 验证非 `ops` bot 尝试部署会被 Block/审批拒绝

## 验收标准

- 一条需求从建票到 `closed`，**人类只按了两次批准**（规格、上线），外加一次异常决策演练。
- 全程可追踪：票评论链上有规格、PR、评审结论、验收报告、部署证据。
- 未写一行 Rakazo 内核代码。

## 常见卡点速查

| 现象                 | 原因                     | 处理                                    |
| -------------------- | ------------------------ | --------------------------------------- |
| 新票无人处理         | PO routine 未建/未开     | 检查 routine 是否启用与所属 bot         |
| 规格卡不弹           | 审批模式/模型未配        | 检查 Settings → Approvals               |
| PR 不触发评审        | webhook 未配/secret 不符 | 检查仓库 webhook 与 git event routine   |
| bot 卡住不转 blocked | 指令里 SOP 未生效        | 检查 Instructions 是否粘贴完整          |
| dev 缺仓库访问       | 沙箱未配置               | 给 dev 配置仓库凭证，只存空间连接/Vault |
