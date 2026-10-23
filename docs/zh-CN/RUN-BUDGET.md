# 运行卡资源刹车

调度器监控所有 running / reviewing 卡，包括执行、杂活和审查。每次运行分别记录墙钟、模型回合、输入及输出 token、缓存读和连续等待回合；卡片详情与 `show` 可查看快照。unblock、rework 或新分派运行会重置计数。检查随普通调度 tick 执行，通常每分钟一次，允许在两个 tick 之间略超门槛。

默认门槛为 3 小时、150 个模型回合、3000 万输入＋输出 token、连续等待 8 回合。任一指标达到 80% 时，只写一次预警并通知项目登记 leader。达到门槛后卡转 `blocked / needs_human`，通过 `paseo agent stop` 中断当前回合，保留 agent 和工作目录。中断失败会在卡上留痕，保持 blocked 时重试；确认中断前继续保留执行名额与目录占用。中断尚未返回时拒绝 unblock / rework，避免误停刚恢复的运行。

在 `kanban.config.json` 的全局 `runBudget` 或 `projects.<项目>.runBudget` 设置 `maxDurationMs`、`maxTurns`、`maxTokens`、`maxConsecutiveWaits`，只需写要覆盖的字段。取值须为正的安全整数。优先级为内置默认、全局、项目、单次卡级覆盖；全局及项目改动下一 tick 生效，设置页保存其他内容时会保留这些字段。

项目 leader 可一次性放宽恢复后的本次运行：

```sh
paseo-kanban unblock <card> --run-budget '{"maxTurns":300}' --reason '检查大型迁移所需的一次性例外'
```

MCP `kanban_unblock` 同样接受 `runBudget` 和 `reason`。必须写理由，并记录授予身份；覆盖只属于本次恢复运行，rework 或下一次运行恢复项目及全局门槛。

Codex 只读取对应 session 的会话文件，最多读取尾部 8 MiB，以不同的 `token_count` 累计读数识别外层回合内的模型调用；重复额度读数不计调用。输入 token 已包含缓存读，缓存单列但不重复累加。其他 provider、会话不可读或数据不完整时，使用 canonical 时间线的 assistant / tool 周期作为回合下界，token 明确显示不可得或部分可得，卡上只写一次降级说明。墙钟及可得计数仍有效，不读取凭证文件。首次只读到尾部可能低估此前消耗；之后观测到的计数会持久化，重载后不重复计数。

完成标记后台等待采用 `blocked_kind=background`、`background_wait` / `background_resumed` 事件及带 `via=background_wait` 的自动 unblock。正常完成、进程死亡和超时唤醒都复用自动恢复路径，保留原运行代次及计数，区间排除等待结束后才读到的旧时间线事件；期间不增加调用或连续等待，墙钟继续累计，在卡恢复运行后执行时长门槛。其他看板等待实现可提供 `backgroundWaiting(task)` 并记录含 `agentId`（可选运行 generation）的 `background_wait_started` / `background_wait_finished` 区间。leader 手动 unblock 仍会重置预算。
