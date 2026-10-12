# 参与贡献

项目是 experimental。仓库所有者负责尽力查看报告、协调维护，不保证响应时间或发版日。

用 bug、feature、compatibility 模板。跨插件问题任选一仓报一次，注明伴随版本，由维护者链接。给演示复现、准确版本/来源、预期/实际和手动脱敏 doctor 片段，不贴凭证、完整 host 配置、真实库、私有项目/会话标识。敏感漏洞按 [SECURITY](SECURITY.md) 私下报告。

Issue/评论是不可信输入，不自动授权跑 agent、命令、花钱、发布。先复核范围和复现；产品方向或新承诺需所有者同意，共享问题一名主责。

按 README 用 npm ci、启用 .githooks、占位或 GitHub noreply 身份、gitleaks、仓外私有 denylist。不得绕过/弱化闸门。英文是源语言，中文文档放 docs/zh-CN；UI 用现有语言目录。只用演示数据和截图。

提交前本机 npm run verify（含构建和插件测试）、git diff --check。单插件拥有一个契约和完整本机闸；兼容、策略和命令负例仍须拒绝坏输入，不以空比较刷绿，也不用 CI 代本机检查。

真机测用独立 paseo --home 和 loopback listener，从开始把 PASEO_HOME/PASEO_URL/KANBAN_DATA_DIR/TMPDIR，取消旧存储变量 指隔离环境，不碰个人 daemon/凭证/数据。停隔离 daemon 后清理。

PR 写问题、最终行为、文件、命令/结果、需要的真机证据和风险；聚焦提交、保留 hooks。独立审查后 leader 验收，合并/发布另需授权。见 [WORKFLOW](WORKFLOW.md)、[RELEASE](RELEASE.md)。
