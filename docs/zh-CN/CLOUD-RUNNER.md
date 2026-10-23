# 一卡一机云执行（未发布）

云执行默认关闭，需要项目 `cloudRunner.enabled` 开启、卡带 `cloud` 标签、角色为
执行，并使用支持的 Codex 或 Grok 档案。未标卡、关闭开关的项目和其他角色继续走
本地流程。已启用并标记上云的卡选择 Claude 等不支持的档案时会拒绝派云。
只有 `localMirror` 必须显式写入 `source`；省略 `source` 时仍为 `publicGithub`。
仓库名字相同或没有 `origin` 都不会自动获得上云资格。

| `source` | 资格与交付 |
| --- | --- |
| `publicGithub`（省略时默认） | 仅限顶层 `cloud.allowedProjects` 名单内项目：开机前证明 GitHub 匿名访问，克隆配置的基准分支，回传 bundle，在本机 bare mirror 验证后推生成的任务分支、开草稿 PR。GitHub 写权限只留本机。私有或无法证实公开的仓库拒绝。 |
| `localMirror` | 仅显式启用的 `paseo-kanban`：从登记的本地仓导出匿名树快照，经 InstaBox exec 传 bundle，回传改动重放到本卡托管的本地分支，继续独立审查和本地 leader 验收合回。宿主这条路径不做 GitHub 发现，也不调用 `ls-remote`、`push` 或 `gh`。 |

本地模式白名单是 `server/cloud-config.ts` 中冻结的
`LOCAL_MIRROR_PROJECTS = ["paseo-kanban"]`，项目配置不能扩张它。导出和上传前
再次检查：项目登记目录必须是存在的 canonical Git 顶层目录，其 realpath 与所选
仓库根一致；拒绝符号链接别名、父仓内子目录和卡片指定的替代根目录。卡必须是
没有远端发布要求的 `local-only` 合约。

档案允许直接 executor 或 `candidateFor: "executor"` 的执行候选，审查候选仍拒绝。
Codex 必须是 OpenAI family、`gpt-*` model；Grok 必须是 xAI family、`grok-*`
model。所有 provider 都要求标准速度，包括显式选档；带 fast/priority 设置的档案
会被拒绝。云端 Codex 命令不设置 `service_tier` 或请求 fast/priority。

每卡每代从配置的模板（默认 `tpl-agent`）开独立机器，只用模板已有的 provider
登录。看板不读取或复制 Mac 登录文件。安装、AI 和测试均在机器上执行，必须确认
删机后才能交审查。

## 配置

完整公开模式 JSON 示例见[英文配置说明](../CLOUD-RUNNER.md#configuration)。
本地模式的关闭状态示例：将 `workspacePath` 换成项目登记的真实 canonical 仓库
目录，`baseBranch` 必须存在。真机运维试跑准备好之前保持关闭。

```json
{
  "cloud": { "allowedProjects": [], "maxMachines": 3, "deleteTimeoutSec": 180, "deletePollIntervalSec": 5 },
  "projects": {
    "paseo-kanban": {
      "code": "DEMO",
      "defaultWorkspace": "dir",
      "workspacePath": "/srv/projects/paseo-kanban",
      "baseBranch": "main",
      "cloudRunner": {
        "enabled": false,
        "source": "localMirror",
        "snapshot": "tpl-agent",
        "maxSourceBytes": 10485760,
        "maxResultBytes": 10485760,
        "maxParallel": 1,
        "taskTimeoutSec": 2400,
        "machineTimeoutSec": 5400
      }
    }
  }
}
```

公开模式必须同时满足顶层 `cloud.allowedProjects` 项目名单、项目开关、cloud 标签、
执行角色、支持的档案和可匿名读取的 GitHub 公开仓。项目键与仓库名可以不同。
示例保持空名单和关闭开关；需要上云时才添加目标项目键，私有仓即使在名单内也拒绝。

名单外项目即使写了 `enabled: true`，整份配置仍照常读取；仅该项目的云卡 hold，
每张卡写明拒绝原因，并向 leader 按项目发送一次警告。发送失败会在后续资格检查重试，
成功标记跨重载保留，项目恢复资格后清除。其他项目和不带 cloud 标签的卡照常派发。
仅有名单外项目启用时不会触发云清单读取。localMirror 继续独立使用静态名单。

顶层 `cloud` 设置由所有项目、两种源模式共享：

| 字段 | 默认值和约束 |
| --- | --- |
| `allowedProjects` | 默认 `[]`，允许 publicGithub 上云的项目键数组；不会扩张 `LOCAL_MIRROR_PROJECTS`。 |
| `maxMachines` | `3`，整数 1～5；全看板运行中的云卡代数上限。各项目另算自己的 `maxParallel`，并同时满足普通全局、角色、池门禁。需为账户里的常驻机、非看板机器（含暂停／停止机）预留名额。 |
| `deleteTimeoutSec` | `180` 秒，整数 1～600；一次同步 rm 及清单复核共用的独立清理期限，启动遗留机器清理同样适用。 |
| `deletePollIntervalSec` | `5` 秒，整数 1～60；未确认删除时两次清单读取间隔，最多等到清理期限。 |

本机 CLI 的 `rm` 默认等待操作完成，`--no-wait` 才提前返回。看板只发一次 rm，
给足独立清理期限，再按间隔读取 `ls --json`。仅成功、合法、未截断的清单不再列出
该机器，才确认删除；删除中仍算存在。读取失败、格式错误、截断均不能证明删除。
取消／超时后清理使用新的 signal；清理超时保留 receipt、不交审、hold 新云派活并
通知 leader。启动对账清理遗留机器也必须走同样的等待确认。

在 `projects.<project>.cloudRunner` 下配置：

| 字段 | 默认值和约束 |
| --- | --- |
| `enabled` | `false`。开启后仍需 leader 给具体执行卡加 `tags: ["cloud"]`，并通过对应 source 的项目资格门。 |
| `source` | 省略为 `publicGithub`。`localMirror` 必须显式选择并通过静态白名单及根目录检查；仅选择 source 不会开启云执行。 |
| `maxSourceBytes` / `maxResultBytes` | 本地模式源/结果 bundle 各默认 `10485760`（10 MiB），必须是正安全整数。源在开机前检查，结果在下载数据块前及导入前检查。统计 base64 编码前的原始 bundle 字节。 |
| `runtime` | 支持 `npm` 和 `bun`。每个目录安装前，npm 必须有 `package-lock.json`，bun 必须有 `bun.lock` 或 `bun.lockb`；缺锁即失败。 |
| `nodeVersion` / `bunVersion` | 可选精确三段版本，安装依赖前分别比对 `node --version` 和 `bun --version`，不接受小版本差。Node 必须由模板预装。缺失或不符会写明原因、任务失败并删机。 |
| `runtimeVersion` | 两种运行时均作为 `nodeVersion` 的兼容别名；显式 `nodeVersion` 优先。 |
| `bunSha256` | 精确版本到架构摘要的映射，例如 `{ "1.4.2": { "x64": "<64 位小写十六进制摘要>", "aarch64": "<64 位小写十六进制摘要>" } }`。开启安装时必须包含所选版本；缺少云机架构摘要会安装失败。 |
| `installBun` | 默认 false。设为 true 必须提供 `bunVersion` 和对应的 `bunSha256` 条目；仅缺 bun 或版本不符时安装指定精确版本。安装失败或装后版本不符，任务失败并删机。 |
| `mode` | `per-card`；`persistent` 仅保留配置值，执行明确拒绝为“未实现”。与 `source` 是不同设置。 |
| `directories` | `["."]`。元素可以是目录字符串，或 `{"path":"web","installCommand":["npm","ci","--ignore-scripts"]}`；未指定的逐目录安装命令继承项目 `installCommand`。对象还支持 `optional`（默认 false）、`testCommand`（默认继承项目测试命令）和 `skipTest`（默认 false，只装不测）。可选目录不存在时跳过安装与测试，verification 记为 `skipped (optional, missing)`；目录存在时仍须具备对应运行时的锁文件。必需目录不存在仍失败。逐目录命令同样受运行时与子命令校验。先逐目录安装，再在仓库根运行 AI，再逐目录测试。任一步失败就停止并删机。拒绝空列表、绝对路径、越界和目录符号链接逃逸。 |
| `installCommand` / `testCommand` | argv 数组，默认 `npm ci --no-audit --no-fund` / `npm test`。支持 `npm run <script>`；命令必须匹配运行时，不接受 shell 字符串。bun 默认值 `bun install --frozen-lockfile` / `bun test`。 |
| `environment` | 非密钥环境变量对象，键为大写变量名、值为字符串，可为空。安装、AI、测试按字面值继承。拒绝疑似凭证、含 TOKEN/SECRET/KEY/PASSWORD 的键，以及启动、凭证或卡临时目录覆盖。`TMPDIR` 和 `KANBAN_TMP` 始终由看板生成。 |
| `snapshot` | `tpl-agent`。仅用模板已有登录。 |
| `maxParallel` | 本项目运行中云卡上限，默认 `2`，范围 1～5；独立于全看板 `cloud.maxMachines`，同时受全局、角色、池容量门禁约束。 |
| `reconcileRetrySec` | 清单读取／启动对账失败的退避秒数，默认 `[120,300,600,900]`。首档覆盖默认 60 秒调度周期及常见漂移，自定义首档也应大于调度周期。最后一项重复。允许 1–16 个正整数，各项不超过 900 秒；多个启用项目共用清单时取最短间隔。退避期间 tick 跳过 CLI，cloud 卡持续 hold，直到对账成功。首次失败及恢复各通过 AFC 通知 leader 一次；错误中的凭据、URL 和用户目录会脱敏。插件重启重置计时，已送达通知的去重标记保留。 |
| `retryIntervalSec` / `maxCreateAttempts` | `75` 秒 / `8` 次。创建阶段 no_capacity／quota_exceeded 释放运行槽；超上限保留 ready hold，不增加失败计数。增加尝试上限可继续重试。 |
| `machineTimeoutSec` / `taskTimeoutSec` | `5400` / `2400` 秒，各为 1～86400；任务期限必须短于机器寿命。宿主总期限包含导出、创建、上传、AI/测试、下载和导入。取消和超时终止工作，清理使用新 signal 和独立的有限时调用。开机必带 `--on-timeout kill`。 |
| `templateRefreshedAt` | 可选带时区的 ISO 模板刷新时间。Grok 默认第 6 天提示、第 7 天拒绝；可用 `templateWarnAgeDays` / `templateMaxAgeDays` 调整，最长 7 天。未填日期也识别执行中的登录过期。 |
| `mirrorRoot` | 仅公开模式使用：可选本机绝对目录，默认项目目录旁 `_mirrors`，每仓库一个 bare、blobless mirror。 |

公开模式的匿名克隆、任务分支祖先和草稿 PR base 沿用项目 `baseBranch`，可以是
`preview`。只推生成的 `kanban/cloud-...` 分支，不推或合并基准分支，公开分支名
不含内部卡号。本地模式不推远端。

云端每次 exec 都创建 `$HOME/work/.kanban-work/<卡号>`，并把 `TMPDIR`、
`KANBAN_TMP` 导出为同一目录。安装、AI、测试均继承，日志、提示和 bundle 也放在
这里。本机 bundle 和公开模式 PR 正文使用本卡的托管临时目录。

## 本地快照、交付和审查

宿主钉住真实基线提交 **A**，只导出 A 的树，生成匿名、无父的根提交 **S**，
满足 `tree(S) = tree(A)`。源使用普通自包含 bundle，可在空仓克隆；原始历史、
作者和消息、其他 refs、Git 配置、未跟踪及未提交内容都留在 Mac。不使用不能满足
此协议的 depth-one 浅 bundle。

云端只返回 S 的一个匿名子提交 **C**。Mac 在隔离仓检查唯一引用、父子关系、
元数据、树、完整对象闭包及文件清单，然后把 S→C 的改动重放到真实 A 上，在本卡
所属的可写托管分支生成 **L**：`parent(L) = A`、`tree(L) = tree(C)`。
独立审查看 L；合回在仓库锁内再次核对分支尖仍为记录的 L。complete 不改基准
分支，leader accept 才走现有本地快进／rebase 流程，冲突回卡返工。C 属于匿名
快照历史，不直接进入本地 main。

local receipt 绑定 project/root、`sourceBase`（A）、`snapshotCommit`（S）、
`tree`、`cloudHead`（C）、`localHead`（L）、`runId` 和 `generation`，无需 PR URL。
重启通过导入日志或宿主盖章的 receipt 恢复 L，不重复执行云任务。返工从上次 L
重新导出，继续同一所属分支。并发卡各自固定 A，另一张卡运行期间基线前进不会
混用映射；容量重试会重新钉基线并扫描。

## 隐私和传输范围

本地模式开机前的 `scanOutbound` 检查钉住树的所有路径（含目录）、文件模式和
blob，包含未改文件、二进制和贡献者扫描通常忽略的扩展名。即使 diff 不含秘密，
源文件含秘密仍拒绝上云。实际发送的 brief、审查反馈、环境变量键和值，以及
安装／测试参数、目录、运行时、provider/model/effort、模板等执行设置也要扫描。

规则包含完整本机 denylist、本机路径、内部单号、凭证和私人邮箱。源树 locale
路径保留既有语言许可；不确定命中、缺规则／对象／词表都默认拒绝。除压缩 bundle
限额外，源 blob 解压扫描累计超过 128 MiB 也拒绝。

源码逐处审批绑定路径、完整行、匹配跨度和规则，改动后失效，不豁免 brief、反馈
或环境变量。下载后，返回 patch、路径及真实重放 L 还要通过既有更严格的出站结果
规则（包括拒绝 CJK），并核对云提交匿名身份。诊断只写类别，不回显私密字节。
词表和宿主凭证不发送。提供商会收到已放行的源码和提示，base64 只是传输编码；
机器名和临时路径仍带卡号，快照匿名不代表所有调度元数据匿名。

本地 bundle 经现有 `instabox exec` 分块 base64 双向传输，不依赖 stdin 或文件
上传 API。线上每块最多 32 KiB，完整命令最多 61440 字节；核对序号、长度、块
摘要及最终字节数／SHA-256 后才原子重命名。有限重试后仍损坏、截断、超限或被
取消时停止并清理 staging。本地任务脚本编码后也受 61440 字节限额约束。
上传和下载共用任务总期限，耗时取决于分块往返和网络，没有独立吞吐保证。
任务期限结束后删机仍用新的清理 signal。

本地脚本从 bundle 克隆，提示 AI 不接触 GitHub，克隆后禁用普通 HTTPS/SSH Git
传输并设置禁止推送的 URL。这是仓库策略，不是网络沙箱；其他协议、进程联网和
Git 命令行覆盖需要另行加强隔离。宿主本地模式流程本身不执行 GitHub 操作。

## 状态和恢复

- 成功：ready → running → 确认删机 → in_review。公开模式交接草稿 PR／public
  receipt，本地模式交接 L／local receipt；之后仍由独立审查和 leader 验收。
- 首轮打回后，下个调度轮可开新云代，不等待本地 agent 重派或上一代成功冷却；
  容量和配额门禁仍有效。第二轮打回继续等待 leader 裁决。
- 创建阶段 `no_capacity`／`quota_exceeded`：回 ready、记录重试期限并释放槽，超尝试上限保留 hold，
  不增加启动失败数。执行阶段的同名字样不作为创建容量重试。
- Grok 未登录或过期：block `capability`，要求刷新配置的模板并通知 leader；
  不进入通用启动失败熔断。派发前也按模板日期检查过期。
- 隐私或身份问题：停止交付；出站／本地隐私命中 block `needs_human`，被拒结果
  不发布或合回。执行失败、超时、取消和插件关闭均清理机器。
- 启动对账只清理本看板前缀遗留机器，保留其他活跃宿主负责的运行，并 fence 旧代。
  已持久化的 public/local receipt 在清理后继续交审，不重复执行、重放或开 PR。
  无法确认删除则记录待清理状态，暂停新云派活并通知 leader；寿命 kill 是最后保障。

## 已知限制

- InstaBox 官方创建参数没有网络隔离或出站限制选项。没有 GitHub 写凭证的云上
  进程仍可能匿名连接外网（含 GitHub）。宿主 `localMirror` 编排零 GitHub 调用，
  这项保证不等于隔离了云上进程网络。
- 官方账户默认上限为 5 台，暂停和停止机也算。设置 `cloud.maxMachines` 前必须
  扣掉常驻机／非看板机器，例如常驻 2 台就只剩 3 台卡机名额。看板不自动发现
  账户剩余容量；多个看板实例共用账户时还需协调预算。
- exec 全账户同时最多 32 个、单条最长 10 分钟。增大 `taskTimeoutSec` 不能延长
  提供商的单条限制，长 AI／测试命令仍可能因此失败。
- 机器名和云上临时目录含卡号；源码快照匿名不能隐藏这些调度标识。

依据：[InstaBox 限制](https://instabox.sh/docs/limits)、
[SDK 参数与错误码](https://instabox.sh/docs/sdk)、
[CLI 参考](https://instabox.sh/docs/cli)。提供商限制可能变化，试跑前仍须核实账户。

## 本机验证与真机试跑

开发验证使用可丢弃的真实 Git 仓库和假的云、provider、GitHub 命令。先运行
`npm ci`、`npm run hooks`；unset `KANBAN_TOKEN`、`PASEO_AGENT_ID`，将 `TMPDIR`
和 `KANBAN_TMP`、`HOME`、`PASEO_HOME`、`KANBAN_DATA_DIR` 分别指向本卡托管
临时目录下的隔离目录，再运行 `npm run typecheck`、
`npm run build` 和完整 `npm run verify`，清理前保存验证结果。cloud 回归覆盖公开
默认行为、本地显式开启、隐私／快照映射、恶意结果、传输故障、并发基线、receipt
恢复、审查／合回冲突，以及故障、取消、超时、关闭插件时删机。本机通过后仍需
独立审查和 leader 验收，不代表已验证真实账户或模板。

本功能进入后续候选版本。真机试跑需要另开运维卡，由人先完成：

1. 登记生产项目 canonical `workspacePath` 与实际 `baseBranch`，仅对白名单项目
   显式选择 `cloudRunner.source: "localMirror"`；确认 local-only 卡合约、标准速度
   的合法执行档案及试跑卡 `cloud` 标签。
2. 核实宿主 InstaBox CLI 登录和本机私有词表；刷新并测试配置 `snapshot` 的
   provider 登录，准确填写 `templateRefreshedAt`。核实模板 Node/Git/timeout、
   运行时版本及安装／测试命令，确认模板没有 GitHub 写登录；不复制宿主登录文件。
3. 核实账户使用量（含暂停／停止、非看板机器）、删除和超时语义，将顶层
   `cloud.maxMachines` 设在剩余名额内，各项目另设 `maxParallel`，同时满足看板／池
   限制；默认值不是容量证明。确认源／结果字节限额及任务／机器期限。
4. 准备完成才开启项目。实际 tree、brief、feedback、environment 必须重新通过
   出站扫描；检查返回 L、local receipt 和删机确认，再走正常独立审查、本地验收。
   缺配置或 enabled 未开时，paseo-kanban 卡即使带 cloud 标签也走原本地执行路径。

本文和离线验证不修改生产设置、不换装发布，也不授权真实 provider 试跑。


云任务显式设置 `BUN_INSTALL="$HOME/.bun"`，并将 `$BUN_INSTALL/bin` 加到
`PATH` 首位，供安装、AI 和测试使用。可选安装从
`https://github.com/oven-sh/bun/releases/download/bun-v<bunVersion>/`
下载 `bun-linux-x64.zip` 或 `bun-linux-aarch64.zip`，按 `uname -m` 的
`x86_64`、`aarch64` 或 `arm64` 选择架构。先用 `sha256sum` 对照
`bunSha256[bunVersion][架构]` 校验发布包，再只提取 Bun 可执行文件到
`$HOME/.bun/bin`，最后重新检查 `bun --version`。不会执行远程安装脚本。
模板需要 curl、bash、sha256sum、unzip 和联网能力。不支持的架构、缺少摘要、
下载或校验或解压失败、装后版本不符都会使任务失败并删机。
模板已预装所需精确版本时保持 `installBun: false`。

新增版本时，从[官方 GitHub Release](https://github.com/oven-sh/bun/releases)
取得各架构发布包，核实来源，并通过可信渠道比对发布方公布的 SHA-256。
把经审查的 64 位小写十六进制发布包摘要加入 `bunSha256` 的对应版本条目，
与 `bunVersion` 一起更新。不要把云机下载后自行计算的摘要当作预期摘要。
摘要映射里缺少的版本或架构不会自动回退。
