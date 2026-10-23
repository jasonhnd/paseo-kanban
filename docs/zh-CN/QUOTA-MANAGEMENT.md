# 额度管理

## X Ultra：每个席位共用一口周池

The X Subscription Ultra 的官方月付标价为 $200。Grok 命令行、App、订阅附带的
Bot，以及 Cursor 中的 Grok 和 Cursor 自家模型，共用**同一个席位的每周额度池**，
池标识为 `x-ultra`。Cursor 中的 Claude、GPT 等第三方模型，从首次使用起就是付费的
Additional Usage，不包含在这口周池里。参见官方[用量说明](https://docs.x.ai/x-subscription/usage-limits)
和[价格说明](https://docs.x.ai/x-subscription/pricing)，核对时间为 2026 年 10 月。
订阅账期与每周额度重置时间是两件事。

运行时把旧 `supergrok`、`cursor` 读成 `x-ultra` 的别名，不会改写原配置文件。
合并后的套餐使用 `grok-cli`、两个 provider 标签，只计一份订阅价格。
已有 `x-ultra` 行时以它为准；否则沿用旧 Grok 行的派活设置。
旧 Cursor 行的月度 `cycleDay`、附赠价格、手填 Auto 百分比，以及 Included/Auto/API
窗口，不再作为周额度。该迁移只适用于这几个已知旧池标识；独立账号应使用不同的自定义池标识。

Grok 命令行／provider 读数与 Cursor 明确标为 **Grok** 的行，是同一周池的两个观测来源。
Cursor 的 Grok 行必须提供自己的完整重置时间，不能拿顶层旧月度重置时间代替。
旧 Auto 账期过期，也不能使仍然新鲜的独立 Grok 周读数失效。
选择较新的可用来源时间，发布快照不会延长读数寿命。
读数必须在两个采样周期内（两小时）、重置时间尚未到来，且来源时间不能在未来。
当前重置时间相差超过一分钟、同一来源时刻百分比不一致，或同一周期内百分比倒退，
都会标为 unknown。同周期里较旧的耗尽读数不能被较低百分比覆盖。
原有认证失败、耗尽等硬停继续生效；缺失或矛盾的证据不会变成零用量。

面板只显示一张 X Ultra 套餐／公司卡和一口周池。预测、未知额度并发、每日消费和运行花费导出
统一使用 `x-ultra`。旧 Grok 历史可以接续重置周期一致的周序列；旧 Cursor Auto 历史不能证明周用量。
档案池、优先顺序中的旧标识在读取时归一化，已有记录不原地重写。
`disabledPools` 中只有 `supergrok`、`x-ultra` 表示共用额度池停派。
旧 `cursor` 项只限制 Cursor 通道，不能关闭 Grok 命令行派活。
两个通道的并发占用相加，显式并发上限冲突时取较小值。

### Bot 与用户本人留量

`plans.json` 提供两个独立的百分比点留量字段：

```json
{
  "id": "x-ultra",
  "name": "X Ultra",
  "adapter": "grok-cli",
  "usageProvider": "grok",
  "providers": ["grok", "cursor"],
  "priceUsdMonthly": 200,
  "dispatch": true,
  "cliRead": true,
  "screenRead": false,
  "xUltraReserve": { "botPct": null, "userPct": null }
}
```

两个数值都待用户决定。各自范围为 0～100，总和不能超过 100。
明确填零属于已配置；缺失、null 或非法值不等于零。
没有两项都配好时，派活采用保守的 unknown 限额：**整个席位最多并行一件 L1/L2 工作**。
更窄的 unknown 策略仍然生效；更宽的策略不能开放 L3/L4 或增加并发。
真实用量仍可见，已有硬停与 `dispatch: false` 不会被重新打开，不凭空设定具体留量比例。

两项都配置后，挑池时从剩余额度中扣除它们的总和，并在已用达到 `100 - 总和`
或其他更严格的套餐停线时停派。留量为 Bot 与本人使用保留空间；这些入口的用量仍计入同一个实时读数。
行级留量覆盖、手动优先顺序或高难度卡都不能减小这份配置留量，普通耗尽停线也继续生效。

### 派活限制与生产配置交接

Cursor 通道继续留给 Bot。Grok 命令行合用额度池，不会自动授权 Paseo 经 Cursor 派活。
经 Cursor 使用第三方或未确认模型，在选择／启动前会收到明确的按量付费拒绝原因。
检查覆盖 roster、matrix 与 override、显式 `--profile`、审查预留、本地预选档案、退回续跑和云派卡。
provider／通道证据独立于可修改的 family、pool 标签。识别 Grok、带版本的 Composer 及 Cursor 自家模型，
不意味着开放保留的 Cursor 通道。

代码安装后，由日常 leader 把生产 `plans.json` 中的旧两行换为上面的单行，保留有意配置的
更严格 `stopPct`、角色限制等 Grok 设置，移除旧月度和附赠字段。
待用户定值后再写两项留量。档案池、显式池并发上限和新的优先顺序建议改为 `x-ultra`；旧标识仍兼容。
有意关闭整口共用额度池的 `supergrok` 停派项可以改名为 `x-ultra`。
安装代码后，日常 leader 从 `kanban.config.json` 的 `disabledPools` 删除旧 `cursor` 项即可，
**不要把它改名成 `x-ultra`**。旧配置即使暂时保留 `cursor`，Grok 命令行也仍可派活；
删除这项后，代码层的 Cursor 通道拒绝仍然生效。其他停派项保留。旧固定派活顺序不能当作新用户指令带进自动挑池。

`afc.config.json` 中，如果要继续使用已有授权的官方读取器提供 Grok 行，保留
`adapters["cursor-api"]: true`。套餐保留 `screenRead: false`，迁移时不开启交互屏幕。
关闭该适配器时，仅使用 Grok 的可用证据。其他有意配置的设置保留，不需要第二口池、手填 Auto 额度
或额外付费模型适配器。安装代码本身不会修改这些生产文件。

## 最近用量预测

每口池快照包含 `burnRatePctPerHour`、`projectedPct`、`runsOutAt`、`forecastConfidence`
（high、low、none）。`projectedPct` 表示重置时预计已用百分比，可以超过 100；
预计在重置前耗尽时才填 `runsOutAt`。面板显示耗尽时间或重置时预计用量。

`fleet/quota-forecast-history.json` 每五分钟最多一条，保留七天、最多 2016 条。
保存来源时间，缓存读数不当成新证据；它独立于每日计费的 `quota-history.json`。
取本周期最近六小时的端点斜率。重置变化、百分比下降、来源时间冲突、缺失读数或超过两小时的间隔，
会打断序列。至少两条读数跨越十五分钟，最新一条须在三十分钟内；缺少用量、来源时间或周期边界时，
置信度为 none，预测值为空。没有时间字段的旧来源沿用采样时刻。
至少三条、跨度一小时，且分段斜率与总斜率误差不超过 50% 或每小时 0.5 百分比点时为 high；
其他足够证据为 low。突增会降低置信度，重置后需要重新积累证据。

## 挑池：路由第二步

`rankPools({ pools, now, tier, role, dispatchPriority? })` 的接口不变，`now` 为毫秒时间戳。
返回按顺序排列的 `{ pool, score, reason, allowedTiers }`，只包含本难度和角色可用的池。
函数纯计算，不读生产文件，原因采用当前 Fleet 语言。

G2c 接入模型资格后调用挑池。先过滤可用模型，保留父池作为额度证据；仅作父池证据的行标为
`eligible: false`，不能成为候选或压掉 Claude 兜底。
`withPoolRankingMetadata(snapshot.pools, rawPlans, poolWideOccupancy)` 补齐适配器、父池、留量和总占用。
模型资格、普通并发限制仍归 admission 管理；此函数不挑模型或推理深度。

按优先级应用以下规则：

1. 排除 Cursor 通道及通过适配器／provider 识别的改名候选。`x-ultra` 仍可经 Grok 命令行使用，
   `cursor` 是读取别名，不是第二口候选池。硬停、角色限制及父池限制都不能被绕过。
2. 缺失、过期或明确 unknown 的额度遵循 G1d 策略，默认整个池只并发一件、仅 L1/L2。
   占用通过 `activeRuns` 或 helper 第三个参数提供。unknown 得分为零，不伪造完整余量。
   X Ultra 留量未定时，还有上文不可放宽的边界。
3. 剩余点数为 `100 - usedPct`，再扣除 `reservePct` 得 surplus。
   有效行级留量优先于普通套餐留量；套餐值只用于主池，不传给子池。
   X Ultra 的两项留量总和不能被更低的行值覆盖。
   其他池默认主 Codex 为 20、无父池的普通 Claude 主周池为 25，子池和其他池为零。
   特殊模式由调用方提供 `100 - currentStopPct`，不自行猜重置券或审查例外。
   surplus 不大于零就不能派活，L3/L4 也一样；子池硬停和父池留量仍适用。
4. 已知且安全的池得分为 `1 + surplus / max(距重置天数, 0.5)`。
   high 或 low 预测中，重置时预计已用超过 100，或预计提前耗尽，只开放 L3/L4，
   得分为 urgency / 1000，低于所有已知安全池、高于 unknown。
   none 不施加该预测限制。过期周期为 unknown，等新读数恢复。
5. Claude 仅兜底：本角色／难度没有其他合资格家族可用时才保留。
   必须在挑池前过滤模型资格，不能让不可用模型占位、压掉可用兜底。
6. G2c 切换时给旧固定顺序传 `dispatchPriority: null`，即便旧 until 还没到。
   只有切换后用户明确设置的新优先顺序才传入。手动顺序只重排存活候选，不绕过保护、兜底或留量。
   未列出的池按分数，同分按池标识稳定排序；过期或无效优先顺序恢复自动计算。

AFC 心跳向已登记的项目 leader 提醒预计耗尽。`fleet/pool-exhaustion-notices.json`
按池与重置周期记已成功通知的接收者；并发刷新串行化，失败重试，同周期预测反复变化或读数缺失不重复通知。
面板读取不发消息，沿用同一来源时钟和 G1c 预测，不再建第二套采集器。
