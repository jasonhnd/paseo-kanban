# 单插件数据与读取边界

统一根为 `KANBAN_DATA_DIR`，否则 `PASEO_HOME/plugin-data/paseo-kanban`，Paseo home 默认 `~/.paseo`。server 和所有 CLI 使用同一解析器。看板持有根下的数据库、配置和本地决定；Fleet 使用 `fleet/`，兼容导出使用新根下 `exports/fleet/`。

`AFC_DATA_DIR`、`ROLES_STATE_DIR`、`AFC_LEGACY_DATA_DIR` 非空时给出配置错误，不再激活旧目录。即使导出声明另一个 dataDir，也不能扩大角色状态读取范围；不读旧 sibling 安装位置。

Fleet start/dispose 持有一组采集、策略和维护任务，使用 Kanban 的 host binding。Kanban 负责派活。服务内注入不可变 `paseo-policy/v1` 快照，独立 CLI 读取 `fleet/policy-snapshot.json` 并核对当前策略摘要、版本和时间，不假定共享进程内存。策略无效、模型未知或受保护读数未知时拒绝派活。兼容 `fleet-quota/v1` 文件不是实时派活入口。

1 小时采样、62 分钟展示、7 分钟保护分别保留；发布时间不能替代额度来源时间。没有全局失败 stream 的已知限制仍在。Linux keychain/屏幕功能明确 unavailable；匿名测试不执行真实探针。

## 备份、手动转移与测试

[手动指南](../MANUAL-MIGRATION.md)要求用户自行确认旧 source、停所有写者、做可恢复备份、逐个按白名单复制、解决冲突并自行设置凭证。生成读数、策略快照、锁和控制状态要重新计算。这不是实际迁移证明，没有自动迁移框架，也不读取 Mac 使用资料。

配置、决定、日志、审计、备份、token 和 secrets 都保持私有。SQLite 要停写后做一致备份，不能原样复制活数据库及 WAL。代码回退不撤销资料写入。

测试只用匿名临时 home、fresh `KANBAN_DATA_DIR`、明确的独立 loopback listener 和 `TMPDIR`，取消旧变量。不可连接个人 daemon 或读取凭证/生产资料；退出前清理本卡进程。真实 host 检查通过 `PASEO_SERVER_DIR` 使用单独安装的公开包，与个人 app 隔离。

[English](../DATA.md) · [安全](SECURITY.md) · [发布](RELEASE.md)
