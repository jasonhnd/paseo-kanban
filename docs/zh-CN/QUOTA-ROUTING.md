# 新 agent 的额度路由

调度器、手动 start、关联／内联审查、返工换人和云执行共用 `routeProfile`。
先把实际矩阵与 `qualificationForNewAgent` 求交，为每个模型取第一个够格深度，
剔除估算花费会越过留量线的候选，再由 `rankPools` 挑池。
主池候选若被花费门禁剔掉，不会挡住 Claude 后备；同池优先最轻的够格模型／深度。

矩阵继续控制名单、暂停和高风险审查名单。异实际 model、禁快速／Cursor、
家族规则、并发容量和 R3 刹车继续生效；显式指定档案同样过门禁，不自动换人。
沿用原 agent 保留会话原深度；新开替代 agent 每次退回升一档。
停住的审查随后由 leader 继续返工，只计一次退回。

## 花费与快照

复用 `server/run-cost.ts` 的 `costEstimate`，读取 `fleet/run-costs.json`。
新增可选 `pool` 过滤，避免混用不同额度池的百分比；查询同时带实际模型、深度、
卡类型、角色和原卡 L 档。卡类型与记录器相同：code、review、read、ops、batch 等。
不另采 token，不补造历史数据。

默认至少 3 份额度样本，观测均值乘 1.5；样本不足时，取该值与 5 个百分点保守默认值
中的较大者。样本足够后仍有 0.25 点下限。缺 token 不会变成额度样本。
卡片和详情显示 started.reason：池、剩余／留量／富余、深度理由、估算花费、
样本数，以及是否使用保守默认。云启动同样保留理由。

子池还会独立估算父池花费，父池缺样本时使用保守默认。
Fleet 随预测发布 adapter、providers、parent、reservePct，契约与消费端保留这些字段。
普通 Codex 主池留 20 点，普通 Claude 主池留 25 点，普通子池留 0；加倍周、
燃烧周和审查例外带使用当前有效停线。升级后旧的不可变快照缺留量／父池元数据时，
新开工会等刷新。过期额度按 unknown 限派，不当满池。

预计提前耗尽的池只接 L3/L4；unknown 沿用现有 unknownQuota：默认全池所有角色／
档案合计同时 1 张，只接 L1/L2，Fleet 继续去重通知 leader。
等待目录／模型目录操作后，create 前再次核对候选与实时全池占用；
不可变策略 revision／digest 门禁继续拒绝中途变化。

## 配置、换装与回退

全局 kanban.config.json 的默认值：

```json
{
  "quotaRouting": {
    "enabled": true,
    "minSamples": 3,
    "defaultCostPct": 5,
    "safetyFactor": 1.5,
    "reserves": {},
    "dispatchPriority": null
  }
}
```

缺省即启用新路由。enabled=false 恢复旧矩阵／档案排序和深度，不改已运行会话或删除花费。
reserves 按池 ID 覆盖留量；Codex 给用户本人的 20% 也在此可配，须按用户授权调整。
minSamples 为 1～1000，defaultCostPct 为 0.25～100，safetyFactor 为 1～10；错误配置拒绝解析。

新路由忽略旧 plans.json.dispatchPriority 和矩阵顺序；换装时新字段 dispatchPriority 保持 null。
只有换装后另设的 quotaRouting.dispatchPriority（order、until）才会钉选安全候选，过期恢复自动排序。
Fleet 全局顺序保留为旧客户端兼容视图。

本改动只备好当前发布线之后的下一版，不发布、不换装、不改生产。
正式换装由获授权的 leader 暂停派活与旧写端，同步 Fleet／daemon／CLI，保留花费与配置；
保持新路由开启、新钉选 null，按授权选择留量／估算参数。
先刷新池和不可变策略，确认元数据、精确模型 ID、宿主支持深度和角色／高风险名单后再恢复。
专用运维仍默认 Sonnet low；Gemini 等安装专属 ID 还需显式够格配置和原有授权门禁。

生产连续观察 3 天：每池重置时用掉 80～97%，没有池提前用完。
记录额度／重置／unknown、各角色×模型×深度×池派单量、估算与实际花费差、
样本数与默认值比例、留量等待、并发、退回升档、异 model 拦截和刹车事件。
本地测试不代表通过生产关卡；读数滞后和并发消费会影响估算，按记录调整获授权参数。
异常时设 quotaRouting.enabled=false 并刷新策略，保留理由与花费证据供复盘。
