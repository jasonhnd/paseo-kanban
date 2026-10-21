# 既有 leader 会话的 MCP 凭证

[English](../MCP-LEADER-CREDENTIALS.md)

手开或换班后的 leader 可以凭本机 CLI 继承的 `PASEO_AGENT_ID` 登记，无需 `KANBAN_TOKEN`。登记本身不会更新已有会话的 HTTP MCP 请求头。无凭证的 `kanban_ping` 只证明连通，业务工具仍需 Bearer 凭证。

## 从已登记会话导出

在 leader 会话中运行已安装的 CLI，保留继承的 `PASEO_AGENT_ID`：

```sh
paseo-kanban supervise --project demo
paseo-kanban mcp-credential --out "$KANBAN_TMP/leader-mcp.json"
```

换班会话应先完成受支持的 `handover` 流程。`KANBAN_TMP` 须指向已存在的私有目录绝对路径；每次导出使用新文件名。命令拒绝相对路径、已有文件和符号链接，以 `0600` 权限写出包含本机 MCP 地址及 Authorization 请求头的 HTTP MCP 配置。标准输出只有路径、agent id 和到期时间；写审计不保存凭证。

通过宿主支持的会话配置方式，将私有文件载入为该会话的 Kanban HTTP MCP 服务项，再重新连接 MCP。命令不会修改宿主配置，也不会更新正在运行的会话。宿主不支持修改既有会话时，继续使用继承身份的本机 CLI。不要把文件或请求头贴进对话、报告、源码或共享配置。

凭证在八小时后过期。再次导出会吊销该 agent 之前导出的凭证，需用新文件重连。导出失败保留旧凭证。看板启动 leader 时原有的 guest token 注入与自行登记路径继续保留。

## 身份和吊销

新凭证记录 `leader-mcp` 角色、空卡号、具体 agent id 和到期时间，不包含全局 supervisor token。每次 MCP 调用先验证随机凭证，再按当前登记和真实 agent 角色解析身份。worker 和定时任务会话不能导出或使用此凭证。未登记、未绑定、过期或已吊销的凭证，调用 `list`、`show` 也会被拒绝。

项目与看板 leader 的设置函数在修改登记前吊销原 agent 导出的凭证，覆盖 `supervise`、`handover` 和 leader 设置界面。失去任何一项登记都会吊销该 agent 的全部导出凭证，即使它仍负责其他项目；重新登记不会使旧凭证复活。不变的重复登记保留当前凭证。仍有有效登记的 leader 可以按当前权限重新导出。

通过设置页删除项目时，也会在保存前吊销原 agent 的导出凭证，与凭证导出共用配置锁。未变更的登记，以及因版本冲突或内容校验而被拒绝的保存，保留其凭证。

凭证沿用现有 leader 的项目和卡片权限检查，不取得直接终端身份的无限权限。agent 变成 worker、定时任务会话或登记不可读时，实时检查也会拒绝。没有 token 的终端身份分支保持原样。

## 信任边界

导出沿用受信本机 CLI 环境，不采信 MCP 客户端提供的身份；没有 HTTP 签发接口。`X-Paseo-Agent-Id`、请求体 agent id、URL token 和固定的 `Mcp-Session-Id` 都不能认证请求。不知道有效随机凭证时，改动 Bearer 值会验证失败。

文件权限只允许创建文件的本机账户读取，除非账户主动共享。取得 Bearer 副本的人在轮换、吊销或到期前可以作为绑定 agent 操作；服务端无法区分副本。已通过授权的进行中调用不会被取消。同一系统账户的进程仍属受信范围：它们本就能修改 CLI 环境、读取看板数据库或 supervisor token。本功能不隔离共享账户下的恶意进程。

## early-reset 日志

通知只查 AFC 配置 `opsProject` 对应的 `kanban.config.json` 中 `supervisors` 项；项目名忽略大小写匹配，精确键优先。此通知不会回退到 `supervisorAgentId`。

缺登记时日志明确指出 AFC 项目及登记字段。同一进程对连续缺登记状态只记录一次，项目名仅大小写变化不会重复。恢复登记或切换项目后可以再次记录。通知保留为待发送状态，后续轮次继续重试，只有发送成功才标记；原有七天发送窗口不变。
