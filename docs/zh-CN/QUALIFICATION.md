# 模型与深度够格表

`shared/fleet/executor-effort.ts` 是质量底线的单一来源。现有派活矩阵继续
负责实际档案、可用性和顺序；兼容路径的默认 max 限制也读取这张够格表。
挑池、额度保护、模型目录能力、普通速度以及审查实际模型隔离仍须分别检查。
完整默认值见 [JSON 示例](../../examples/qualification.example.json)，
各角色与 L1～L4 的对照和接口见 [英文说明](../QUALIFICATION.md)。

`qualifiedCandidates({role, tier, cardType, reworkCount, explicitEffort},
{global, project})` 返回 `{provider, model, effort}[]`。它列出当前起点到
上限的所有合格组合，按深度从小到大排序；同深度保留表内顺序。选定模型后
取它的第一个深度，不能因为后面的深度也在集合内而默认挑更贵的档位。
这个函数不负责挑池、查找实际档案或确认宿主模型能力。

每个模型从最小合格深度起步；每退回一次，在它的合格深度中升一档，到顶为止。
同一模型的重复配置行会先合并，不能用短行把返工深度降回去。L3/L4 的非运维
任务至少 high。运维执行/杂活沿用 `operationalExecution` 和既有标签优先级，
只允许 Luna 或 Grok low；四种 ops_* 专用角色使用自己的运维模型，默认是
claude-sonnet-5-5 low，不限制为 Luna/Grok。两类运维的返工和显式 max 都不提高档位。

卡片显式的非 max 深度只规定起点不低于该档：先找该模型不低于请求的最小合格
深度，再按返工次数升档并封顶。例如显式 high 在首次返工后升到 xhigh；L4
显式 medium 会从合格的 high 起，不能降低质量底线。只有卡片明确请求 max，且
该模型行允许 `allowExplicitMax: true` 才能返回 max；max 不能写进 `efforts`，
也不会由返工自动升级得到。ultra 不支持，Cursor 和已停用的 build-fast ID
永远不出现在候选中。仍须保留普通速度检查。Claude 的后备顺序由挑池步骤执行。
默认精确 ID 为 grok/grok-4.7、claude/claude-sonnet-5-5、
claude/claude-opus-5-5、claude/claude-fable-5-1；通读 Sonnet 使用
claude-sonnet-5-5[1m]。Fable 在 L4 高风险审查及决策候选中从 high 起。

`kanban.config.json` 的全局 `qualification` 和
`projects.<项目>.qualification` 都接受角色 → L 档 → 模型行列表。
遗漏格子沿用默认；全局替换默认格，项目再替换全局格。空数组表示禁派，
格式错误会拒绝配置解析。项目只写够格配置也可以，无须附带工作区字段。
`ops` 是执行/杂活运维的表，也是四种 `ops_*` 角色的通用后备表。先按
项目具体角色 → 全局具体角色 → 默认具体角色查找；全部不存在时，才按
项目 ops → 全局 ops → 默认 ops 查找。项目的通用 ops 不能挡住全局或默认
的专用格；专用空数组仍禁派。要改变默认 Sonnet 运维档案，应覆盖具体角色。
覆盖仍遵守 Cursor/已停用 ID 排除、L3/L4 最低深度、运维执行轻模型及专用运维 low 限制。
实际模型 ID 必须精确匹配；宿主使用别名不同的模型时，应替换对应配置格。

`server/qualification.ts` 的 `qualificationForNewAgent(task, review, config, matrixDefaultTier)`
提供新 agent 的候选上下文。应传入矩阵的默认 L 档，未定档卡片便与路由器保持一致，
而不是默认落到 L2。`review=true` 专指执行交付后的自动审查，返工次数从 0 起，
不继承执行卡的 max 标签和显式深度；独立审查使用自己的退回次数，深度/标签可以授权 max。
`qualificationReworkCount` 统计本卡实际转入 rework 的 request_changes 或验收 rejected，
以及 leader_rework（含 countRound=false）；停住的审查随后由 leader 继续，只计一次退回。
不使用运行次数或 review_round。
独立审查卡结束时的关联记账、合并冲突、启动重试及 resume 不计入退回次数。

总路由接线时，应在新开 agent（含返工换人）前调用适配器，与实际矩阵、
宿主支持的深度、审查模型隔离求交，再挑池。沿用原 agent 时保留原会话深度。
[总额度路由](QUOTA-ROUTING.md) 已在调度器和新开 agent 路径调用本模块的第①③步。
