# 一卡一机云执行（未发布）

云执行需要同时满足：项目 `cloudRunner.enabled` 开启、卡带 `cloud` 标签、
角色为执行、仓库确实可以匿名公开访问。当前仅允许 `paseo-clear-chat` 开启。
默认关闭；未标卡、其他角色、关闭开关的项目继续走本地。标记上云后选择 Claude
等不支持的档案，或无法证实仓库公开时，会在开机前 block `capability`。

完整 JSON 示例见[英文配置说明](../CLOUD-RUNNER.md#configuration)。
在 `projects.<project>.cloudRunner` 下配置：

| 字段 | 默认值和约束 |
| --- | --- |
| `enabled` | `false`。开启后仍需 leader 给具体执行卡加 `tags: ["cloud"]`。 |
| `runtime` | `npm`；`bun` 仅保留配置和校验，执行明确拒绝为“未实现”。 |
| `runtimeVersion` | 可选精确三段版本，如 `24.20.0`。npm 下表示 Node 版本：模板必须已有该版本，不匹配会在安装依赖前停止并删机，不自动换装。Bun 版本如 `1.4.2` 可以解析，安装和执行仍未实现。 |
| `mode` | `per-card`；`persistent` 仅保留配置值，执行明确拒绝为“未实现”。 |
| `directories` | `["."]`。元素可以是目录字符串，或 `{"path":"web","installCommand":["npm","ci","--ignore-scripts"]}` 对象；未指定的逐目录命令继承项目 `installCommand`。先逐目录安装，再在仓库根运行 AI，再逐目录测试。任一步失败就停止并删机。拒绝空列表、绝对路径、越界和目录符号链接逃逸。 |
| `installCommand` / `testCommand` | argv 数组，默认 `npm ci --no-audit --no-fund` / `npm test`。支持 `npm run <script>`；命令必须匹配运行时，不接受 shell 字符串。bun 未来默认值为 `bun install --frozen-lockfile` / `bun test`。 |
| `environment` | 非密钥环境变量对象，键为大写变量名、值为字符串，可为空，如 `BLOB_BASE_URL` 和空的 `SEO_LIVE_BASE`。安装、AI、测试按字面值继承。拒绝疑似凭证、含 TOKEN/SECRET/KEY/PASSWORD 的键，以及启动、凭证或卡临时目录覆盖。`TMPDIR` 和 `KANBAN_TMP` 始终由看板生成。 |
| `snapshot` | `tpl-agent`。仅用模板已有登录，不读取或复制 Mac 登录文件。 |
| `maxParallel` | `2`，范围 1～5；同时受现有全局、角色、池容量门禁约束。 |
| `retryIntervalSec` / `maxCreateAttempts` | `75` 秒 / `8` 次。no_capacity 期间释放运行槽；超上限保留 ready hold，不增加失败计数。需要继续时可增加尝试上限。 |
| `machineTimeoutSec` / `taskTimeoutSec` | `5400` / `2400` 秒；任务期限必须短于机器寿命，开机必带 `--on-timeout kill`。 |
| `templateRefreshedAt` | 可选 ISO 模板刷新时间。Grok 默认第 6 天提示、第 7 天拒绝，可用 `templateWarnAgeDays` / `templateMaxAgeDays` 调整，最长 7 天。未填日期也识别运行中的登录过期。 |
| `mirrorRoot` | 可选本机绝对目录；默认项目目录旁 `_mirrors`，每仓库一个 bare、blobless mirror。 |

基准分支沿用项目 `baseBranch`：匿名克隆、任务分支祖先和草稿 PR base 都用它，
可为 `preview`。只推生成的 `kanban/cloud-...` 分支，不推或合并基准分支。
公开分支名不含内部卡号。

云端每次 exec 都创建 `$HOME/work/.kanban-work/<卡号>`，并把 `TMPDIR`、
`KANBAN_TMP` 导出为同一目录。安装、AI、测试均继承，日志、提示和 bundle 也放在
这里。本机 bundle 和 PR 正文使用卡的托管临时目录。

成功：ready → running → 云端匿名提交、bundle 回传 → 本机 fetch 成功 → 隐私与
身份扫描 → 推任务分支、开草稿 PR → 确认删机 → in_review。PR、提交和测试结果
记入交接；本地审查检查对应提交的临时副本，继续原有独立审查与 leader 验收。
返工从上一条公开任务分支开新机器，下一轮审查在旧副本清理后检查新提交。
首轮打回后下一个调度轮即可再派，不等待本地 agent 重派或上一代成功冷却；
容量和配额门禁仍有效。第二轮打回继续等待 leader 裁决。

Grok 未登录或过期会 block `capability`，原因写
“InstaBox 模板 tpl-agent 的 Grok 登录过期，需刷新模板”，并通知 leader；不进入
通用启动失败熔断。安装、执行、测试失败或超时都删机。取消、插件停止与重启
都有清理；启动只删本看板前缀遗留机器，保留其他活跃宿主进程负责的运行。
已保存的 PR 回执在清理后直接交审查，避免重复开 PR。

本机推前扫描 patch、路径和提交元数据：本机路径、用户名、内部单号（含短位数 PCC 单号）、CJK、
凭证和个人邮箱，并复用仓库私有词表解析器与匿名身份规则。命中或缺词表时
block `needs_human`，不推。词表只留本机。若删除无法确认，保存待清理记录、
暂缓新云派活并通知 leader；机器寿命 kill 为最后保障。

本改动进入后续候选版本，不换装、不发版。真机试跑另卡：需要人刷新并验证模板
登录、确认模板没有 GitHub 写登录、准备本机 CLI 登录与私有词表，再配置项目开关
并给试跑卡加标记。
