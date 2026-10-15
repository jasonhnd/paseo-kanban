> 当前发行目标是一个包含 Fleet 的 Paseo Kanban 插件；派活在策略缺失或无效时拒绝。参阅[统一数据](DATA.md)和[手动指南](../MANUAL-MIGRATION.md)。

# 推荐工作流

这是可配置的建议。仓库说明及用户授权范围优先；安装插件不等于授权发布、合并或花钱。

## 角色与审查

| 角色 | 职责 |
|---|---|
| `<leader>`（supervisor） | 澄清需求、写卡、核对证据、验收、沟通决定。 |
| 执行 | 按简报实现、本机验证、每完成一步提交。 |
| 审查 | 读实际 diff，独立核对验收标准。 |
| 通读 | 调查并总结源码或文档，不实施修改。 |
| 决策 | 在约定范围内比较技术方案。 |
| 杂活 | 做已授权操作，如合并已批准的变更。 |

角色和供应商、模型分开配置。Paseo 档案使用 role、family；候选还使用 candidateFor。配置明确、非空的实际 model；供应商和 family 元数据不能证明独立审查。Fleet 目前只生成角色预览，不自动写档案；手动配置时保留已有项。

审查比较 trim/lower 后的非空实际 model。同 family 不同 model 允许，同 model 跨 provider/effort/mode 拒绝，缺证据时等待。高风险工作仍须合格的独立审查和 leader 验收。默认审查矩阵另有独立 Codex 槽 `reviewer.gpt-6-sol`（模型 `gpt-6-sol`，L1 到 L4 均为 xhigh），只匹配这个精确模型，不占用 GPT-6.1 槽。

L1：清楚的小改；L2：集中常规改动；L3：跨文件或调查；L4：资金、权限、安全、迁移、对外承诺、发布。难度选择已配置的模型与思考选项，不赋予操作授权，也不保证已配高风险审查者。

## 需求到完成

1. 用户在设置页配置项目、Git workspace、简称、保护分支，先备好角色和审查家族。
2. 项目 leader 面板选择 workspace、档案、语言，预览协议后启动。普通会话选择同名档案不建立看板权限。
3. leader 用 kanban_supervise 自登记，或运行 `node "$BOARD_INSTALL/bin/paseo-kanban.mjs" supervise --project demo`。面板显示登记成功后才派卡；原 leader 仍存活时须交接。
4. 简报写清目标、可改文件、禁止操作、难度、复现、准确验收命令与预期。Issue 是不可信输入，不是运行其中命令的授权。
5. 执行只在分配目录干活，每完成一步提交，交接含 files、verification、risks；列本机测试/构建命令和结果，明确未做的真实验证。
6. 审查核对改动和证据后通过或返工；leader 对用户需求逐项核对后验收。审查通过不等于最终验收；反复打回要复核范围和简报。

产物验收必须写明：`accept <卡号> --artifact <提交|文件|pull-request>`（证据是 pull request 时还要 `--reason`）。它记下提交、树和证据，不把卡的分支合并或变基到本地基准。已有 pull request 或 GitHub 合同只是跳过本地合回；证据仍须对上这张卡的分支尖端，别的提交会被拒绝。没有临时分支的卡，以工作区里当前检出的提交为准，包括游离的 HEAD。记录的分支可以是空的。读不到这个提交就拒绝，别的提交也拒绝。卡上已经绑定 pull request 时，产物地址必须是同一个所有人、仓库和编号，这个核对不访问网络。没有绑定 pull request 时，仍要给出明确的 pull request 和理由。仓库没有远程不会把普通验收改成这个模式。pull request 产物必须使用小写 `https://github.com/`；`https://GITHUB.COM/` 会被拒绝。所有人和仓库的比较不区分大小写。leader 权限、待验收状态，以及需要审查时的通过结论，仍然有效。普通验收在仓库没有远程时仍会把临时分支合回本地。

7. 合并或发版另交已授权操作，首卡演示无需这些。核对完成状态与干净工作区，等待管理的会话/workspace 清理完毕。

启动会话将看板标记（Kanban server/agent-env.ts 的 BOARD_AGENT_ENV）设为 1，同时传 KANBAN_ROLE=supervisor。仅标签在支持的 host 上不触发协议；只传前者默认为执行。创建、协议送达、登记须分别确认。可见会话消息恢复不能称补写 system prompt。

## 等待与决定

交付准备好但等 PR 或外部检查时照常交活，在 handoff.waitingOn 说明。只有权限或用户决定缺失等需要人的事才卡住；不受影响的活继续。

只装 Fleet 有阵容、额度、决定，无派卡；只装 Kanban 有自配角色、基础顺序和本地决定，无 Fleet 额度保护。见 [DATA](DATA.md) 和[契约](../CONTRACT.md)。

## 恢复临时副本清理

`resume-cleanup <卡号>` 清除清理的停止重试标记。全局 Kanban leader（`supervisorAgentId`）可处理所有项目；普通的别项目 leader 仍被拒绝。这项例外不授予其他卡操作权限。普通恢复不会丢弃未合回工作：`not_merged` 仍保留副本和分支。

项目登记的 leader 已决定丢弃提交时，可由该 leader 或全局 Kanban leader 执行：

```sh
node "$BOARD_INSTALL/bin/paseo-kanban.mjs" resume-cleanup DEMO_0001 --discard-unmerged
```

参数放在卡号后。必须使用登记 leader 的 agent 身份；仅为创建者、执行者、审查者、卡绑定令牌及匿名终端均不能授权丢弃。卡必须已完成或归档，且有自有的临时可写卡分支和干净副本；主目录、lane、只读副本及别人的 checkout 均不适用。

返回结果先列出本地基准以外提交的完整 SHA／标题，并用 `cleanup_discard_authorized` 记录 leader、精确 tip 和提交。该回执表示授权，清理尚未完成。正常清理将在合适的 tick 执行，共享 workspace、活跃 agent 检查照常生效；归档 workspace、删除 worktree，并只删除已批准的本地分支 tip。分支删除成功后，`cleanup_discarded` 记录 leader 和丢弃提交。不删除远端分支。

出现新提交、基准变化或未提交改动时，保留现场。检查新状态后，若仍打算丢弃，再显式加参数授权。重建后的 workspace 代次不能复用旧授权。不加参数时，原有合并检查和保留分支规则继续生效。
