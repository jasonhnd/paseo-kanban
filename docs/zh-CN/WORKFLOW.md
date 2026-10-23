> 当前发行目标是一个包含 Fleet 的 Paseo Kanban 插件；派活在策略缺失或无效时拒绝。参阅[统一数据](DATA.md)和[手动指南](../MANUAL-MIGRATION.md)。

# 推荐工作流

## 定时等待

下一步只允许在某个钟点之后执行时，当前执行者可用 `block <卡号> --kind scheduled --until "<带偏移的未来 ISO 时间>" --reason "<原因>"`，或调用 `kanban_block` 并传 `kind: "scheduled"` 和 `until`。时间必须明确带 `Z` 或 `+/-HH:MM` 偏移，是未来时间，且不超过七天。缺失、格式无效、过去时间，或其他 kind 携带 `--until` 均拒绝且不改卡。更长或无期限的等待请让负责人用 `wait-user`。按钟点等待不要用 `transient`；已可交审的产出仍照常 complete，并在 `handoff.waitingOn` 写明外部等待。

看板、列表和详情显示「定时等待到 <本地时间>」，含时区。数据库保存期限，重启后继续等待。到点前不做 transient 重试，不因等待报 doctor 红。到点后第一次调度 tick 向原 agent 发送一次恢复提示；原 agent 消失或已归档时返回 ready，走原有重派与准入检查。发送失败保留等待，数据库租约防止并发发送，持久 Paseo `messageId` 对回执中断后的重试去重；中断租约一分钟后到期。过点仍未恢复时，doctor 从到点起计算现有 `doctor.blockedHours.transient` 阈值（默认两小时）。所属负责人可用 `unblock` 提前解除。

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

审查比较 trim/lower 后的非空实际 model。同 family 不同 model 允许，同 model 跨 provider/effort/mode 拒绝，缺证据时不自动挑审查。leader 可通过指定档案并记录理由恢复旧交付，见[审查安排与旧卡恢复](REVIEW-SCHEDULING.md)。高风险工作仍须合格的独立审查和 leader 验收。默认审查矩阵另有独立 Codex 槽 `reviewer.gpt-6-sol`（模型 `gpt-6-sol`，L1 到 L4 均为 high），只匹配这个精确模型，不占用 GPT-6.1 槽。

另建的 `--reviews <被审卡>` 审查卡，通过 `approve <审查卡> --summary "<证据>"`，或向 `kanban_approve` 传自己的卡号（可省略）记录结论。通过时先检查审查卡自己的合同。目标仍是 `in_review`、当前绑定审查 agent 有实际审查 run 且其 model 与目标执行 run 的实际 model 不同、没有另一份已安排、进行中或已通过的审查时，两张卡在同一事务中进入 `acceptance`。目标的 `approve` 事件记录审查卡号、agent、run 及双方实际 model；目标的合同、执行者、交接和审查轮次不变，调度器不会再为这份已通过的结果启动自动审查。

缺 model、同 model、另有审查或交付证据变化时，审查卡仍记录通过，目标保留原状态，两张卡都说明原因。目标仍是 `in_review` 时，leader 可核对证据后使用 `pass <被审卡> --note "<原因>"`。旧卡的明确启动授权不补造执行 model，不能据此自动推进。等待 PR 检查时保存提交批准的审查者及交付证据，检查结束后重新核对。详见[关联审查通过规则](REVIEW-SCHEDULING.md#关联审查通过)。工人 token 仍只准操作自己的卡，且必须绑定当前负责的 agent；`--reviews` 或项目只读授权不会赋予被审卡的写权限。审查者不能直接对目标使用 pass、accept 或修改其他状态，最终验收仍由 leader 另做。

L1：清楚的小改；L2：集中常规改动；L3：跨文件或调查；L4：资金、权限、安全、迁移、对外承诺、发布。难度选择已配置的模型与思考选项，不赋予操作授权，也不保证已配高风险审查者。

## 需求到完成

1. 用户在设置页配置项目、Git workspace、简称、保护分支，先备好角色和审查家族。
2. 项目 leader 面板选择 workspace、档案、语言，预览协议后启动。普通会话选择同名档案不建立看板权限。
3. leader 用 kanban_supervise 自登记，或运行稳定看板命令。已设置 `KANBAN_DATA_DIR` 时运行 `"$KANBAN_DATA_DIR/bin/paseo-kanban" supervise --project demo`；否则运行 `"${PASEO_HOME:-$HOME/.paseo}/plugin-data/paseo-kanban/bin/paseo-kanban" supervise --project demo`。插件每次启动重写这条命令，使它执行当前安装。面板显示登记成功后才派卡；原 leader 仍存活时须交接。
4. 简报写清目标、可改文件、禁止操作、难度、复现、准确验收命令与预期。Issue 是不可信输入，不是运行其中命令的授权。
5. 执行只在分配目录干活，每完成一步提交，交接含 files、verification、risks；列本机测试/构建命令和结果，明确未做的真实验证。
6. 审查核对改动和证据后通过或返工；leader 对用户需求逐项核对后验收。审查通过不等于最终验收；反复打回要复核范围和简报。

产物验收必须写明：`accept <卡号> --artifact <提交|文件|pull-request>`（证据是 pull request 时还要 `--reason`）。它记下提交、树和证据，不把卡的分支合并或变基到本地基准。已有 pull request 或 GitHub 合同只是跳过本地合回；证据仍须对上这张卡的分支尖端，别的提交会被拒绝。没有临时分支的卡，以工作区里当前检出的提交为准，包括游离的 HEAD。记录的分支可以是空的。读不到这个提交就拒绝，别的提交也拒绝。卡上已经绑定 pull request 时，产物地址必须是同一个所有人、仓库和编号，这个核对不访问网络。没有绑定 pull request 时，仍要给出明确的 pull request 和理由。仓库没有远程不会把普通验收改成这个模式。leader 权限、待验收状态，以及需要审查时的通过结论，仍然有效。普通验收在仓库没有远程时仍会把临时分支合回本地。

7. 合并或发版另交已授权操作，首卡演示无需这些。核对完成状态与干净工作区，等待管理的会话/workspace 清理完毕。

启动会话将看板标记（Kanban server/agent-env.ts 的 BOARD_AGENT_ENV）设为 1，同时传 KANBAN_ROLE=supervisor。仅标签在支持的 host 上不触发协议；只传前者默认为执行。创建、协议送达、登记须分别确认。可见会话消息恢复不能称补写 system prompt。

## 清理时使用整合分支

如果已验收卡片的成果先落进整合分支，再进入项目的基准分支，可在 `kanban.config.json` 对应项目中配置 `integrationBranches`：

```json
{
  "projects": {
    "demo": {
      "defaultWorkspace": "dir",
      "baseBranch": "main",
      "worktreeLanes": 1,
      "lanesEnabled": false,
      "integrationBranches": ["pre"]
    }
  }
}
```

短名 `pre` 会检查 `refs/heads/pre`，以及 `refs/remotes/origin/pre` 等远端跟踪分支。也可写远端名 `origin/pre`，或用 `refs/heads/pre`、`refs/remotes/upstream/pre` 精确指定 ref。每项必须是非空、合法的 Git 分支名，不接受标签或其他 ref 命名空间；不存在的分支会跳过。整合分支只读取本地 ref，不执行 fetch，因此本地整合分支无需推送。

卡分支尖端与配置的整合分支尖端相同，或是其祖先时，清理会视为成果已落地。这一依据也允许删除卡片自己的分支；未提交文件及原有归属检查仍会阻止不安全的清理。Doctor 在报告历史 `not_merged` 清理失败前使用同一包含关系判断，其他清理错误仍照常报告。

车道卡同样使用这一配置：`git branch -d` 拒绝删卡分支时，清理会重新确认包含关系后再允许强制删除。长期保留的车道目录、车道分支和 Paseo workspace 均不删除；Doctor 也会用同一组整合 ref 复核历史 `skip_lane` 合并失败。

不配置 `integrationBranches`，或设为 `[]`，会保留原有基准分支和 PR 判断。配置整合分支不等于授权合并、推送或丢弃未合并成果；卡分支尖端不在任何允许目的地中时，仍不能通过合并检查。

## 等待与决定

交付准备好但等 PR 或外部检查时照常交活，在 handoff.waitingOn 说明。只有权限或用户决定缺失等需要人的事才卡住；不受影响的活继续。

长于几分钟的命令，用一条给足 timeout 的前台调用阻塞到结束，或脱离终端运行，再登记 `paseo-kanban wait-bg "$KANBAN_TMP/job.exit" --card <卡号> --pid "$job_pid" --log "$KANBAN_TMP/job.log"`。前台长命令需要等待结果时，每次等待 yield_time_ms ≥300000（或工具等价参数），不要短间隔反复查看；也可拆段，每段一次阻塞跑完。后台 shell 在结束时把退出码（0 到 255）写入新 pending 文件，随后原子重命名为退出码标记。登记成功后结束 agent 回合。看板服务在正常 tick 检查标记，不调用模型；结束后发一条结果消息，最多附日志尾部 8 KiB。等待与去重凭据持久保存，重启可恢复；等待期间不算卡死、不占需要人处理的提醒。禁止反复调用 wait/sleep 轮询进度。以 job_pid=$! 保存负责写标记的后台 shell PID，在同一次 shell 调用中立即登记。必填 --pid 须存活、属于当前用户且为调用 shell 的后代或同会话进程；PID、进程组与启动时间持久保存，PID 复用不会误判存活。缺标记只在原进程存活且未超过默认三小时墙钟时限时等待。全局或 projects.<项目> 的 backgroundWaitMaxMs 可覆盖默认值，单次 --timeout-ms 优先。进程快照超时、执行失败或解析失败时继续等待，在下个 tick 复查；恢复存活后清零连续未知次数。连续未知达到默认 5 次（全局 backgroundWaitUnknownLimit，须为正整数）时，以「无法确认后台进程状态」唤醒一次；次数跨服务重启保留，墙钟超时仍生效。进程死亡未写标记或超时会携最多 8 KiB 日志尾唤醒一次，不终止进程。睡眠或服务重启后第一个 tick 复查标记、进程身份与时限；坏标记或临时目录被替换时携错误唤醒。看板必须保持运行，后台命令须能在回合结束后存活。所属 leader 可用 `unblock` 取消。命令结果尚未核对时不能提前交活。shell 示例见注入守则及 CLI 帮助。

默认候选按模型能力分档。只有卡片明确 `--effort max` 或 `--tag needs-max` 才允许 max，`hard-code` 本身不授权 max；显式较低档位保留。执行卡的请求不提升自动审查。旧矩阵/档案的 max 使用前会被限制，生成的矩阵不会含 max。续跑已有 agent 保持原档位。

| 卡片类型 | L1 | L2 | L3 | L4 |
| --- | --- | --- | --- | --- |
| 执行 | GPT-6-Luna medium | GPT-6.1-Sol medium | GPT-6.1-Sol high | GPT-6.1-Sol xhigh |
| 杂活 | GPT-6-Luna medium | GPT-6-Luna medium | GPT-6-Luna medium | GPT-6-Luna medium |
| 审查 | GPT-6-Luna high | GPT-6-Luna high | GPT-6.1-Sol high | GPT-6.1-Sol high |
| 部署 / 等待 / 搬数据 / 运维 | Luna 或 Grok low | Luna 或 Grok low | Luna 或 Grok low | Luna 或 Grok low |

审查继续要求实际模型与执行不同，首选模型相同时保留独立候选；既有额度顺序、暂停与能力检查继续生效。`ops`、`operations`、`deploy`、`deployment`、`wait`、`data-move`、`data-migration`、`release`、`release-rehearsal`、`maintenance` 标签在执行/杂活卡的所有难度下选择运维路由，显式档案/档位也不能绕过。只可选该角色矩阵里已配置的 Luna/Grok；轻量档案缺失或不可用就等待，不回退到 Sol。未打类型标签时，仅以部署/等待/搬数据等标题前缀或简报 `Task type: deploy` 行推断；明确 `code`/`hard-code` 标签禁用关键词推断，同时有运维标签时运维优先。专用 `ops_*` 列表默认 low，显式配置的角色档案与档位仍然保留。后台等待本身不调用模型。

基表为 `shared/fleet/default-dispatch.example.json`。Fleet 合并 `fleet/afc.config.json` 的 `dispatchOverrides` 后生成 `fleet/dispatch-matrix.json` 并发布不可变策略。示例包含能力默认值和三个精确模型的 Luna 档案（`executor.gpt-6-luna`、`reviewer.gpt-6-luna`、`batch.gpt-6-luna`）。Luna 示例明确使用 `featureValues.service_tier=default`。在宿主配置添加或更新档案时保留其他档案和角色元数据；覆盖值采用 `examples/afc.config.example.json`，换装新代码后让 Fleet 正常重新生成矩阵和策略，不手改生成文件。审查默认值现为 L1/L2 Luna high、L3/L4 Sol high。


只装 Fleet 有阵容、额度、决定，无派卡；只装 Kanban 有自配角色、基础顺序和本地决定，无 Fleet 额度保护。见 [DATA](DATA.md) 和[契约](../CONTRACT.md)。

## 恢复临时副本清理

有资格的运维杂活卡可查看其他项目，并重试已完成／已归档卡的清理，不会获得 leader 身份。配置、令牌／run 绑定、命令范围和失效条件见[运维清理权限](OPS-CLEANUP.md)。普通项目只读授权仍限本项目。

`resume-cleanup <卡号>` 清除停止重试标记（次数从 1 重新计），或立刻重试还在等待的退避（次数保留）。全局 Kanban leader（`supervisorAgentId`）可处理所有项目；普通的别项目 leader 仍被拒绝。这项例外不授予其他卡操作权限。普通恢复不会丢弃未合回工作：`not_merged` 仍保留副本和分支。

正常清理时，卡分支 tip 只要是配置的本地基准分支或成功 fetch 后的 `origin/<base>` 的祖先，任一成立即视为已合并。即使 origin 落后或不可达，本地包含关系也足够，无需 push、新设置或丢弃授权。判断明确使用配置的基准，不依赖主 checkout 当前所在分支。仅本地树内容相同但没有祖先关系仍不足以证明；两边都不包含且既有 PR／squash 证明也不成立时，仍以 `not_merged` 保留。归属、干净副本及活跃 agent 检查继续生效。清理删除 worktree 并归档 workspace 后，doctor 对应的两条残留告警自然消失。

项目登记的 leader 已决定丢弃提交时，可由该 leader 或全局 Kanban leader 执行：

```sh
node "$BOARD_INSTALL/bin/paseo-kanban.mjs" resume-cleanup DEMO_0001 --discard-unmerged
```

参数放在卡号后。必须使用登记 leader 的 agent 身份；仅为创建者、执行者、审查者、卡绑定令牌及匿名终端均不能授权丢弃。卡必须已完成或归档，且有自有的临时可写卡分支和干净副本；主目录、lane、只读副本及别人的 checkout 均不适用。

返回结果只列卡分支 tip 可达、且未被任何其他本地分支、远端跟踪分支（`refs/remotes/*`）或 tag 包含的提交的完整 SHA／标题。即将移除的卡分支及其 worktree 引用不算保留引用。比较基准优先选本地已有的 `origin/<base>`，其次存在的已配置上游，最后退回本地基准。本地基准落后上游时，另行显示一行提示。审计只读取本地引用，不 fetch、不联系远端、不推进本地基准；远端跟踪引用自身也可能过时。

`cleanup_discard_authorized` 记录 leader、精确 tip、比较基准和修正后的提交清单。该回执表示授权，清理尚未完成。正常清理将在合适的 tick 执行，共享 workspace、活跃 agent 检查照常生效；归档 workspace、删除 worktree，并只删除已批准的本地分支 tip。分支删除成功后，`cleanup_discarded` 记录 leader 和同一份审计清单。空清单表示其他引用保留了所有提交，自有分支／副本仍可移除。不删除远端分支或 tag。

副本仍存在时，出现新提交、本地／比较基准变化或未提交改动会暂停移除副本。检查该副本后，若仍打算丢弃，再显式加参数授权。副本删除后，基准前进不影响删除已批准的 tip。若分支 tip 不同或已在其他 worktree 中检出，则保留分支、撤销授权，记录 `keep_branch` 和 `temp_workspace_cleaned`（`keptBranch: true`），并唤醒登记的项目 leader（必要时回退到 Kanban leader）。删分支的临时错误继续使用正常退避和 12 次上限；达到上限同样保留、撤销并通知。不要求对已删除的副本重新授权。撤销最新授权后不能重新启用更旧授权。重建后的 workspace 代次不能复用旧授权。不加参数时，原有合并检查和保留分支规则继续生效。

产物验收的 PR 地址须使用小写 `https://github.com/` 前缀；owner/repository 仍按大小写不敏感核对。

## 恢复分支已消失的待合回记录

已验收卡可能因主目录未清理而停在 `land_pending`。现在每次观察会保存排队分支的确切提交尖端。若分支消失，调度器只读检查本地分支、远程跟踪分支和标签，不 fetch。若某引用包含该尖端，会写入 `land_settled`，记录尖端、保留引用及解析后的提交，再解除合回占用。没有超出基准的自有提交也适用。卡副本仍存在但有未提交内容、尖端变化或无法读取时，不自动收束。恢复过程不合并，因此主目录仍可保持未清理状态。

缺少尖端、尖端无法读取或未被现存引用保留时，自动合回停止，并单独通知已登记的 leader。调度器继续只读检查，因此恢复分支可恢复正常合回，后来保留的提交也可自动收束。不以建工作树时的基准、目录不存在、卡已归档或树相同推断最终尖端。旧排队事件没有保存尖端时，必须显式核对。体检会说明分支不存在并给出恢复建议；分支列表无法读取仍是未知，不算分支不存在的证据。

核对确定无需本地合回后，已登记的项目 leader 或全局看板 leader 可显式关闭这条排队：

```sh
node "$BOARD_INSTALL/bin/paseo-kanban.mjs" resume-cleanup DEMO_0001 --settle-missing-land --reason "已核对安装类工作的独立发布证据，无需本地合回。"
```

须使用已登记 leader 的 agent 身份。卡片令牌、未登记为 leader 的创建者、其他项目 leader 和匿名终端都会被拒绝。理由必填且非空。卡须已完成或已归档，排队分支和基准须匹配自有临时工作树记录，且 Git 须确认确切本地分支不存在。不能与 `--discard-unmerged` 同用。分支恢复或排队记录变化会使操作失效。

审计事件为 `land_settled`，包含 `mode: leader`、授权身份、理由、原排队事件、分支和基准、保存的尖端（缺失为 null）、可读取的未保留提交 SHA／标题及检查证据。自动收束用 `mode: retained`。两者都不写 `landed`，不合并、不重建分支、不授权丢弃。旧收束事件不会遮住新排队。正常清理在符合条件的 tick 恢复，仍独立核对归属、未提交内容和活跃 agent。

选择扩展 `resume-cleanup`，因为这条已验收卡的合回占用会阻止清理。复用 `accept` 需要重开已归档卡，可能重复验收或合并；复用 `--discard-unmerged` 会混淆关闭缺失分支排队与删除现存分支的授权。没有保存尖端的旧安装类卡，可在核对发布证据后使用显式命令；仅升级会保留记录并通知，不会猜测。
