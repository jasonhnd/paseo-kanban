# 变更记录

单插件使用一个版本与 CHANGELOG，通过 Git 分发。`0.1.0-rc.19` 是当前未公开、待独立审查的候选。已公开预发布 rc.18 于 2026-10-17 发布，GitHub Release 存在，冻结在 `d4ca860e01fb3256c2cc787d383b5de25bd396e5`（annotated object `9943de9e2b538a60368de7ab12641357a959d084`）。已公开预发布 rc.17 于 2026-10-16 发布，GitHub Release 存在，冻结在 `d7eec4188a108eb660c77f806b6ce91f85e5c26f`（annotated object `077ca0f5a83d2f827b1169c82ccfb0ece9307c8c`）。已公开预发布 rc.16 于 2026-10-16 发布，GitHub Release 存在，冻结在 `6ed3be48e5e002351668a2d2d8765c2cca67413a`（annotated object `9747d649314d270b581d95ba5aebb37c0e4276b7`）。已公开预发布 rc.12 于 2026-10-16 发布，GitHub Release 存在，冻结在 `4162cbca1acb2aa70ad1d5fb77c0c78f25c68ab2`（annotated object `a5d68644e9d02206e2cf07ee7d32005f59801ee9`）。已公开预发布 rc.11 于 2026-10-15 发布，GitHub Release 存在，冻结在 `09963b85e0d7c9c5d881aa39e3c65ebbb719b7a0`（annotated object `042413d64aeee4f41c34120b4b3af4003c685741`）。已公开预发布 rc.10 于 2026-10-15 发布，GitHub Release 存在，冻结在 `e4e070e8bdc8a41a8f8bc61e66ded8e1950b0129`（annotated object `48c4c9feab7d0f02c0010d5754e00ed2a1ddf7aa`）。已公开预发布 rc.9 于 2026-10-15 发布，GitHub Release 存在，冻结在 `701594d452f24dcbf115aabcedd4e9be9f5f6bcb`（annotated object `dda2f0044ec08e25979f35787b42a08f4687104e`）。已公开预发布 rc.8 于 2026-10-14 发布，GitHub Release 存在，仍冻结在 `0af33ec7e49891bf3dba2549cb8b6b83487bba4c`（annotated object `303e4c27dd65f829743bc44c7242c1abd452c176`）。已公开预发布 rc.7 于 2026-10-14 发布，GitHub Release 存在，仍冻结在 `2d6942643edb977072f8818b3d0c764b2ce1a057`（annotated object `be783dd6a6efcaeff7be6e4401fc23a026d43a76`）。已公开预发布 rc.6 于 2026-10-13 发布，仍冻结在 `c70df59d8516b7ecc9350ce5833fb177bafc335b`（annotated object `e9a630ffa6a3e1d71935305e6e1c9e05445b8364`）。已公开 rc.5 仍冻结在 `db1ef026c2f528ac952e95d2bb7170f87fa3800b`，下文保留其早先准备记录。rc.4 原 commit 与 tag 不变；rc.3 仍不得发布，rc.1 和 rc.2 仍为本地未公开候选。没有 npm 发布或官方目录收录。

## 未发布

## 0.1.0-rc.19 — 待审查与发布

本地候选 tag 为 `v0.1.0-rc.19`，只准备、不发布。匹配的 GitHub prerelease 与精确已审 commit／tag 独立核对通过后，才从 GitHub 安装。冻结的 rc.1 至 rc.18 tag 绝不挪动。

### 修复（Fixed）

- 体检不再把位于看板卡片临时目录里的 git worktree 报成红：路径在任一项目的 `.kanban-work/<卡号>/` 下，或在 `card_tmp_prepared` 记录的根目录里时，归到那张卡。卡未完成，或已 done／archived 且临时目录清理尚未失败时，至多一条 info，目录清掉后这条也消失。已有未关闭的 `tmp_cleanup_failed`，或无法归到任何卡时，仍按原规则报红。修复 [issue #10](https://github.com/jasonhnd/paseo-kanban/issues/10)。
- 审查卡借了别的卡的临时 workspace、自己完成后会放开占用：只删自己的 agent，并立刻重试拥有者还在退避中的清理；已完成卡上已归档或已清掉的 agent 不再挡住别的已完成卡，未完成的卡、仍存活的 agent，以及工作目录还在这个目录里的进程，仍然挡住。修复 [issue #11](https://github.com/jasonhnd/paseo-kanban/issues/11)。

### 说明（Notes）

- package 与根 lock 版本统一为 `0.1.0-rc.19`。Node 仍要求 `>=24.21.0`，Paseo daemon/app 仍要求 `>=0.11.0 <0.12.0`。相对 rc.18，依赖选择、schema 和契约版本不变，不新增存储文件，也不引入自动数据或凭证导入。保留 20 个开发／构建依赖告警。
- 产品变化是：体检如何看待卡片临时目录里的 git worktree，以及审查卡借走的临时 workspace 如何放开清理。发布文档把 rc.18 记为已公开预发布。rc.18 的共享 runtime、语音和听写默认值，以及 lsof 查找方式不变。
- 精确 rc.19 验证只计 rc.19 回执；此前 rc.18 成绩不认证本候选。GitHub 冷安装、本候选的真实浏览器挂载、已安装宿主生命周期、含待恢复定时卡的升级／回退、原生 app、手机、已认证 provider 闭环、其他平台与生产恢复仍未验证。本次准备不执行生产切换。

## 0.1.0-rc.18 — 待审查与发布

本地候选 tag 为 `v0.1.0-rc.18`，只准备、不发布。匹配的 GitHub prerelease 与精确已审 commit／tag 独立核对通过后，才从 GitHub 安装。冻结的 rc.1 至 rc.17 tag 绝不挪动。

### 变更（Changed）

- 卡片进入 done 或 archived 后，下一轮清理就会删除其工作目录，不再等待 24 小时，也不再按文件数设上限。删不掉时 doctor 报红，并按退避重试。目录一旦消失（包括已被提前删除）红灯立即解除；inode、属主或 generation 不符时保留目录，并只提示一次具体原因。清理先按 PATH 找 `lsof`，找不到再试 `/usr/sbin/lsof` 和 `/usr/bin/lsof`；三处都没有时改按 agent 列表确认（本卡开过的 agent 已不存在或已归档，且没有在用 agent 的工作目录位于该目录内）后删除并写一条 info，有在用 agent 的工作目录在其中则保留并继续报红。
- 容量刹车在卡片临时目录用量超过 10 GiB，或磁盘剩余低于 50 GiB 时，只暂停全新卡的首次开工。审查、返工和续跑照常开工。doctor 报红，leader 只提醒一次，阈值可配置，完成的卡记录一次临时目录大小。由于完成卡的目录现在在下一轮就被删除、成功的测试也立即删掉卡根工作区，删除成功后用量立即回到两项阈值以内，下一轮自动解除。
- 测试宿主默认关闭语音模式和听写，并在卡外复用一份只读官方 runtime 与一份共享 npm 缓存。
- 更正发布清单：GitHub Release 正文只用英文，中文发布说明保留在 `docs/zh-CN/`。

### 说明（Notes）

- package 与根 lock 版本统一为 `0.1.0-rc.18`。Node 仍要求 `>=24.21.0`，Paseo daemon/app 仍要求 `>=0.11.0 <0.12.0`。相对 rc.17，依赖选择、schema 和契约版本不变，不新增存储文件，也不引入自动数据或凭证导入。保留 20 个开发／构建依赖告警。
- 只有看板运维工具和发布文档有变化：卡片目录清理、新卡容量刹车、测试宿主环境和 Release 正文语言规则。体检的仓库扫描、按 Paseo 项目列表过滤以及卡片的产品行为没有其他变化。共享 runtime 只是测试环境缓存；产品本身在语音开启时首次启动仍会下载语音模型。隔离测试环境（pre-push 门使用）现在额外链接 `lsof`，清理测试通过 PATH 调用它；清理本身已不再依赖 PATH，贡献者只有跑这些测试时才需要安装 `lsof`。
- 精确 rc.18 验证只计 rc.18 回执；此前 rc.17 成绩不认证本候选。GitHub 冷安装、本候选的真实浏览器挂载、已安装宿主生命周期（含真实看板上的清理与容量刹车）、含待恢复定时卡的升级／回退、原生 app、手机、已认证 provider 闭环、其他平台与生产恢复仍未验证。本次准备不执行生产切换。

## 0.1.0-rc.17 — 待审查与发布

本地候选 tag 为 `v0.1.0-rc.17`，只准备、不发布。匹配的 GitHub prerelease 与精确已审 commit／tag 独立核对通过后，才从 GitHub 安装。冻结的 rc.1 至 rc.16 tag 绝不挪动。

### 修复（Fixed）

- 体检不再把项目主目录拼到插件安装目录下（issue #9）。配置里有、但没有 `workspacePath`、Paseo 也不知道目录、也没有卡片目录的项目，视为「目录未知」，安静跳过：不再出现 `worktree <路径>` 信息行，也不再出现 `repo:skipped` 的 ENOENT 发现。相对路径的 `workspacePath` 属于无效配置，只在日志里提示一次，不会拿插件目录或进程 cwd 去解析（读取 `workspacePath` 的仓库查询也会忽略它）。有绝对目录的项目行为不变，已离开 Paseo 的项目仍被过滤。

### 说明（Notes）

- package 与根 lock 版本统一为 `0.1.0-rc.17`。Node 仍要求 `>=24.21.0`，Paseo daemon/app 仍要求 `>=0.11.0 <0.12.0`。相对 rc.16，依赖选择、schema 和契约版本不变，不新增存储文件，也不引入自动数据或凭证导入。保留 20 个开发／构建依赖告警。
- 只有体检的仓库扫描有变化。rc.16 的按 Paseo 项目列表过滤、每 30 秒读取以及约 60 至 90 秒的隐藏延迟不变，没有已知目录的项目在该列表里仍视为存在。一条测试被收紧：即使存在同名 Paseo 工作区，相对路径的 `workspacePath` 也只提示一次。
- 精确 rc.17 验证只计 rc.17 回执；此前 rc.16 成绩不认证本候选。GitHub 冷安装、本候选的真实浏览器挂载、已安装宿主生命周期、含待恢复定时卡的升级／回退、原生 app、手机、已认证 provider 闭环、其他平台与生产恢复仍未验证。本次准备不执行生产切换。

## 0.1.0-rc.16 — 待审查与发布

本地候选 tag 为 `v0.1.0-rc.16`，只准备、不发布。匹配的 GitHub prerelease 与精确已审 commit／tag 独立核对通过后，才从 GitHub 安装。冻结的 rc.1 至 rc.15 tag 绝不挪动。

### 变更（Changed）

- 看板的项目与 leader 名单改为以 Paseo 的项目列表为准。看板项目按目录与 Paseo 项目对照（忽略 `dir:` 前缀、末尾斜杠和符号链接；从不比较名字）。目录已不是 Paseo 项目的看板项目，不再出现在 leader 面板、暂停区、首页、按项目页和看板里；不发提醒、不唤醒、不派活；`create`、`register`、`start` 和为它启动 leader 会被拒绝并说明原因；体检不为它报红或黄，只留一条信息。卡片与历史保留：`show` 可看单张卡，`list --include-removed`（工具里是 `includeRemoved`）可列出。读不到 Paseo 时，沿用存在 `paseo-projects.json` 里上次读到的列表；空列表要连续两次成功读到且相隔至少 60 秒才算数；从未成功读到过时不过滤任何项目。`paused-projects.json` 现在只表示「在 Paseo 里、临时暂停」的项目。

### 说明（Notes）

- 对外文档与发布说明仅用英文，中文文档保留在 docs/zh-CN。全新安装跟随系统语言，已明确选择的语言不变（新增测试覆盖）。
- package 与根 lock 版本统一为 `0.1.0-rc.16`。Node 仍要求 `>=24.21.0`，Paseo daemon/app 仍要求 `>=0.11.0 <0.12.0`。相对 rc.15，依赖选择、schema 和契约版本不变。唯一新增的存储文件是 `paseo-projects.json`，用来缓存上次读到的 Paseo 项目列表；不引入自动数据或凭证导入。保留 20 个开发／构建依赖告警。
- 插件连上 Paseo 期间每 30 秒读取一次项目列表。最后一个项目从 Paseo 移除后，约需 60 至 90 秒才会隐藏，因为空列表必须相隔至少 60 秒看到两次。没有已知目录的项目一律视为仍在 Paseo。生产配置里每个项目是否都写了 `workspacePath` 未验证。
- 精确 rc.16 验证只计 rc.16 回执；此前 rc.15 与组件成绩不认证本候选。GitHub 冷安装、合并后候选的真实浏览器挂载、已安装宿主生命周期、含待恢复定时卡的升级／回退、原生 app、手机、已认证 provider 闭环、其他平台与生产恢复仍未验证。本次准备不执行生产切换。

## 0.1.0-rc.15 — 待审查与发布

本地候选 tag 为 `v0.1.0-rc.15`，只准备、不发布。匹配的 GitHub prerelease 与精确已审 commit／tag 独立核对通过后，才从 GitHub 安装。冻结的 rc.1 至 rc.14 tag 绝不挪动。

### 修复（Fixed）

- 共享的临时目录在其他卡的 agent 仍指向它时，可能被提前清理。目录级 agent 清理因这样的 agent 在而失败后，若对账扫描恰好落在重试时间之前，只看已完成卡自己的 agent 就把这一步记为完成，随后归档并删除目录。现在只有过了重试时间、agent 列表可读且没有任何卡的 agent 指向该目录时，扫描才判这次失败已完成；清理任务也不再把对账写入的行当作目录级清理已完成。其他卡的 agent 仍会让目录保留，行为不变。

### 注意（Notes）

- package 与根 lock 版本统一为 `0.1.0-rc.15`。Node 仍要求 `>=24.21.0`，Paseo daemon/app 仍要求 `>=0.11.0 <0.12.0`。相对 rc.14，依赖选择、schema 和契约版本不变，不引入自动数据或凭证导入。保留 20 个开发／构建依赖告警。
- 目录级 agent 清理失败后，对账扫描须等到重试时间才可结案；agent 列表不可读时，该失败留给正常重试处理。早期构建已写入的行不再让清理跳过该步，下一轮清理会实际检查目录一次。正常的 commit 祖先关系清理、PR／squash 证明、显式丢弃权限、按审计 tip 删除、共享副本、活跃 agent、撤权／保留保护不变。
- 精确 rc.15 验证只计 rc.15 回执；此前 rc.14 与单项修复成绩不认证本候选。GitHub 冷安装、真实浏览器及已安装宿主生命周期、含待恢复定时卡的升级／回退、原生 app、手机、已认证 provider 闭环、其他平台与生产恢复仍未验证。本次准备不执行生产切换。

## 0.1.0-rc.14 — 待审查与发布

本地候选 tag 为 `v0.1.0-rc.14`，只准备、不发布。匹配的 GitHub prerelease 与精确已审 commit／tag 独立核对通过后，才从 GitHub 安装。冻结的 rc.1 至 rc.13 tag 绝不挪动。

### 修复（Fixed）

- 临时卡清理时，卡分支 tip 只要是配置的本地基准分支或成功 fetch 后的 `origin/<base>` 的祖先，任一成立即视为已合并。本地合并无需 push 或 `--discard-unmerged`，即使 origin 落后或不可达也可清理；本地包含关系同样允许删除卡分支，仅本地树内容相同仍不足以证明。清理完成后 doctor 的残留 worktree／workspace 两条红自然消失。既有 PR／squash 证明和显式丢弃保护保留。修复 [issue #8](https://github.com/jasonhnd/paseo-kanban/issues/8)。

### 注意（Notes）

- package 与根 lock 版本统一为 `0.1.0-rc.14`。Node 仍要求 `>=24.21.0`，Paseo daemon/app 仍要求 `>=0.11.0 <0.12.0`。相对 rc.13，依赖选择、schema 和契约版本不变，不引入自动数据或凭证导入。保留 20 个开发／构建依赖告警。
- 正常清理要求卡 tip 是配置的本地基准或成功 fetch 后远端基准的祖先；仅树内容相同仍不足以证明。既有 PR／squash 证明及显式丢弃的权限、按审计 tip 删除、共享副本、活跃 agent、撤权／保留保护不变。
- 精确 rc.14 验证只计 rc.14 回执；此前 rc.13 与单项修复成绩不认证本候选。GitHub 冷安装、真实浏览器及已安装宿主生命周期、含待恢复定时卡的升级／回退、原生 app、手机、已认证 provider 闭环、其他平台与生产恢复仍未验证。本次准备不执行生产切换。

## 0.1.0-rc.13 — 待审查与发布

本地候选 tag 为 `v0.1.0-rc.13`，只准备、不发布。匹配的 GitHub prerelease 与精确已审 commit／tag 独立核对通过后，才从 GitHub 安装。冻结的 rc.1 至 rc.12 tag 绝不挪动。

### 修复（Fixed）

- Leader 提醒可通过规范化后的完整标题主体，或至少两条有辨识度的选项正文且推荐字母一致，确认本项目当前 open 决策的复述。选项去掉通用词后须至少含六个汉字或三个英文实词，内置停用表排除通用回答和发布模板。较早登记的待拍板只复述选项及推荐、不带标题或编号时也可识别；新主体复用通用发布选项仍会提醒。已关闭决策和不相关的新决策不再掩盖新问题。面向用户的提醒、面板标签、体检通知及 CLI／工具帮助改用看板现名，并说明自动提醒来自看板；旧标识符及旧提醒输入保持兼容。修复 [issue #6](https://github.com/jasonhnd/paseo-kanban/issues/6)。

- `resume-cleanup --discard-unmerged` 只列卡分支 tip 可达、且未被其他本地分支、远端跟踪分支或 tag 包含的提交，排除即将移除的卡分支／worktree 引用。优先使用本地已有的 `origin/<base>`，其次已配置上游，最后本地基准；本地基准落后时提示。本次审计不 fetch、不发网络请求。授权与丢弃完成事件记录修正后的清单；leader 权限、按审计 tip 比较后删除、撤权及保留分支的保护不变。修复 [issue #7](https://github.com/jasonhnd/paseo-kanban/issues/7)。

### 注意（Notes）

- package 与根 lock 版本统一为 `0.1.0-rc.13`。Node 仍要求 `>=24.21.0`，Paseo daemon/app 仍要求 `>=0.11.0 <0.12.0`。相对 rc.12，依赖选择、schema 和契约版本不变，不引入自动数据或凭证导入。保留 20 个开发／构建依赖告警。
- 选项分类使用有限中英停用表及完整规范化正文。未收录的通用模板和完整复用的业务正文仍有限制；换词复述可能继续提醒。丢弃审计只读取本地已有 refs，它们可能过时；不会 fetch。
- 精确 rc.13 验证只计 rc.13 回执；此前 rc.12 与单项修复成绩不认证本整合候选。GitHub 冷安装、真实浏览器及已安装宿主生命周期、含待恢复定时卡的升级／回退、原生 app、手机、已认证 provider 闭环、其他平台与生产恢复仍未验证。本次准备不执行生产切换。

## 0.1.0-rc.12 — 待审查与发布

本地候选 tag 为 `v0.1.0-rc.12`，只准备、不发布。匹配的 GitHub prerelease 与精确已审 commit／tag 独立核对通过后，才从 GitHub 安装。冻结的 rc.1 至 rc.11 tag 绝不挪动。

### 修复（Fixed）

- 新增持久 `block --kind scheduled --until` 定时等待，要求 ISO 时间带明确偏移且不超过七天。到点前不做 transient 重试、不因等待报 doctor 红；到点后下一次 tick 用持久去重消息 ID 恢复一次，复用原有 agent 恢复规则，允许负责人提前 unblock。同步中英看板／列表／详情、CLI／MCP 帮助及执行守则。修复 [issue #5](https://github.com/jasonhnd/paseo-kanban/issues/5)。

### 注意（Notes）

- package 与根 lock 版本统一为 `0.1.0-rc.12`。Node 仍为 `>=24.21.0`，Paseo daemon/app 仍要求 `>=0.11.0 <0.12.0`。依赖选择和契约版本不变。tasks 表新增五个可空字段，保存定时期限、持久唤醒 ID／正文和发送租约；已有数据库通过正常增量迁移补齐，不导入凭证或旧存储。20 个开发／构建依赖告警保留。
- 恢复发生在到点后的下一次 scheduler tick，不保证精确到秒。宿主发送结果未知时保留等待交 leader 核对，不换消息 ID 重发；doctor 只在期限加正常阈值后报警。允许负责人提前 unblock。
- 精确 rc.12 门禁只使用 rc.12 回执。此前 rc.11 安装及单项修复结果不代表本候选通过。rc.12 的 GitHub 冷安装、真实浏览器和已安装宿主生命周期、含待恢复定时卡的升级／回退、原生 app、手机、已认证 provider 闭环、其他平台与生产恢复仍未验证。本次准备不做生产切换。

## 0.1.0-rc.11 — 待审查与发布

本地候选 tag 为 `v0.1.0-rc.11`，只准备、不发布。匹配的 GitHub prerelease 与精确已审 commit／tag 独立核对通过后，才从 GitHub 安装。冻结的 rc.1 至 rc.10 tag 绝不挪动。

### 修复（Fixed）

- 迁到新数据根后，Cursor 额度卡即使回退为手抄来源，也会明确提示自动监控已关闭并提供开启入口。关闭监控时仍能找到「连接 Cursor」，并引导先开启读取器、再重新在浏览器授权。可选读取器仍默认关闭，不导入凭证，派活资格与监控独立。授权后提示等待下一次定时采样，不刷新上次额度读取的时间戳。参见 [GitHub issue #4](https://github.com/jasonhnd/paseo-kanban/issues/4)。

### 注意（Notes）

- package 与根 lock 版本统一为 `0.1.0-rc.11`。Node 仍为 `>=24.21.0`，Paseo daemon/app 仍要求 `>=0.11.0 <0.12.0`。依赖选择、schema 和契约版本不变，没有新增自动数据迁移或凭证导入。20 个开发／构建依赖告警保留。
- 精确 rc.11 门禁只使用 rc.11 回执。此前 rc.10 安装及单项修复结果不代表整合候选通过。rc.11 的 GitHub 冷安装、整合真实浏览器和已安装宿主生命周期、原生 app、手机、已认证 provider 闭环、其他平台与生产恢复仍未验证。本次准备不做生产切换。

## 0.1.0-rc.10 — 待审查与发布

本地候选 tag 为 `v0.1.0-rc.10`，只准备、不发布。匹配的 GitHub prerelease 与精确已审 commit／tag 独立核对通过后，才从 GitHub 安装。冻结的 rc.1 至 rc.9 tag 绝不挪动。

### 修复（Fixed）

- 全局 Kanban leader（`supervisorAgentId`）可恢复所有项目卡片的清理，其他项目权限范围不变。`resume-cleanup <卡号> --discard-unmerged` 只允许项目登记的 leader 或 Kanban leader 丢弃自有临时分支：先列出完整提交 SHA／标题，审计授权 leader 和丢弃提交，再走正常清理删除干净的 worktree、分支并归档 workspace。卡令牌、执行者、审查者不能使用；副本仍在时，tip、基准变化或未提交改动会暂停移除。副本删除后，基准前进不阻止删除已批准 tip；tip 改变或删分支重试耗尽时，保留分支、撤销授权并通知 leader，清理正常收束。不加参数时 `not_merged` 行为不变。修复 [GitHub issue #2](https://github.com/jasonhnd/paseo-kanban/issues/2)。

- 清理一张卡时，只删除这张卡记录过的 agent：runs、任务列、令牌，以及打开事件里的 agentId，再加上从这些 agent 派生出来的子 agent。只是共用目录或 workspace 的 agent 会留下来，包括另一张早已完成的卡的执行和审查 agent。标签写成这张卡、但记录属于另一张卡的 agent 不会被清掉。清理说明只写别的卡的 agent 还在用这个目录，不点出那些 agent。见 [GitHub issue #3](https://github.com/jasonhnd/paseo-kanban/issues/3)。

- 绑定的 Paseo 工作区被宿主归档，或在一次成功的工作区列表里找不到时，进行中或审查中的卡改为 needs_human，不再无限期停在 running 且没有活着的 agent。执行和杂活守则写明：不要在本卡临时 worktree 里把 PR 的 head 分支 checkout 成当前分支；用独立本地分支或 ref 推送，或直接 gh pr merge 且不 checkout head。Kanban <leader>（supervisorAgentId）或该项目已登记的 <leader> 可以用 complete --on-behalf 代交消失的 agent 的活。complete 事件记下 onBehalf。其余身份仍拒绝。doctor 仍然不改卡片。见 [GitHub issue #3](https://github.com/jasonhnd/paseo-kanban/issues/3)。

- 工作区查询期间若卡片状态、agent 或工作区绑定发生变化，迟到结果不再应用。代交信息会持久化，等待必需 checks 或重载后仍保留真实代交者。已由负责人提交的 blocked 恢复卡在 checks 通过后自动进入待验收，无需再次 complete；新的阻塞、失败的 checks 和必需审查仍会拦住。 解除阻塞或重新派工会使原先等待 checks 的代交提交失效，包括同一 agent 开始新一轮；迟到结果不能代替新 worker 交活。

### 注意（Notes）

- package 与根 lock 版本统一为 `0.1.0-rc.10`。Node 仍为 `>=24.21.0`，Paseo daemon/app 仍要求 `>=0.11.0 <0.12.0`。依赖选择、schema 和契约版本不变，没有新增自动数据迁移或导入。既有开发／构建依赖告警未修复。
- 精确 rc.10 门禁只使用 rc.10 回执。此前 rc.9 或单项修复结果不代表整合候选通过。GitHub 冷安装、整合真实浏览器和已安装宿主生命周期、原生 app、手机、已认证 provider 闭环、其他平台与生产恢复仍未验证。本次准备不做生产切换。

## 0.1.0-rc.9 — 待审查与发布

本地候选 tag 为 `v0.1.0-rc.9`，只准备、不发布。匹配的 GitHub prerelease 与精确已审 commit／tag 独立核对通过后，才从 GitHub 安装。冻结的 rc.1 至 rc.8 tag 绝不挪动。

### 修复（Fixed）

- 手工 `--reviews` 审查卡可以在目标仍是 `in_review` 时打回。目标回到返工，审查轮次加一，与从 `reviewing` 打回相同。第二轮仍停下来等负责人裁定，第三轮仍停下来等人处理。创建审查卡不会认领目标。批准这场审查不会移动仍是 `in_review` 的目标，而是停下来并给出错误，让项目负责人 先裁定通过，再验收。之后轮询审查卡自己的检查，也不会把该目标送进待验收。见 [GitHub issue #1](https://github.com/jasonhnd/paseo-kanban/issues/1)。

### 注意（Notes）

- package 与根 lock 版本统一为 `0.1.0-rc.9`。Node 仍为 `>=24.21.0`，Paseo daemon/app 仍要求 `>=0.11.0 <0.12.0`。依赖选择、schema 和契约版本不变，没有新增自动数据迁移或导入。20 个开发／构建依赖告警仍保留。
- 精确 rc.9 门禁必须使用 rc.9 回执。此前 rc.8 成绩不代表本候选通过。rc.9 的 GitHub 冷安装、整合真实浏览器和已安装宿主生命周期、原生 app、手机、已认证 provider 闭环、其他平台与生产恢复仍未验证。本次准备不做生产切换。

## 0.1.0-rc.8 — 待审查与发布

本地候选 tag 为 `v0.1.0-rc.8`，只准备、不发布。匹配的 GitHub prerelease 与精确已审 commit／tag 独立核对通过后，才从 GitHub 安装。冻结的 rc.1 至 rc.7 tag 绝不挪动。

### 修复（Fixed）

- 已停用或未知的 provider 不再发出 thinking-catalog 警告。只有错误文本说明该 provider 已停用或未知时才跳过警告。其他失败，包括连接重置，仍然警告。检查不写死 provider 名单，也不读取已禁止的 provider。
- 宿主 server bundle 不再读取 `fs.F_OK`（Node DEP0176）。server bundle 包含的文件系统辅助改为具名 import 和具名再导出，不再对 `node:fs` 做星号 import 或星号 export。测试数据路径守卫使用这些具名函数，其文件系统参数只列出实际调用的方法。这不是把 `fs.F_OK` 改写成 `fs.constants.F_OK`：星号 import 在宿主打包 server 时仍会碰到这些常量。

### 已核对、未改监听策略

- 复用保存的 MCP 端口已是 rc.7 的行为。服务优先使用 `data/mcp.port`，端口空闲就绑定它；只有保存端口被占用时才改绑其他端口，并把正在使用的 MCP 地址标成失效。官方 Paseo 0.11.2 上的新增集成测试表明，先停后起的 reload 会复用保存端口，同一个宿主 MCP 客户端还能再读看板。保存端口被占时，服务仍会换端口。本候选不改这条监听策略。

### 注意（Notes）

- package 与根 lock 版本统一为 `0.1.0-rc.8`。Node 仍为 `>=24.21.0`，Paseo daemon/app 仍要求 `>=0.11.0 <0.12.0`。schema 和契约版本不变，没有新增自动数据迁移或导入。依赖选择不变，20 个开发／构建告警仍保留。
- 精确 rc.8 本机门禁必须使用 rc.8 回执。此前 rc.7 成绩不代表本候选通过。新 GitHub 冷安装、真实浏览器升级／reload 恢复与已安装宿主生命周期须另行验证。原生 app、手机、已认证 provider、其他平台及生产恢复仍未验证。本候选不做生产切换。

## 0.1.0-rc.7 — 待审查与发布

本地候选 tag 为 `v0.1.0-rc.7`，只准备、不发布。匹配的 GitHub prerelease 与精确已审 commit／tag 独立核对通过后，才从 GitHub 安装。冻结的 rc.1 至 rc.6 tag 绝不挪动。

### 变更（Changed）

- 每张卡的临时目录从系统临时目录改到所配置项目的 `.kanban-work/<卡号>/`，并由 Git 本地 exclude。项目缺失、不是 Git 仓库或不可写时，回退到 `<plugin-data-root>/work/<项目>/<卡号>/`。`<plugin-data-root>` 是 `KANBAN_DATA_DIR`，否则是 `$PASEO_HOME/plugin-data/paseo-kanban`；未设置 `PASEO_HOME` 时为 `~/.paseo/plugin-data/paseo-kanban`。不再回退到系统临时目录。已记录路径在设置变化后仍保留 resume generation 与延迟清理。
- supervisor 的 brief 文件边界，以及通读／决策卡范围，跟随新的工作根。中英文 worker 守则和文档把临时产物放到注入的卡片目录。

### 修复（Fixed）

- 项目设置和短码更新保留已配置的工作目录，包括旧字段 `workspace`。中文 worker 守则保留被审卡和名称限制，并写明看板是本地 exclude 的写入者。
- 完整测试阶段和 worker 隔离临时根。测试不再往真实默认根写卡目录。卡临时目录守卫仍拒绝自有夹具之外的真实系统卡根，并允许夹具嵌在当前卡的 `.kanban-work/<卡号>/` 内时的内部路径。默认根名称审计会拒绝在自有根之外留下新卡目录的阶段。

### 现有安装切换

- 要采用新默认值，须移除或改掉旧的显式 `KANBAN_TMP_ROOT`。显式 `KANBAN_TMP_ROOT` 仍然优先，包括有意保留的旧位置。新 worker 守则使用 `KANBAN_TMP`。
- 已有 worker 若必须换掉旧环境，需要结束并重新打开。已保存的简报和守则，以及正在运行的 agent 环境，不会被改写。第一张新卡核对 `TMPDIR`、`KANBAN_TMP` 和 `card_tmp_prepared`。
- 没有 prepared-path 记录的旧系统临时根不会进入默认发现。本候选不删除这些目录。

### 注意（Notes）

- package 与根 lock 版本统一为 `0.1.0-rc.7`。Node 仍为 `>=24.21.0`，Paseo daemon/app 仍要求 `>=0.11.0 <0.12.0`。schema 和契约版本不变，没有新增自动数据迁移或导入。依赖选择不变，20 个开发／构建告警仍保留。
- 精确 rc.7 本机门禁与出站 annotated tag 必须使用 rc.7 回执。此前 rc.6 或分组件成绩不代表整合候选通过。新 GitHub 冷安装、真实浏览器升级／reload 恢复与已安装宿主生命周期须另行验证。原生 app、手机、已认证 provider、其他平台及生产恢复仍未验证。本候选不做生产切换。

## 0.1.0-rc.6 — 待审查与发布

本地候选 tag 为 `v0.1.0-rc.6`，只准备、不发布。匹配的 GitHub prerelease 与精确已审 commit／tag 独立核对通过后，才从 GitHub 安装。冻结的 rc.1 至 rc.5 tag 绝不挪动。

### 修复（Fixed）

- 更正官方 0.11.2 Web UI 的中英文看板书签说明及一处客户端注释：复制侧栏打开后带宿主的 `/h/<host-id>/plugin/paseo-kanban/surface/board` URL。旧的不带宿主 `/plugin/paseo-kanban/board` 仍无效，没有新增路由别名。
- 升级／reload 期间，已确认幂等的读取遇到暂时性 “Plugin not available” 会在 15 秒重试窗口内最多退避重试 5 次。已挂载面板保留上次数据并显示“插件正在更新…”，耗尽后提示稍后刷新。保存、操作及未知 RPC 绝不自动重试；其他错误仍正常显示。

### 文档更正及已知限制

- 官方 Paseo 0.11.2 Web UI 的 Command Center **打开项目看板**动作需要当前页面的插件安装宿主上下文。空首页不显示；离开插件页回首页后也一样，请先从侧栏 **Paseo Kanban** 打开。`context: global` 不能绕过宿主选择。本次更正此前“全局可用”的描述，没有修复首页行为。
- 官方 0.11.2 **Settings -> Plugins** 不显示 manifest 图标。包内 PNG 仍用于未来可能的 registry 展示，不代表目前已获收录。
- 保留依赖审计的 **20 个受影响包：5 moderate、15 high**，全部属于开发／构建依赖链，构建 preparation 会使用它们。Git 安装的 `npm ci --include=dev` 也会把它们装到 daemon 用户机器上。该审计中两个根因通告（`braces`、`sprintf-js`）均无已发布的上游修复版本；不加 force 的 `npm audit fix` 没有改动。依赖选择保持原样；未测试运行时可利用性，本机门禁通过不表示依赖已修复。

### 注意（Notes）

- package／根 lock 版本统一为 `0.1.0-rc.6`；Node 仍为 `>=24.21.0`，Paseo daemon/app 仍要求 `>=0.11.0 <0.12.0`。schema 和契约版本不变，没有新增自动数据迁移／导入。
- 精确 rc.6 本机门禁与出站 annotated tag 必须使用 rc.6 回执，此前 rc.5 或分组件成绩不代表整合候选通过。新 GitHub 冷安装、真实浏览器升级／reload 恢复与已安装宿主生命周期须另行验证；原生 app、手机、已认证 provider、其他平台及生产恢复仍未验证。

## 0.1.0-rc.5 — 待审查与发布

本地候选 tag 为 `v0.1.0-rc.5`，本卡只准备、不发布。只有匹配的 GitHub prerelease 指向[发布记录](RELEASE.md)中的独立审查完整 commit 后，才从 GitHub 安装。冻结的 rc.1 至 rc.4 tag 绝不挪动。

### 修复（Fixed）

- 成功的新执行／审查 run、resume 和 lost-create adoption 清理 quota／rate_limit 失败留下的过时当前 blocked/cooldown 字段。历史 events/runs 保留；创建或发送失败仍保留原原因。
- 默认过期策略诊断正确说明仍遵守停池与矩阵暂停；已有 `preserveStops`／`matrixPaused` 语义及显式旧格式兼容路径不变。

### 变更（Changed）

- 看板侧栏改用受支持的 header contribution 与宿主 `SidebarRow`，保留原 board screen 和侧栏偏好身份。以 `context: global` 注册的 Command Center 动作，在具有本安装宿主上下文的页面打开同一 screen；使用专用中英文文案键，随所选语言更新。官方 0.11.2 Web 的空首页没有该上下文，不显示动作；离开插件页回首页后也一样。先用侧栏打开看板。
- 中英文 README 上手入口精简，OVERVIEW 区分已测 Web UI 和未验证的 native／provider 流程。加入匿名已安装 Board／quota 截图、原创看板图标及 manifest media；截图原有范围见[媒体说明](../MEDIA.md)。
- **Node 下限从 22.13.0 提到 24.21.0**：另行对冻结 rc.4 的 Node 22.13.0 实测只通过 **12/13 门**，CLI JSON 错误输出被 SQLite 实验警告污染；同一源码在 Node 24.21.0 为 13/13 门。未认证中间 Node 版本。package／根 lock engines 与当前中英文要求统一为 `>=24.21.0`。

### 已知宿主限制

- rc.5 把 Command Center 动作描述为全局可用，范围过宽。官方 0.11.2 Web 需要本安装的宿主上下文，空首页不显示插件动作。调整注册不能绕过宿主筛选；本次文档更正没有修复宿主行为。
- 官方 0.11.2 Settings -> Plugins 列表不读取 manifest `icon`／`media`。包内 PNG 保留作未来可能的 registry 展示元数据，与 contribution 图标不同；不声明 registry 已收录。

### 注意（Notes）

- package／lock 元数据为 `0.1.0-rc.5`。Paseo daemon/app 范围仍为 `>=0.11.0 <0.12.0`；官方 0.11.0 配 Node 24.21.0 已另在 rc.4 上实测。依赖、schema 和契约版本不变。
- 精确 rc.5 门禁及出站 annotated tag 须有新回执；此前分组件或 rc.4 结果不代表整合候选通过。GitHub tag／完整 SHA 安装、生命周期重放、原生 app、真实手机、已认证 provider、Linux/WSL2 与生产恢复仍是独立未验证工作。既有依赖告警未解决。

## 0.1.0-rc.4 — 待审查与发布

本地候选 tag 为 `v0.1.0-rc.4`。只有匹配的 GitHub prerelease 指向[发布记录](RELEASE.md)中的已审完整 commit 后，才从 GitHub 安装；本次准备不代表发布。冻结的 rc.1、rc.2、rc.3 tag 绝不挪动。

### 修复（Fixed）

- 默认不可变策略消费在快照过期后不再重开生产者的 `dispatchable=false`，包括不启用数字额度保护及旧格式低用量条目。默认路由在过期后继续遵守矩阵暂停。原本开放的 `quotaProtection=none` 池没有矩阵暂停时仍可派活；显式旧格式兼容行为不变。
- 匿名回归通过真实额度生产者、契约投影、不可变发布及默认读取／路由／启动路径，使用假启动器验证。覆盖 freshness／TTL 边界、保护过期、缺失／非法策略、digest 变化、本地停池、旧格式 99% 过期读数及生产者安全停止。

### 注意（Notes）

- package／lock 元数据为 `0.1.0-rc.4`；此前产物验收、决定面板和托管命令路径修复保留。依赖、schema 和契约版本不变。
- 保留冻结 rc.3 的默认过期策略原始失败。rc.3 `61cce0d8ba07e8bf01fe7239ddf0ceeaf5983df4`（tree `633c99456b05cdbf7156f5c3ab1149451a767738`，annotated object `7e288e22f42598a651edef407dcdb82871c3d9de`）不得发布。此前分组件或 rc.3 门禁结果不是新精确候选通过。
- 最终本机门禁、已安装默认策略及 UI 证据记入新候选记录。GitHub tag／完整 SHA 安装、三宿主升级、自然 600 秒刷新和回退重放仍是发布后的独立工作。旧热更新失败、仅挂载期间 Undo、大写宿主拒绝、未修依赖告警及所有手机／原生／provider／平台／生产未验证限制继续保留在下文。

## 0.1.0-rc.3 — 冻结的本地候选，不得发布

不可移动候选 tag 为 `v0.1.0-rc.3`。只有其 GitHub Release 存在、标为 prerelease、目标为[发布记录](RELEASE.md)中的已审完整 commit 时，才从 GitHub 安装；否则仍未发布。冻结的 rc.1 和 rc.2 tag 绝不挪动。rc.2 保留在 `8be11b6144b6cc7b81bcf741a360acf18111001f`，annotated object 为 `0e16a0c43de421db583a31b3dee7b6e6b67e6b82`。

### 修复（Fixed）

- 决定回复、角色修改、决定维护在实际调用时解析 roles 命令。托管 Git 更新先启动候选代码、再修改宿主路径；模块级缓存因此可能在导出刷新后仍指向已删除旧 checkout。新增回归保持生产依赖已加载，切换配置并删除旧 checkout 后，验证三个命令入口。
- 包含 rc.2 所列两组已审的产物验收和决定面板修复。package 与 lock 元数据为 `0.1.0-rc.3`；schema、契约和依赖选择不变。

### 注意（Notes）

- 保留先前热更新决定写入的原始失败。只核导出一致不够：升级和代码回退须核当前 CLI，并实测决定关闭／Undo／计数／存储状态。回退到旧 c106/rc.1/rc.2 代码还必须先用官方命令重载单插件，见[恢复](RELEASE.md#更新与恢复)。
- 约 600 秒导出周期、仅挂载期间的 Undo、大写 `https://GITHUB.COM/` 拒绝不变。依赖告警未解决。手机、原生 app、已认证 provider 闭环、Linux/WSL2 和生产恢复仍未验证。
- rc.2 或分组件精确结果不代表最终 rc.3 通过；最终候选本机门禁与真实已安装产品检查记入本候选证据。GitHub tag／完整 SHA 冷安装等公开后验证，本地 Git 不替代。

## 0.1.0-rc.2 — 冻结的本地候选，未发布

拟用不可移动 tag：`v0.1.0-rc.2`。这是实验性预发布，不是稳定版。本地 tag `v0.1.0-rc.1` 已经指向 `22958ff54c955c1a90683f786d3ebb8b9ae88470`，不挪动。准备本候选时，远端 tag 列表和 GitHub Releases 都没有 `v0.1.0-rc.1` 或 `v0.1.0-rc.2`；安装前由发布主责再查 GitHub Release 记录。公开代码基线仍是 [c106efb88a659931d01f40a236001823473561a8](https://github.com/jasonhnd/paseo-kanban/commit/c106efb88a659931d01f40a236001823473561a8)。只有当该 tag 的 GitHub Release 存在、标为 prerelease，且目标 commit 等于发布记录中的已审 commit 时，才用 `--ref v0.1.0-rc.2` 安装。该 Release 记录不存在时，本候选未发布，这个 tag 不是 GitHub 安装目标。这个标题不表示 Release 已存在。UTC 发布日期只写在发布记录里。

### 变更（Changed）

- package 与 lock 元数据统一为 `0.1.0-rc.2`。中英文上手、Git 安装和恢复只在上述 GitHub Release 条件下使用该 tag。`v0.1.0-rc.1` 仍是下一节的未公开本地准备。

### 修复（Fixed）

- 产物验收记下游离 HEAD 和卡的 pull request，不把本地分支合回。pull request 产物必须使用小写 `https://github.com/`。大写主机名如 `https://GITHUB.COM/` 会被拒绝。所有人和仓库的比较仍不区分大小写。
- 决定面板共用同一份关闭缓存。更新的遗漏会丢掉已恢复的行，更新的关闭遗漏会推进关闭水位，因此撤销后从另一区域关闭时，各区域计数保持一致。
- Undo 仍只在当前已挂载的面板里存在。离开该面板或重新加载后，Undo 消失。已保存的 done 状态和零计数保留。这个限制没有改。

### 注意（Notes）

- 本候选包含两组成品修复，相对 c106 不是只改元数据。schema、契约版本和依赖选择不变。不升级依赖，不运行 `npm audit fix`。既有依赖 deprecated／audit 告警仍在。构建或隐私门通过不消除这些告警。
- 看板和 Fleet 信息导出可能把已删除 checkout 的命令路径保留约 600 秒，这是现有导出周期。命令用当前安装路径；仅导出一致未避免已保留的 rc.2 热更新写入失败。当前恢复说明另要求真实写入复验，回退本旧代码时须 reload；导出延迟不变。
- 物理手机、原生 app，以及已认证 provider 的首卡、审查、验收和清理仍未验证。浏览器窄视口不是手机测试。Linux、WSL2 和生产恢复仍未验证。
- 不声称本 RC 已做 GitHub tag 或完整 SHA 冷安装。GitHub Release 记录存在之后才重做该项。本地 `file://` 检查不能算通过该行。
- 最终通过指本整合 commit 的门禁记录。`0.1.0-rc.1` 或任一修复单独的精确结果都不是这次最终通过。

## 0.1.0-rc.1 — 待发布

拟用不可移动 tag：`v0.1.0-rc.1`。这是实验性预发布，不是稳定版。公开准备基线为 [c106efb88a659931d01f40a236001823473561a8](https://github.com/jasonhnd/paseo-kanban/commit/c106efb88a659931d01f40a236001823473561a8)。发布后才在发布记录填入最终审过的 RC commit 和日期；这个标题不表示 tag 已存在。

### 新增（Added）

- 默认审查派活增加独立 Codex 槽 `reviewer.gpt-6-sol`（模型 `gpt-6-sol`，L1 到 L4 均为 xhigh）。只按这个精确模型匹配，不占用 GPT-6.1 槽。
- Experimental 插件源码、独立 Node 命令及英文/简体中文界面。
- 上手、工作流、数据、兼容、人工发布文档。
- Bug/功能/兼容报告模板与私下安全披露指引。

### 变更（Changed）

- package 与 lock 元数据统一为 `0.1.0-rc.1`；中英文上手明确拟用 tag、每次 update／check 的 ref 和公开精确 SHA 回退。确认远端发布前，tag 安装仍为待执行步骤。
- 用户 Git 安装与开发 directory 流程分开；补充无沙箱／适配器继承、统一数据根备份及代码／数据回退区别。
- 提供命令重放清单、使用侧 directory 转 Git 预案和目录申请草稿；均不表示生产切换、真实产品验收或外部提交已完成。
- 公开 [fcf 至 c106 的变更](https://github.com/jasonhnd/paseo-kanban/compare/fcf1b97c9db2c610b376ea792c50428fbc8f07f8...c106efb88a659931d01f40a236001823473561a8) 补齐锁定 Git 准备、daemon/SDK 目标选择、统一根备份及来源／代码／数据分别恢复。其官方 0.11.2 隔离 Git 生命周期及 Web app 验证与新 RC 验证分开记录。

### 修复（Fixed）

- 侧栏只注册一个标准项（id、title、icon、surface），与画面共用 `board`。桌面和紧凑侧栏打开同一面板：九个标签、设置、共用的语言控件，以及登记在 `board` 上的工作区面板。真实手机仍未验证。
- fcf 至 c106 将记忆语言和面板标题改为只在浏览器使用 storage helper：原生客户端不读取 `localStorage` getter；浏览器存储受限也不妨碍内存中的语言切换。原生／设备行为有源码回归测试，不等于物理设备验证。

### 安全（Security）

- 本机隐私、身份、历史泄漏、包内容闸必做。
- 所有者须发版前启用私下漏洞报告。

### 注意（Notes）

- 相对 c106，本 RC 只改 package／lock 元数据及文档；运行代码、manifest、依赖选择、schema 和契约版本不变。官方 0.11.2 以 Git revision／selector 标识源码，不使用 manifest 的 `version` 字段。
- Paseo daemon/app >=0.11.0 <0.12.0；官方命令／编译器基线 0.11.2。help/docs 核语法不等于已安装产品验证，完整平台/桌面/手机/provider 首卡仍需独立证据。
- 派活使用不可变 paseo-policy/v1；fleet-quota/v1、contractVersion 1.2.0 为同根兼容接口。本文档修改不变契约或迁移数据。
- 统一数据根为 KANBAN_DATA_DIR 或 PASEO_HOME/plugin-data/paseo-kanban；旧 Fleet 不自动导入。
- 已公开 c106 在 macOS arm64 通过官方 0.11.2 的隔离 GitHub 分支／完整 SHA 安装、明确预览／更新／降级／再升级、卸载重装、directory 来源转换、已安装 Node 命令／RPC，以及 Edge 中桌面／紧凑 Web UI 验证。前版结果不证明未发布 RC tag 已通过；按[发布清单](RELEASE.md)重跑精确 RC 门和发布后的 GitHub 重放。
- 物理 iOS/Android、原生 Electron、已认证不同实际 model 的 provider 首卡／审查／验收／清理、Linux/WSL2 和生产派活／数据恢复仍未验证。浏览器窄视口不是手机测试。
- 既有依赖 deprecated／audit 告警未解决；本次不升级依赖、不运行 `npm audit fix`。准备过程安装开发／构建依赖；发布记录保留插件及官方宿主的精确审计观察，构建／隐私门通过不消除这些告警。
- 代码回退不撤销数据写入；另行恢复兼容备份可能丢失新写入。新装 enabled=true，全局插件开启时可能立即启动。没有自动导入旧资料或生产迁移。
