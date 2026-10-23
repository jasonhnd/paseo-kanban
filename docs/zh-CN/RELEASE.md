# Git 发布与恢复清单

本批准备 Git-only 候选 **0.12.0.1**，公开基线为 v0.1.0-rc.23（`c6e740bedfd64691bd20270244efb1f803109b0f`）。候选须独立审查及另行授权才能发布；准备步骤不创建公开 tag 或 Release。package 与 lock 的四段版本号直接编辑，不用 npm version；插件 manifest 不写 version。

rc.6 新增有限暂时性读取重试，更正带宿主看板链接、首页 Command Center 范围与 manifest 图标说明。已公开 rc.5 仍冻结在 `db1ef026c2f528ac952e95d2bb7170f87fa3800b`，annotated object `44f501a2a6cda150b92d9fa9b5dfa48d03e7af5e`；其观察不认证 rc.6。保留 20 个开发／构建依赖告警（5 moderate、15 high），Git preparation 会安装这些包；记录的审计中两个根因通告均无上游修复版本，不加 force 的 audit fix 没有改动。见当前[变更记录](CHANGELOG.md)。

rc.7 把每张卡的临时目录从系统临时目录移到所配置项目的 `.kanban-work/<卡号>/`，测试不再往真实默认根写卡目录。显式 `KANBAN_TMP_ROOT` 只作为覆盖保留。采用新默认值须移除旧的 `KANBAN_TMP_ROOT`，并重开仍持有旧环境的 worker。已公开预发布 rc.6 于 2026-10-13 发布，GitHub Release 存在，仍冻结在 `c70df59d8516b7ecc9350ce5833fb177bafc335b`，annotated object `e9a630ffa6a3e1d71935305e6e1c9e05445b8364`。其观察不认证 rc.7。保留的 20 个开发／构建依赖告警（5 moderate、15 high）不变。见当前[变更记录](CHANGELOG.md)。

rc.8 在 provider 已停用或未知时跳过 thinking-catalog 警告，并让宿主 server bundle 不再读取 `fs.F_OK`（DEP0176）。保存的 MCP 端口复用与 rc.7 相同：端口空闲就复用，保存端口被占时仍会换端口，并把正在使用的 MCP 地址标成失效。新增集成测试记录官方 reload 的复用。已公开预发布 rc.7 于 2026-10-14 发布，GitHub Release 存在，仍冻结在 `2d6942643edb977072f8818b3d0c764b2ce1a057`，annotated object `be783dd6a6efcaeff7be6e4401fc23a026d43a76`。其观察不认证 rc.8。保留的 20 个开发／构建依赖告警（5 moderate、15 high）不变。见当前[变更记录](CHANGELOG.md)。

rc.9 修复 [GitHub issue #1](https://github.com/jasonhnd/paseo-kanban/issues/1)：手工 `--reviews` 审查卡可以打回仍是 `in_review` 的目标；approve 在这种情况下明确报错，不提升目标，审查卡自己的后续检查轮询也不提升目标。创建审查卡不认领目标。已公开预发布 rc.8 于 2026-10-14 发布，GitHub Release 存在，冻结在 `0af33ec7e49891bf3dba2549cb8b6b83487bba4c`，annotated object `303e4c27dd65f829743bc44c7242c1abd452c176`。其观察不认证 rc.9，精确 rc.9 门禁须有新的回执。依赖、schema 和契约版本不变，20 个开发／构建依赖告警保留。

rc.10 合成 [issue #2](https://github.com/jasonhnd/paseo-kanban/issues/2) 的 leader 清理权限及带审计的未合分支丢弃修复，以及 [issue #3](https://github.com/jasonhnd/paseo-kanban/issues/3) 的本卡 agent 清理范围、丢失工作区恢复及绑定运行世代的代交修复。已公开预发布 rc.9 于 2026-10-15 发布，GitHub Release 存在，冻结在 `701594d452f24dcbf115aabcedd4e9be9f5f6bcb`（annotated object `dda2f0044ec08e25979f35787b42a08f4687104e`）。其观察不认证 rc.10，只计新的精确 rc.10 门禁回执。依赖、schema 和契约版本不变。

rc.11 修复 [GitHub issue #4](https://github.com/jasonhnd/paseo-kanban/issues/4)：迁到新数据根后，Cursor 卡仍明确提示监控关闭，提供开启入口并保留可发现的连接按钮；授权后等待下一次定时采样，不刷新上次额度时间戳。监控与派活独立，可选读取器仍默认关闭，不导入凭证。已公开预发布 rc.10 于 2026-10-15 发布，GitHub Release 存在，冻结在 `e4e070e8bdc8a41a8f8bc61e66ded8e1950b0129`（annotated object `48c4c9feab7d0f02c0010d5754e00ed2a1ddf7aa`）。其观察不认证 rc.11，只计新的精确 rc.11 回执。依赖、schema 和契约版本不变。

rc.12 修复 [GitHub issue #5](https://github.com/jasonhnd/paseo-kanban/issues/5)：持久 `block --kind scheduled --until` 等待要求 ISO 时间带明确偏移且不超过七天。到点前不做 transient 重试、不提前报 doctor 红；到点后的 tick 使用持久唤醒 ID／正文和发送租约恢复一次，复用原有 agent 恢复及负责人 unblock。宿主发送结果未知时保留等待交负责人核对，不换消息 ID 重发。tasks 表通过正常增量迁移新增五个可空字段；依赖选择和契约版本不变，不导入凭证或旧存储。已公开预发布 rc.11 于 2026-10-15 发布，GitHub Release 存在，冻结在 `09963b85e0d7c9c5d881aa39e3c65ebbb719b7a0`（annotated object `042413d64aeee4f41c34120b4b3af4003c685741`）。其观察不认证 rc.12，只计新的精确 rc.12 回执。含待恢复定时卡的升级／回退及已认证 provider 发送仍未验证。

rc.13 合成 [issue #6](https://github.com/jasonhnd/paseo-kanban/issues/6) 与 [issue #7](https://github.com/jasonhnd/paseo-kanban/issues/7) 已审修复。当前 open 决策可通过完整规范化标题，或至少两条有辨识度的完整选项正文且推荐字母一致来确认；提醒与面向用户的帮助使用看板现名。丢弃审计只计其他本地分支、远端跟踪及 tag refs 均不包含的提交，优先本地已有比较基准，提示本地基准落后，不 fetch。权限、按审计 tip 删除及保留分支保护不变。已公开预发布 rc.12 于 2026-10-16 发布，GitHub Release 存在，冻结在 `4162cbca1acb2aa70ad1d5fb77c0c78f25c68ab2`（annotated object `a5d68644e9d02206e2cf07ee7d32005f59801ee9`）。其观察不认证 rc.13，只计新的精确 rc.13 回执。相对 rc.12，依赖选择、schema 和契约版本不变。有限选项分类、本地过时 refs、含待恢复定时卡的升级／回退及已认证 provider 发送仍有限制或未验证。

rc.14 修复 [issue #8](https://github.com/jasonhnd/paseo-kanban/issues/8)：正常临时卡清理接受配置的本地基准或成功 fetch 后 `origin/<base>` 任一包含卡 tip 的祖先关系。本地合并不再因 origin 过时或不可达而要求 push 或显式丢弃，本地包含关系同样允许删除卡分支；仅本地树内容相同仍不足以证明。清理完成后 doctor 的残留 worktree／workspace 红自然消失。既有 PR／squash 证明、丢弃权限、按审计 tip 删除、共享副本、活跃 agent、撤权／保留保护不变。已公开预发布 rc.13 于 2026-10-16 发布，GitHub Release 存在，冻结在 `b9d7a19d7c9373105650fcbd59e330e849169dfa`（annotated object `498e84c4dd46de3724d036754627db0d268b63e7`）。其观察不认证 rc.14，只计新的精确 rc.14 回执。相对 rc.13，依赖选择、schema 和契约版本不变。含待恢复定时卡的升级／回退及已认证 provider 发送仍未验证。

rc.15 修复共享临时目录的清理竞态：目录级 agent 清理因其他卡的 agent 仍指向该目录而失败后，若对账扫描落在重试时间之前，只看已完成卡自己的 agent 就把这一步记为完成，随后归档并删除目录。现在扫描只有过了重试时间、agent 列表可读且没有任何卡的 agent 指向该目录时，才判这次失败已完成；清理任务也不再把对账写入的行当作目录级清理已完成。其他卡的 agent 仍会让目录保留，行为不变。无对应 GitHub issue。已公开预发布 rc.14 于 2026-10-16 发布，GitHub Release 存在，冻结在 `25dfc5f352b3577b4b9810eab652ae60bac53c55`（annotated object `292c50ae341db5ac43589e678c328da56470d5fa`）。其观察不认证 rc.15，只计新的精确 rc.15 回执。相对 rc.14，依赖选择、schema 和契约版本不变。含待恢复定时卡的升级／回退及已认证 provider 发送仍未验证。

rc.16 让看板的项目名单以 Paseo 的项目列表为准：看板项目按目录与 Paseo 项目对照（从不比较名字），目录已不是 Paseo 项目的看板项目不再出现在 leader 面板、暂停区、首页、按项目页和看板里，也不发提醒、不唤醒、不派活，卡片与历史保留。读不到 Paseo 时沿用上次读到的列表；空列表要相隔至少 60 秒连续两次成功读到才算数。对外文档与发布说明仅用英文，中文文档保留在 `docs/zh-CN`，全新安装跟随系统语言。已公开预发布 rc.15 于 2026-10-16 发布，GitHub Release 存在，冻结在 `0f64d2009fd7fefefbc41edff8a79144c6411548`（annotated object `8919725b05cef190395f2a9ddaaebae7490cc0fe`）。其观察不认证 rc.16，只计新的精确 rc.16 回执。相对 rc.15，依赖选择、schema 和契约版本不变。合并后候选的真实浏览器挂载、含待恢复定时卡的升级／回退及已认证 provider 发送仍未验证。

rc.17 修复 [issue #9](https://github.com/jasonhnd/paseo-kanban/issues/9)：体检不再把项目主目录拼到插件安装目录下。配置里有、但没有 `workspacePath`、Paseo 也不知道目录、也没有卡片目录的项目，视为目录未知并安静跳过，不再出现 `worktree <路径>` 信息行和 `repo:skipped` 的 ENOENT 发现。相对路径的 `workspacePath` 只在日志里提示一次，不会拿插件目录或进程工作目录去解析；同一次扫描里相对路径的卡片、事件和 Paseo 目录同样被忽略。有绝对目录的项目行为不变，已离开 Paseo 的项目仍被过滤。已公开预发布 rc.16 于 2026-10-16 发布，GitHub Release 存在，冻结在 `6ed3be48e5e002351668a2d2d8765c2cca67413a`（annotated object `9747d649314d270b581d95ba5aebb37c0e4276b7`）。其观察不认证 rc.17，只计新的精确 rc.17 回执。相对 rc.16，依赖选择、schema 和契约版本不变。本候选的真实浏览器挂载、含待恢复定时卡的升级／回退及已认证 provider 发送仍未验证。

rc.18 只改看板运维和发布文档。卡片进入 done 或 archived 后，下一轮清理就删除其工作目录，不再等待 24 小时；清理红灯在目录消失后解除，inode、属主或 generation 不符时保留目录并给出具体原因。新卡在卡片临时目录用量超过 10 GiB 或磁盘剩余低于 50 GiB 时暂停首次开工，审查、返工和续跑照常。测试宿主保持语音和听写关闭，并共用一份只读官方 runtime。GitHub Release 正文只用英文，中文发布说明保留在 `docs/zh-CN/`。已公开预发布 rc.17 于 2026-10-16 发布，GitHub Release 存在，冻结在 `d7eec4188a108eb660c77f806b6ce91f85e5c26f`（annotated object `077ca0f5a83d2f827b1169c82ccfb0ece9307c8c`）。其观察不认证 rc.18，只计新的精确 rc.18 回执。相对 rc.17，依赖选择、schema 和契约版本不变。本候选的真实浏览器挂载、真实看板上的清理或容量刹车、含待恢复定时卡的升级／回退及已认证 provider 发送仍未验证。

rc.19 修复 [issue #10](https://github.com/jasonhnd/paseo-kanban/issues/10) 与 [issue #11](https://github.com/jasonhnd/paseo-kanban/issues/11)。体检不再把位于看板卡片临时目录里的 git worktree 报成红：卡未完成，或已 done／archived 且临时目录清理尚未失败时，至多一条 info，目录清掉后这条也消失。审查卡借了别的卡的临时 workspace、自己完成后会放开占用：只删自己的 agent，并立刻重试拥有者还在退避中的清理。已公开预发布 rc.18 于 2026-10-17 发布，GitHub Release 存在，冻结在 `d4ca860e01fb3256c2cc787d383b5de25bd396e5`（annotated object `9943de9e2b538a60368de7ab12641357a959d084`）。其观察不认证 rc.19，只计新的精确 rc.19 回执。相对 rc.18，依赖选择、schema 和契约版本不变。本候选的真实浏览器挂载、真实看板上的清理、含待恢复定时卡的升级／回退及已认证 provider 发送仍未验证。

rc.20 修复近期决策的提醒窗口（[issue #6](https://github.com/jasonhnd/paseo-kanban/issues/6)），并在删除已完成卡的目录时清理 worktree 登记（[issue #10](https://github.com/jasonhnd/paseo-kanban/issues/10)）：项目在最近 60 分钟内新建过决策时，leader 提醒保持安静；清理在删除目录前先注销嵌在里面的 git worktree。另加可选的 Hermes leader 集成：`hermes` provider 的 leader 创建、换班和登记转交，范围为整个 Hermes 档案而不是单个项目的记忆桥，以及带主机标识的客户端内导航。其他 provider 无需安装 Hermes 或 Python，加载插件也不会启动 Python。以下改动适用于所有 provider：会话按钮使用当前客户端内的导航（更新后请刷新页面；旧的桌面打开调用现在会返回错误），leader 换班在出现工具审批提示时也会继续等待。已公开预发布 rc.19 于 2026-10-17 发布，GitHub Release 存在，冻结在 `d63cdc419f6f99300342bda5716d68e37a3e4c97`（annotated object `65df87c70bb68bb5630f7cb5705ad33dc3b3a916`）。其观察不认证 rc.20，只计新的精确 rc.20 回执。相对 rc.19，依赖选择、schema 和契约版本不变。真实的 Hermes leader 会话、本候选的真实浏览器挂载、真实看板上的清理、含待恢复定时卡的升级／回退及已认证 provider 发送仍未验证。

rc.21 恢复 Paseo 0.12.x 插件加载（[issue #14](https://github.com/jasonhnd/paseo-kanban/issues/14)），并入固定命令入口（[issue #12](https://github.com/jasonhnd/paseo-kanban/issues/12)）及额度池／用量统计与自定义 GROK_HOME（[issue #13](https://github.com/jasonhnd/paseo-kanban/issues/13)）。Paseo daemon/app 支持 `>=0.11.0 <0.13.0`。官方 0.11.2 与 0.12.0 runtime 已通过隔离插件加载、调度 tick、MCP ping 与 CLI 建卡/show。为兼容两个宿主，保留共同的 0.11 SDK 锁定。已公开预发布 rc.20 于 2026-10-18 发布，冻结在 `bec4af0626d7f75e94dfdef9a577a5caa2cbd65e`（annotated object `e0e9cc3ae464c2200318f85042c982c3076d8aa7`）。前版证据不认证 rc.21。生产安装与真实认证 provider 发送属于后续独立工作。

## 版本及证据规则

单插件只有一个 package／version／CHANGELOG，id 为 `paseo-kanban`。0.x 兼容修复升 patch，新增或配置／行为破坏升 minor；1.x 按 SemVer。契约/schema 版本独立；兼容新增保留，破坏须明确迁移／恢复方案。

Git 分支可变。本候选仅在独立审查和另行授权后，创建不可移动的 v0.12.0.1 annotated tag 及 GitHub prerelease。须确认 v0.12.0.1 在本地和远端均未占用，不挪动或覆盖既有 tag。回退基线为公开 v0.1.0-rc.23（`c6e740bedfd64691bd20270244efb1f803109b0f`）。保存审过的完整 commit/tree 及 tag 身份、内容。

准备中的 RC 可用明确标注**待发布**的版本标题；验证发布前不写发布日期、不称 tag 可用。写明宿主范围、数据／契约变更、既有依赖告警及真测限制。官方 0.11.2 Git 下载使用 revision／`--ref`，manifest schema 不消费插件版本字段；package.json、package-lock.json 顶层及根 package 版本必须一致，不虚构 manifest 字段。不把源码检查写成 app/provider 认证。

## RC 发布计划 — 待发布

Release 标题为 **Paseo Kanban v0.12.0.1**，GitHub Release 必须标 **prerelease**。正文写精确审过的公开 RC commit/tree，链接英中 CHANGELOG，说明兼容／访问／数据风险，区分前版 c106 证据与 RC 验证。正文先准备供审查，不含私有路径、身份、配置、凭证或证据仓。

不同实际 model 审查、leader 亲看验收后，只有另获授权的发布主责可以公开批准的 commit／tag 并创建 prerelease。主责须重跑精确出站 branch／tag 的隐私／历史／身份门，确认远端 peeled tag 等于已审 commit，确认 GitHub Release 使用该 tag 且 prerelease=true。本计划不包含 force、替换 tag、npm 发布或 registry 提交。

**以下命令在远端确认后执行，不是待发布 tag 已存在的证据：**

```sh
paseo plugin install github:jasonhnd/paseo-kanban --ref v0.12.0.1 --json
paseo plugin ls paseo-kanban --json
paseo plugin update paseo-kanban --check --ref v0.12.0.1 --json
paseo plugin update paseo-kanban --ref v0.12.0.1 --json
paseo plugin ls paseo-kanban --json
```

tag 和完整 SHA 各用全新隔离 home 实测。从公开 rc.23 安装开始，预览并更新本候选、显式 reload，确认精确 revision 和 running、四份配置及卡片/事件不丢；再回退 rc.23 并 reload。真实客户端与已认证 provider 闭环须另行验证。

```sh
paseo plugin update paseo-kanban --check --ref v0.1.0-rc.23 --json
paseo plugin update paseo-kanban --ref v0.1.0-rc.23 --json
paseo plugin reload paseo-kanban --json
paseo plugin ls paseo-kanban --json
```

发布交接记录精确 CLI/daemon/app 版本、命令／退出码、前后 source/revision/path/enabled/version、代码与数据保留、清理和限制。tag 安装及新 RC GitHub／UI 重放通过前仍为待做。公开前用本卡本地 `file://` Git 源核精确候选，不能证明未来 GitHub tag。daemon 与 app 均须 `>=0.11.0 <0.13.0`；macOS arm64 官方 0.11.2 为实测基线，Node 要求 >=24.21.0。声明范围不认证其他 patch／平台或已认证 provider。

相对 c106，本 RC 保留已审的产物验收、决定面板、托管更新命令路径及默认过期策略准入修复。rc.5 另修成功新 run 后的当前 blocked/cooldown 状态及过期诊断措辞，更新侧栏和 Command Center 入口，加入匿名界面媒体，提高 Node 下限并同步 package／lock 元数据和文档。契约版本和依赖选择不变。rc.12 通过正常增量迁移新增五个可空定时等待字段，不导入凭证或旧存储。切换代码／来源前保持统一根、停派活与写者、备份一致状态及宿主设置。代码回退保留当前写入；另行兼容数据恢复可能丢失新写入。新装 enabled=true，全局插件开启时可能立即启动。插件开发／准备及官方宿主的既有依赖 audit／deprecated 告警未解决，交接保留精确观察。门通过不等于修复告警或稳定版证据。

## 仍保留的限制

`0.12.0.1` 继续保留这些限制：

- 信息导出可能在约 600 秒内仍指向已删除的 checkout。命令用当前安装路径并等待两份导出一致。这是必要条件，不证明命令写入可用；[更新与恢复](#更新与恢复)的动作复验为必需步骤。
- 已关闭决定的 Undo 只在当前挂载的面板里。离开或重新加载后 Undo 消失。已保存的 done 和零计数保留。
- pull request 产物只接受小写 `https://github.com/`。`https://GITHUB.COM/` 会被拒绝。
- 依赖 deprecated 和 audit 告警未解决。构建或隐私门通过不是 audit 修复。
- 物理手机、原生 app 和已认证 provider 闭环仍未验证。
- `0.1.0-rc.1` 或任一修复单独的精确结果，不是本整合 commit 的最终通过。
- 本 RC 的 GitHub 冷安装要等 GitHub Release 记录存在。不要用本地 `file://` 探针编造该结果。

## 发布正文的替换

GitHub Release 正文只用英文，先供审查；中文发布说明保留在 [`docs/zh-CN/`](RELEASE.md)。下面的记号只整段替换：

| 记号 | 替换成 |
|---|---|
| `{{RC_VERSION}}` | `0.12.0.1` |
| `{{RC_TAG}}` | `v0.12.0.1` |
| `{{RC_COMMIT}}` | 已审完整 commit |
| `{{RC_TREE}}` | 该 commit 的 tree |
| `{{UTC_DATE}}` | 准备正文时的 UTC 日历日期，格式 `YYYY-MM-DD` |

`{{INSTALL_STATUS}}` 只能是下面两段之一。

已发布，且仅当 `v0.12.0.1` 的 GitHub Release 存在、标为 prerelease、目标 commit 等于 `{{RC_COMMIT}}`：

`The GitHub Release record for v0.12.0.1 on {{UTC_DATE}} targets {{RC_COMMIT}}. Install with --ref v0.12.0.1.`

未发布，即该 Release 记录不存在：

`No GitHub Release record for v0.12.0.1 exists as of {{UTC_DATE}}. The candidate is unpublished. Do not install v0.12.0.1 from GitHub. v0.1.0-rc.1 was local preparation only; rc.1 and rc.2 were not published.`

准备稿使用未发布那一段。以后的发布者把整段换成已发布那一段。在已发布记录给出自己的日期之前，UTC 日期是准备正文的日期。正文不含私有路径、身份、配置、凭证或证据仓。

## 候选发布前

- [ ] 从批准的公开祖先建干净 clone，只改允许范围，不合未公开开发历史。保存 base、完整 commit/tree、patch/bundle hash 和文件清单。
- [ ] 在**最终整合候选**运行锁定 `npm ci`、构建、`npm run verify`。13 闸含真实 Paseo 编译、插件测试、源码／可达历史／身份／泄漏、契约、真实包字节，全部本机通过；分卡通过不代表整合通过。
- [ ] 核 `npm pack --dry-run --json` 和真实包字节、八个生成命令、Node 独立运行。产物放仓外；pack 是内部门，不是 npm 发布。
- [ ] 不同实际 model 独立审查、leader 看精确 diff 后验收。Git 干净，公开前记录结论。
- [ ] 隔离 home/cache/data/port，不用生产配置／凭证；测试本地 Git 精确获取／准备、ref 升降级、失败保留、同 id directory 转 Git。另测 `NODE_ENV=production`。
- [ ] 真正安装产品后测桌面／紧凑页面、侧栏／深链／workspace、board/Fleet、语言／主题、RPC 成功／错误和清理。真实手机／认证 provider 首卡单列；mock／匿名 DOM 不替代。
- [ ] 验默认及显式数据根、宿主 settings/enabled 恢复、CLI 路径、独立代码／数据回退。macOS/Linux/WSL2 各留证，未测或不支持明确保留。
- [ ] 确认所有者公开授权和私下漏洞报告；另按批准的普通 push 发布已审 ref。不暗含 force、无关 ref、npm 或目录申请。
- [ ] 从 GitHub 重查最终完整 SHA，与已审产物比对，第二个 fresh home 重放 README。留证后才称该远端候选已验证。

本集成不启用或依赖 hosted CI；交活／合并前本机跑所需测试和构建。外部 CI、发布、其他卡完成可列等待，不能冒充本机通过，也不因此搁置已备好的交接。

## 发布记录模板

| 字段 | 必需证据 |
|---|---|
| 身份／版本／状态／日期 | 单插件包版本、实验／发布状态、验证日期。 |
| 公开来源 | 仓库、明确分支或已存在 tag、完整远端 commit。 |
| base／候选／最终 | 完整 base、候选／最终 commit/tree，差异和重新验证。 |
| 产物 | bundle/patch/pack hash、允许文件清单。 |
| 环境 | daemon/app/CLI/Node/npm/OS；使用时记录 provider、实际执行／审查 model。 |
| 契约／数据 | schema/manifest hash、稳定根、兼容证据、迁移限制。 |
| 本机检查 | 命令、退出码、测试总数、13 闸、CLI/Paseo 构建。 |
| 安装／画面 | 本地 Git、远端 fresh 重放；真实 desktop/compact/phone 分列。 |
| 首卡 | 完成、异 model 审查、leader 验收、清理；缺条件标明。 |
| 恢复 | 一致数据备份、宿主设置／enabled、失败更新和来源／代码／数据恢复证据。 |
| 审查／授权 | 精确产物、审查结论、leader 验收、授权渠道。 |

## 命令重放清单

下表记录**前版 c106 证据**，不是本次未发布 RC 的结果。c106 发布报告确认在 macOS arm64、Node 24.21.0/npm 12.1.0 通过真实 GitHub 分支／完整 SHA 安装、预览／更新／降级／再升级、来源转换、已安装 CLI/RPC 及 Edge 中官方 0.11.2 Web UI；下表也区分更早的本地负例／数据恢复探针。RC 主责须记录本次精确候选／宿主、命令、退出码、前后结果；发布主责在新 RC 公开后重放 tag 和完整 SHA。日志私密，摘要匿名。

child env 使用新测试 home，每条连接命令明确 CLI endpoint，例如 `paseo --host "$PASEO_TEST_HOST" plugin ...`，endpoint 为 `tcp://host:port`。本地 daemon 启动用 `--home "$PASEO_TEST_HOME"`；**不能同时传 --home 与 --host**，0.11.2 target guard 会拒绝。插件／SDK 的 `PASEO_URL` 另用带 `/ws` 的 WebSocket URL，不等于 CLI --host。白名单 env，不继承 agent 身份／token，relay/provider 禁用，可选适配器明确 false；真 provider 只用用户自己建立的隔离登录，不拷生产认证。

| 重放项 | 要求与本文当前状态 |
|---|---|
| `paseo --version`、顶层/plugin/install/update help | 已记录 0.11.2 CLI 与真实隔离 daemon，help 已核。 |
| `install github:jasonhnd/paseo-kanban --ref integration/single-plugin-reviewed --json` | 前版 c106 GitHub 分支重放通过；新 RC tag 待发布。本地 file:// 不算远端 RC 通过。 |
| 最终公开 SHA 安装；先本地 `file://` 精确 SHA | 前版 c106 本地／GitHub 完整 SHA 安装在 fresh cache、NODE_ENV=production 下通过，八 bundle 可用；精确新 RC 与公开 tag 须重跑。 |
| `ls paseo-kanban --json`、`logs paseo-kanban --json` | 本机已核真实安装来源/revision/path/enabled/加载状态及脱敏日志。 |
| 重复同 id／不存在 ref | 本地拒绝后旧 path/revision/enabled/data 及 RPC 保留。 |
| `update paseo-kanban --check --ref "$REVIEWED_COMMIT" --json` | 本地预览未改 revision/path/state。 |
| `update paseo-kanban --ref "$REVIEWED_COMMIT" --json` | 已核本地精确新版、已安装 CLI/RPC/UI 及稳定数据根。 |
| `--ref "$PREVIOUS_COMMIT"` 预览／降级／再升级 | 本地降级／再升级保留数据；代码降级不撤回后写入。 |
| 本地 bad prepare/compile/activation refs | 真实准备失败、语法编译失败和 activation 异常后旧 revision/path/enabled/running 与 RPC 保留；仅类型错误不算 transpiler 失败用例。 |
| `disable`／`enable`／`remove`／同 id 重装 | 本地生命周期／外置根已核；新装 enabled=true，旧 disabled 须明确恢复。 |
| 开发 directory install/edit/typecheck/reload | directory 明确 ref 更新报 `Plugin is a local directory: paseo-kanban`；独立坏 directory reload 保持 failed，修复／重载后恢复，不自动回退。 |
| directory 转 Git 及反向 | 默认／显式匿名根、设置／语言、CLI/exports、enabled 恢复已核；真实 provider/scheduler 连续性未验证。 |
| 匿名一致备份与数据恢复 | 停写且 SQLite checkpoint busy=0；代码降级保留后写入，另行恢复兼容备份才撤回。未执行生产恢复。 |
| 已安装 `paseo-kanban.mjs --help`／`list --json`、`roles.mjs ls`、doctor | 已核 Node 命令与同根；无 profiles/providers 时 doctor red／exit 2 为预期，不表示认证设置成功。 |
| 真 desktop/compact/phone | 本机 Edge 中官方 0.11.2 Web app 的桌面／compact 已测，compact 关闭侧栏后核正文／操作；物理手机、原生 Electron 未验证。 |
| 真 provider 首卡 | 用户自建隔离登录及真实执行／审查／leader 闭环仍未验证；匿名连续性卡、无 agent workspace 不替代。 |

前版 c106 Web 观察区分 99 个成功 plugin RPC、1 个预期 stale-save conflict、0 个非预期错误，不证明新 RC UI 已测。只有响应数不能称零 RPC 错误。更早的整套单命令 lab bootstrap 仅做 syntax 检查，组件命令及最终候选关键重放分别真实执行。发布记录保留受测 SHA/tree、安装 revision、版本化日志和原图，每个最终候选重跑所需门。RC 发布／GitHub 重放、生产切换与 registry 提交仍为独立操作。

`REVIEWED_COMMIT`／`PREVIOUS_COMMIT` 取发布记录完整公开 SHA；未公开候选用本地 `file://`，不虚构远端。分支可能在预览／应用间前进；受控发布用预览精确 SHA。坏失败测试 ref 绝不 push。

官方依据：[0.11.2 reference](https://github.com/getpaseo/paseo/blob/75953250959979b8f088bbca8dbd6ee61d0151b1/public-docs/plugins/reference.md#cli-reference)、[publishing](https://github.com/getpaseo/paseo/blob/75953250959979b8f088bbca8dbd6ee61d0151b1/public-docs/plugins/publishing.md)、[现行 registry 审查快照](https://github.com/getpaseo/plugins/blob/06c64d182a3b0e0d879992231d1cf3c9a6bbf809/REVIEW.md)。语法／文档核对不认证运行行为。

## 更新与恢复

记录当前／目标完整 commit、来源类型、实际路径、根、enabled。停派活／写者，做[一致数据及独立宿主设置备份](DATA.md#备份和数据恢复)，明确 SHA 预览／应用：

```sh
paseo plugin update paseo-kanban --check --ref "$REVIEWED_COMMIT" --json
paseo plugin update paseo-kanban --ref "$REVIEWED_COMMIT" --json
paseo plugin ls paseo-kanban --json
```

核 policy/matrix，并完成以下复验。

每次升级或代码回退后，保持停派活，直到同一宿主报告目标完整 revision、当前安装路径、enabled/running，且数据根和设置未变。更新 `BOARD_INSTALL`，从该路径运行已安装 Node CLI。等待两份导出都指向该路径，再在真实面板用获准的可丢弃决定：关闭，核两处计数和已存 done；在面板仍挂载时 Undo，再核恢复为 open。导出一致或只有 running 都不证明写入可用。动作失败时保留错误，继续停派活。

回退到 c106 或未改动的本地 rc.1/rc.2 代码时，**更新后必须在同一宿主运行 `paseo plugin reload paseo-kanban --json`，确认 running 再做上述复验**；这些旧版本在模块加载时缓存命令路径。reload 和所有 plugin 命令使用同一个 `--host` 或本地 `--home` 选择器，绝不同时用两者。GitHub 回退不可使用未公开 tag。reload 失败保持 failed，修复／重载前不恢复，不是自动回退。仅加载本代码改动无需重启 daemon。

恢复前还须通过获准的 demo 闭环。托管更新失败保留旧安装，仍核 revision/path/enabled 和功能。reload 失败须修复／重载，不自动回旧 bundle；只加载源码变化不需重启 daemon。

Git 代码回退在 `update --check --ref`／`update --ref` 指已验证旧公开 SHA，保留当前数据并核 schema。数据恢复另行明确授权：停全部写者、用一致兼容备份，先保留当前状态，因为会丢后续写入。不因更新错误自动恢复数据。

## Directory 转 Git 操作预案

**仅准备，未执行生产迁移。** 使用侧操作者需要实际来源／运行方式切换授权、最终审过的远端 SHA 和已通过的隔离转换／恢复证据。本文不授权 agent 读生产配置、数据库或凭证。

1. 确认目标 host、同 id `paseo-kanban`、旧 directory 路径／source/enabled、实际统一根；保持 `PASEO_HOME` 和 `KANBAN_DATA_DIR`。另存宿主设置／语言／enabled、一致私密根备份，保留旧源码原样。转换不顺便导入旧 Fleet。
2. 停派活、定时 helper 和全部写者。先演练安装期间持续有效的暂停机制：0.11.2 新装设 enabled=true，即使刚移除的来源为 disabled；全局开关已开时立即启动。无法控制时不做生产转换；一次 warmed-cache 隔离 directory 转 Git 演练以 100 ms 采样测到成功 board RPC 之间 19.67 秒中断，仅供规划参考，不保证生产时长或可用率；目标环境另测。
3. 同一 host 先 disable/remove directory；源目录保留，但宿主设置可能删除。directory 不能普通 update 转 Git，同 id install 须先 remove。

   ```sh
   paseo plugin disable paseo-kanban --json
   paseo plugin remove paseo-kanban --json
   paseo plugin install github:jasonhnd/paseo-kanban --ref "$REVIEWED_COMMIT" --json
   paseo plugin ls paseo-kanban --json
   ```

   非默认目标每条选择对应 `--host` endpoint 或本地 `--home`，绝不能同用。不手改 source entries、不以 config reload 冒充生命周期切换。
4. 确认 Git 来源／完整 revision／新 path，server/board/Fleet/CLI/exports 同根，`KANBAN_HOME` 不绑废弃位置。恢复 settings／意图 enabled，刷新 CLI／导出；核策略／矩阵、roles、卡数、running/error/tick、真 desktop/phone 和允许的 demo 后才恢复派活。手机／provider 缺证据仍列未验证。
5. 失败保持停写、旧 directory 不变。有 Git entry 才 disable/remove，然后 `paseo plugin install "$PREVIOUS_DIRECTORY" --json` 重装原 directory，恢复 settings/enabled，核同根/CLI/UI。变量为先记录的旧源码绝对路径；这是代码／来源恢复，不是数据恢复。

仅源码 install/update/reload 不需重启。改启动环境、数据根、relay/provider 是另一运行变更，另需授权及重启方案；重启可中断 agent。此转换保留这些值，不迁移／合并旧库；生产路径及备份由使用侧私密保管。

## 官方目录申请草稿

**仅草稿，未提交、未收录。** 官方 CLI 直接 Git 下载与官方目录审核独立。未来递交前复核现行政策，当前快照见上。申请通常形成固定产物的 review PR，由维护者审核合并；push Git 不自动收录，也不更新已批准 pin。

| 草稿字段 | 建议内容／待补证据 |
|---|---|
| 入口 | [官方申请表](https://github.com/getpaseo/plugins/issues/new?template=submit-plugin.yml)。 |
| 名称 | Paseo Kanban。 |
| Source | `https://github.com/jasonhnd/paseo-kanban/tree/<REVIEWED_PUBLIC_COMMIT>`；发送前替换成最终已审完整公开 SHA。 |
| 分类 | Orchestration 首选，Sidebar 次选。 |
| 描述 | 跨项目 coding-agent 卡片、Fleet 阵容／额度策略、独立审查及 leader 验收。 |
| 配置／访问／限制 | [OVERVIEW](../../OVERVIEW.md)、版本／平台限制、[DATA](DATA.md)、已完成发布证据。 |
| 图片 | 至少一张匿名真实安装界面，优先 PNG、HTTPS asset URL；仍须提供并验证。 |
| 产物审查 | 根 manifest、双 entry、锁来源、准备及八个 CLI 用途、精确公开 commit/hash、MIT 归属及访问说明。 |

当前表单 Source 必填并提供分类；可视界面按目录审核规则要合适图片，这是 listing 要求，不是 Git install parser 要求。账户登录／2FA／作者授权由用户掌握。agent 不提交、不公开私密资料，不承诺官方结论／日期；registry Git 更新须再审 pin，本直接 Git update 指南不更新 listing。

项目自行规定：成功日用后另定是否申请目录。称稳定前至少 **14 天、20 张真实需求完整卡**，覆盖工作角色、独立审查、重启、受支持 patch、demo 数据恢复，无未解 P0/P1；不造活凑数。这不是官方直接 Git 安装前置；1.0 需更长证据及另定。

现状每项只留一条有证据的已落地／坏了／未验证／待做／死路，变化时移栏。本机[离线运营演练](OPERATIONS-DEMO.md)不连 GitHub／活 daemon，不替代真实安装和 provider 检查。[English](../RELEASE.md)

## Command Center 与图标的宿主限制

官方 0.11.2 Web 的空首页没有本安装的宿主上下文，不显示「打开项目看板」Command Center 动作；先从侧栏打开 Paseo Kanban。manifest 的 `assets/icon.png` 用于未来可能的 registry 展示，0.11.2 的 Settings -> Plugins 列表不显示它。见[兼容性](COMPATIBILITY.md#command-center-与-manifest-图标)。这不是宿主行为修复，不声明 registry 已收录。
