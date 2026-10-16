用法: kanban <命令> [参数] [--json]
命令: create show list comment complete block approve request-changes link unlink grant-read revoke-read unblock wait-user unwait accept reject rework pass start archive register supervise handover project rebind purge-agents resume-cleanup native-sessions compact-events vacuum tag audit doctor ping
{leaderActionNote}
卡号: 显示号如 ABC_0031（大小写不敏感，前导零可省，如 ABC_31），或旧的全局号 114、#114。
定时等待: block <卡号> --kind scheduled --until "<带偏移的未来 ISO 时间>" --reason "<原因>"。until 仅 scheduled 必填，必须带 Z 或 +/-HH:MM，且在未来 7 天内；更长等待请让<leader>用 wait-user。不要用 transient 等钟点。到点前不做 transient 重试、不因等待报 doctor 红；到点后下次 tick 恢复一次。期限与去重消息 ID 持久保存，重试／重启不会重复开模型回合。原 agent 消失或已归档时按原有规则重派。doctor 从到点起计算现有 transient 滞留阈值。执行者可设置自己的卡，所属<leader>可提前 unblock。
交活: complete <卡号> --summary "<摘要>" --handoff '{"files":[],"verification":"通过","risks":[],"waitingOn":"PR <url> 合并"}'。waitingOn 是可选文字；没有 CI 的仓库，合并前在本机跑测试和构建，结果写进交接。等 PR 合并／等别的卡时照常交活，卡片显示「等外部：…」，由 <leader> 验收时核对。宿主归档了工作区或 agent 丢失时，只有 Kanban <leader>（supervisorAgentId）或该项目已登记的 <leader> 可以代交：complete <卡号> --on-behalf --summary "..." --handoff '{...}'。complete 事件会记下 onBehalf。其余身份一律拒绝。
卡住: block <卡号> --kind needs_human --reason "<需要人处理的权限或用户决定>"。kind 支持 dependency、needs_human、capability、quota、rate_limit、transient、scheduled。执行者用 dependency 报等 PR／等别的卡会被拒绝：「这不算卡住，请交活并在交接写明等什么（handoff.waitingOn）」。等 CI 时照常交活，在 handoff.waitingOn 写明等待。
等用户: wait-user <卡号> --decision <待拍板编号>（本项目<leader>或 Kanban <leader>）。支持 ready 或 blocked(needs_human)，后者在同一事务中直接转换成 ready＋等待编号，无需先 unblock；其他阻塞类别及活动状态拒绝；有启动 claim、仍可恢复 agent 或未满足前置依赖的人手阻塞卡也保留阻塞。卡留在 ready；调度器不自动开工、不催，也不算卡住；看板和 list／show 显示「等用户：<编号>」。待拍板编号格式 [dk]\d{4}-\d{6}-\d+：看板的编号如 d1005-091216-1，看板本地清单的编号如 k1005-091216-1，不合格式拒绝。解除：unwait <卡号>，之后照常可开工。记 wait_user／wait_user_cleared 事件。暂停自己建的卡用 wait-user，不用 block（block 只给真的需要人处理的卡住）。
建卡带待拍板: create ... --decision <待拍板编号>（d1005-091216-1 或 k1005-091216-1；可选，记进卡片的 created 事件）。看板自动提醒（Paseo 定时任务开的 agent，以及标题或简报里含「看板自动提醒」的）建卡必须带 --decision，且该编号在看板的 decisions.json（环境变量 ROLES_STATE_DIR 可指定目录）里存在、状态是用户已定（done）（没装看板时查看板本地清单，即 k 开头的编号）；否则拒绝。其他身份建卡不受影响。
删前置: unlink <子卡> --parent <前置卡>（也接受 --parents 逗号分隔或重复；本项目<leader>或 Kanban <leader>）。删除后重新评估能否开工。
授予项目只读: grant-read <卡号> --scope project（仅已登记的本项目<leader>或 Kanban <leader>）。该卡的 agent 可 show／list 本项目全部卡，包含已完成、已归档卡、评论及脱敏事件；其他项目和全部写操作权限不变。show 的 readScope 显示当前权限，交活、完成或归档时自动失效。卡令牌、执行者、审查者、定时任务和未登记身份不能授予。
撤销项目只读: revoke-read <卡号>（同上身份限制），立即恢复原读取规则。授予／撤销记 grant_read／revoke_read 事件（操作者、时间、scope=project、项目）。
建卡前置: --parents <卡号>（可重复，也接受 --parent）。未完成的前置会让新卡停在等待。
合并卡可以挂在 PR 卡后面，看板会自动识别、不会死锁；使用 role=batch，并在标题／简报写清同仓库 PR 号或完整链接。
审查哪张卡: --reviews <卡号>（只对审查卡）。这张审查卡打回时，那张卡回到返工（第 1 轮原执行者还在就发回，已经归档或关闭就重新派；第 2 轮停住等 <leader> 裁定，不自动发回），审查卡自己结束。不带 --reviews 的审查卡打回后仍交给<leader>验收。
验收: accept <卡号>（只有<leader>）。没有远程的临时 workspace 会先把实际功能分支合回本地基准。主目录有未提交改动时验收仍通过，合回排队（land_pending）。变基冲突会先退回返工再报错，不计审查轮次。主目录不在基准分支上则验收失败，状态不变。产物验收是单独的：accept <卡号> --artifact <提交|文件|pull-request> [--reason "<核对过什么>"]。证据是 pull request 时必须给理由。这会记下验收提交、树和证据，不合并且不变基本地基准。已有 pull request 或 GitHub 合同仍须对上卡的分支尖端，别的提交会拒绝。没有临时分支时，目标是卡的工作区里当前检出的提交，包括游离的 HEAD。记录的分支可以是空的。读不到这个提交就拒绝，别的提交也拒绝。卡上已经绑定 pull request 时，产物地址必须是同一个所有人、仓库和编号，这个核对不访问网络。没有绑定 pull request 时，仍要给出明确的 pull request 和理由。没有这份证据会拒绝，没有远程也不会自动改走这个模式。它仍然要求 <leader>、卡处于待验收，以及这张卡的角色需要审查时已有审查通过或裁定通过。进行中的卡会拒绝并保持不变。
打回验收: reject <卡号> --reason "<原因>"（只有<leader>，能打回的范围和 accept 一样，而且只能打回待验收的执行卡）。卡回到返工。进入待验收时，这张卡开过的执行 agent 会开始归档，原来的执行者不会留着等打回：验收不通过要另开卡，或打回后重新开工。审查卡验收不过请归档或重开一张审查卡。
裁定返工: rework <卡号> --reason "<要改什么>" [--agent <agentId>] [--count-round]（本项目<leader>或 Kanban <leader>）。适用 blocked、acceptance、reviewing、in_review、rework，以及合回冲突的完成卡（回到原临时目录解冲突）；已在 rework 可追加裁定。第 2 轮审查打回停在返工、不自动发回执行者，用这条附上裁定再发回。原执行者还在就发回；不在就清掉 agent、追加「当前这一轮要做的」并在原目录重新派。默认不增加 review_round，--count-round 才加。裁定本身不触发熔断；发回后再次被审查打回，第 3 轮熔断仅作裁定发回后的兜底，不等到那时才介入。
裁定通过: pass <卡号> --note "<裁定理由>"（本项目<leader>或 Kanban <leader>）。blocked、reviewing、in_review、rework 直接转入待验收，之后仍要 accept。第 2 轮只剩 P2 时用它通过，并另开卡记遗留。也可以先修正简报再裁定。
审查结论：审查者调用 approve 或 request-changes 之后，这个审查 agent 会归档。下一轮审查另开审查 agent。
开工: start <卡号> [--force]（只有<leader>）。目录里已经有会改文件的卡在进行时：项目并行开着（默认）就另开临时 workspace；并行关着才拒绝，并写明是哪张卡。项目开了 --always-temp 时，新 agent 都进临时 workspace，只读角色使用只读副本，审查跟随被审的临时副本。--force 是显式主目录例外，记 main_workspace_exception；覆盖已占目录时还记 forced。开工后不再显示「同一工作目录已有卡在进行」。
建卡标签: --tag <标签>（可重复，也可用逗号分开）。派活时按标签挑档案：
  --tag high-risk     涉及资金、权限、数据迁移、安全、对外合同或不可逆操作的活。不改存的难度。审查按该执行家族的 L4 审查名单顺序，选第一个可派的，不管卡片存的是几级；开工前预留审查也按这份名单，名单上没有可派的审查档案时执行不开工。L4 名单没有时退回原来的难度，并在派活原因里写明。执行仍按存的难度派。审查者仍须和执行者不同家族。
  --tag complex-docs  复杂文档工作；可通过明确配置的档案规则分派给专门角色。
  用 --profile 指定档案时不看标签，也不受适用范围规则限制，但仍受池上 onlyRoles 限制。
建卡深度: --effort low|medium|high|xhigh|max
  强制这张卡本身角色的 agent 用这个推理深度，优先于档案自带的 thinkingOptionId。
  执行卡交活后另开的审查不受这个深度影响，仍用审查档案自己的深度。返工发回原来的 agent，深度不变。
派活策略：新看板不预设服务商禁用、模型代际限制、档案名称偏好或额度池顺序。按需在设置中配置 families、bannedProviders、profileRules 和额度池限制。家族规则可限制模型前缀、快速模式、ultra 深度和缺失的额度快照。审查仍须使用与执行者不同的模型家族。
建卡难度: --tier L1|L2|L3|L4
  没写时用派活矩阵的 defaultTier；矩阵文件不在就按 L2。带 high-risk 又没写难度时按 L4。
  --tier L4 会自动带上 high-risk。已经写了难度再带 high-risk，存的难度不变；审查和开工前预留仍按该执行家族的 L4 审查名单顺序，选第一个可派的。
补标签: tag <卡号> --tag <标签>（可重复，只有<leader>）。记一条 tagged 事件。建卡时忘了 high-risk 的，审查开工前可以补上。
登记项目 <leader>: supervise --project <项目全名或简称>（调用者须有 PASEO_AGENT_ID；只接受已配置项目。项目已有<leader>且那个会话还在（没归档、没关闭）时拒绝，请原<leader>执行 handover，或由 Kanban <leader>处理；原<leader>已不在或项目没有<leader>时直接登记。Kanban <leader>可以改任何项目的登记。每次变更记 supervisor_changed（旧、新、操作者））
交接: handover --project <项目> --to <新 agentId> [--from <旧 agentId>] [--dry-run]（<leader>换会话时用。把该项目未完成卡（不是 done／archived）里建卡人是旧 id 的改成新 id，每张记 creator_changed（from／to／reason="<leader> 换会话"），并把该项目登记的<leader>改成新 id；不给 --from 时用当前登记的<leader>。只有当前登记的<leader>、Kanban <leader>能执行；新会话本人（PASEO_AGENT_ID 等于 --to）只在原<leader>已不在（agent 不存在、已归档或已关闭）时能执行。不能交给看板派出的 agent。--dry-run 只显示不写。--kanban-leader 代替 --project：改 supervisorAgentId，并把旧 Kanban <leader>名下的未完成卡转给新 id。）
项目工作方式（改设置限本项目<leader>或 Kanban <leader>；还没配置的新项目只有 Kanban <leader>或终端能加）: project [--project <项目>] [--workspace dir] [--base <分支>] [--lanes <条数>] [--allow-lanes on|off] [--parallel on|off] [--always-temp on|off] [--wait-parent-pr on|off] [--code <简称>]（只有<leader>。不带参数显示当前设置。没配置的项目用目录，车道默认关闭，并行默认开启，一律临时默认关闭，等前置 PR 合并默认开启。--wait-parent-pr off 让前置卡验收后即放行子卡，不等其 PR 合并；未验收仍等待。--lanes 只改条数，不打开车道。--allow-lanes on 才允许建车道卡：打开会新建一个 Paseo workspace，需要用户同意。允许之后，要车道时建卡写 --workspace lane:<仓库>@<基准>。--parallel off 关闭主目录被占时的并行改道；always-temp 也关着时改回排队。--always-temp on 之后，执行和杂活总是进临时 workspace，通读、决策、独立审查进只读临时副本；审查优先借用被审卡已有的临时 workspace，旧目录卡的审查另开提交快照。主目录归<leader>专用，只有开关关闭或显式 --force 可以例外，记 main_workspace_exception。已有临时副本的返工、裁定返工和接手改派都沿用该副本。旧主目录卡，包括裁定返工和接手改派，按现有提交进入临时副本；只有开关关闭或显式 --force 留在主目录，并记 main_workspace_exception。原 agent 续跑不另开 agent。默认关。项目默认 worktree 已不支持。--code 只改显示号里的简称，不改序号，不能和别的项目重复）
绑回: rebind <卡号> --agent <agentId>（只有<leader>。卡片被误收回或卡住、原来的 agent 还在时，把卡绑回去。绑回后该 agent 用命令行交活，凭 PASEO_AGENT_ID，因为发不出新令牌。）
清理 agent: purge-agents <卡号> [--dry-run]（只有<leader>。只处理已完成或已归档的卡。先把要点写进评论和 agent_purged，再按 id 删除。--dry-run 只列出，不删除。）
恢复清理: resume-cleanup <卡号> [--discard-unmerged]（只有<leader>。清理的某一步连续失败 12 次、或这张卡的清理反复出错 12 次后，看板停止自动重试并叫醒一次，之后每 24 小时自动再试一次（再失败不再叫醒）；处理完原因想立即重试，就用它清掉停止标记，次数从 1 重新计，下个 tick 起重试。）

在卡号后加 `--discard-unmerged` 可显式丢弃已完成卡的自有临时分支。只有该项目登记的<leader>或全局 Kanban <leader>可用；仅为创建者、执行者、审查者、卡令牌及匿名终端不能使用。命令只列卡分支 tip 可达、且未被其他本地分支、远端跟踪分支或 tag 包含的完整 SHA 和标题，排除即将移除的分支／worktree 引用。优先使用本地已有的 origin/<base>，其次存在的已配置上游，最后本地基准；本地基准落后时提示。审计不 fetch、不发网络请求。记录授权 leader、精确 tip、比较基准和修正清单，再由正常清理在合适的 tick 执行。空清单表示其他引用保留了所有提交，自有分支／副本仍可移除。自有目录、共享 workspace、活跃 agent 检查照常生效；删除干净的 worktree 和分支，并归档 workspace。丢弃完成事件记录 leader 和提交。副本仍在时，分支、本地基准或比较基准 tip 变化、有未提交改动会暂停移除，需检查后重新显式授权。副本删除后，基准前进不阻止删除已批准 tip；tip 改变或正常删分支重试耗尽时保留分支、撤销授权并唤醒 leader，清理收束，不要求对已删除副本重新授权。不加参数时 not_merged 行为不变。全局 Kanban <leader>可恢复所有项目的清理。
项目以 Paseo 为准：目录已不是 Paseo 项目的看板项目（按目录对照，不按名字）不再出现在 leader 面板、暂停区、首页和看板里，不发提醒、不唤醒、不派活，create、register、start 和为它启动 leader 都会被拒绝。卡片与历史保留：show 可看单张卡，list --include-removed 列出这类项目的卡片（list 默认不列）。读不到 Paseo 时沿用上次读到的列表。
原生会话: native-sessions --sweep [--project <项目>] [--limit <个数>] [--offset <个数>] [--dry-run] [--apply]（默认只读；Kanban <leader>可查全部项目，项目<leader>和执行者限本项目，修改只有<leader>）。native-sessions --restore <sessionId> 恢复；--restore-manifest <文件> [--dry-run] 按手工清单恢复（只有<leader>）；--reset-failed <agentId> [--dry-run] 复位失败重试（只有<leader>，dry-run 只显示）。--reconcile-codex [--apply] 一次性对账：pending 的 codex 行若 codex 索引已标归档就记为 archived（默认 dry-run，幂等，只读 codex 索引）。--reconcile-claude [--apply] 同理：pending 的 claude 行若原 jsonl 已不在、~/.claude/projects-archive 里有它，就记为 archived 并补上恢复用的移动记录（默认 dry-run，只改看板库，不动文件）。--sweep 还会收「agent 已归档但不属于任何卡」的 Claude 会话（只有 Kanban <leader>、不带 --project 时）；加 --include-tmp-sessions 再把 /tmp 下已不存在目录留下、超过 1 天的测试残留会话列入（默认不收）。
压缩事件: compact-events [--dry-run] [--apply] [--days N]（只有<leader>。默认 dry-run 只读打开数据库：不建索引、不迁移、不写令牌，只报告会删多少，并列出会被清掉的旧备份。--apply 先做一致性备份并核对完整，再迁移并删除，之后 data/ 里只留最新 2 份 kanban.db.bak-*。删两类，都只删超过 N 天（默认 30）、且所属卡已完成或已归档的：重复的 verify_agent（每张卡每个 agent 保留最早一条和最后一条）；白名单里的纯流水事件（清理状态、带 commentId 的事件不在内，白名单见 server/compact-events.ts 中的 EXPIRING_EVENT_KINDS；native_session_skipped、native_session_project_dir_removed、tmp_cleaned 三类汇总事件只留 7 天，--days 更小时按 --days）。） 另清 write_audits：来源审计默认保留 30 天，--days 同步调整，超过期限的均可删（含无所属卡和未完成卡）；dry-run 单独报告行数，--apply 只删备份里已有的审计，卡片／评论／交接不删。
压缩数据库: vacuum [--dry-run] [--apply]（只有<leader>。要先停插件：paseo plugin disable paseo-kanban。默认 dry-run 只看占用、大小、空闲页；--apply 先备份，再 quick_check、VACUUM、quick_check，核对每张表行数前后一致，打印前后大小。检测到别的进程占着数据库就拒绝。压缩完 paseo plugin enable paseo-kanban。）
体检: doctor [--last]（只读。人看的摘要；--json 给机器读；--last 看最近一份。不改卡片、不删除、不叫醒。建议里的命令要人自己跑。）

身份:
- 有 KANBAN_TOKEN：用令牌里的身份。
- 没有 KANBAN_TOKEN、但有 PASEO_AGENT_ID（格式不合法直接拒绝）：
  - 看板开的 agent（在 runs.agent_id、tasks.agent_id、tasks.executor_agent_id 或 tokens.agent_id 里出现过，或者带 kanban=1 标签）：按那张卡的角色，不能建卡、验收、解除卡住、归档、开工。
  - 已登记的<leader>（某个项目的 supervisors.<项目>，或 Kanban <leader> supervisorAgentId）：<leader>，身份里带上这个 agentId；create 会把建卡人记成这个 agent。
  - Paseo 定时任务开的 agent（带 paseo.schedule-id 标签）：只能 list、show、create（项目须已配置，不能 --reviews，简报用 --brief 不用 --brief-file），建的卡由该项目<leader>验收。
  - 其他（没登记的会话）：只读，只能 list、show、doctor；要当<leader>先 supervise，或由原<leader>／Kanban <leader> handover 给你。
- 两个都没有（你在终端里自己跑）：<leader>，不限制能操作哪些项目。
- 带 agent 身份的<leader>，只能验收、解除卡住、归档、开工自己建的卡，或自己登记为<leader>的项目的卡。
- 建卡、补登记（register）、改项目工作方式：项目必须已配置（终端也一样）；带 agent 身份的<leader>只能在自己登记的项目里做，Kanban <leader>不限项目。加前置（link）：子卡须是自己建的或本项目的卡；--reviews 指的卡也一样。register、rebind、rework --agent 不能绑已登记为<leader>的 agentId。
- supervisorAgentId 是 Kanban <leader>（兜底），不是所有项目的默认<leader>。找不到项目 <leader>时才叫醒它，卡片仍算无人接。它不替别的项目验收；看板引起的卡住（派不出人、熔断、催交后仍不交活）它可以跨项目解除。rework 和 pass 允许它跨项目裁定；其他带 agent 身份的<leader>须是该项目已登记的<leader>，仅是建卡人不够。
- 任何子命令带 --help 或 -h 只打印这段说明，不会改卡片。complete 和 approve 必须有非空 summary；request-changes、block、reject 和 rework 必须有非空 reason，pass 必须有非空 note。不认识的参数会报错。

风险: 同一个系统用户下的进程仍然能读到令牌文件和数据库。这套规则防的是误用，防不了存心绕过。
