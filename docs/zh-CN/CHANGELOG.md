# 变更记录

单插件使用一个版本与 CHANGELOG，通过 Git 分发。`0.1.0-rc.2` 是整合候选。`0.1.0-rc.1` 只在本地准备过，没有公开。本文不宣布任一 GitHub Release，也没有 npm 发布或官方目录收录。

## 0.1.0-rc.2 — 待发布

拟用不可移动 tag：`v0.1.0-rc.2`。这是实验性预发布，不是稳定版。本地 tag `v0.1.0-rc.1` 已经指向 `22958ff54c955c1a90683f786d3ebb8b9ae88470`，不挪动。准备本候选时，远端 tag 列表和 GitHub Releases 都没有 `v0.1.0-rc.1` 或 `v0.1.0-rc.2`；安装前由发布主责再查 GitHub Release 记录。公开代码基线仍是 [c106efb88a659931d01f40a236001823473561a8](https://github.com/jasonhnd/paseo-kanban/commit/c106efb88a659931d01f40a236001823473561a8)。只有当该 tag 的 GitHub Release 存在、标为 prerelease，且目标 commit 等于发布记录中的已审 commit 时，才用 `--ref v0.1.0-rc.2` 安装。该 Release 记录不存在时，本候选未发布，这个 tag 不是 GitHub 安装目标。这个标题不表示 Release 已存在。UTC 发布日期只写在发布记录里。

### 变更（Changed）

- package 与 lock 元数据统一为 `0.1.0-rc.2`。中英文上手、Git 安装和恢复只在上述 GitHub Release 条件下使用该 tag。`v0.1.0-rc.1` 仍是下一节的未公开本地准备。

### 修复（Fixed）

- 产物验收记下游离 HEAD 和卡的 pull request，不把本地分支合回。pull request 产物必须使用小写 `https://github.com/`。大写主机名如 `https://GITHUB.COM/` 会被拒绝。所有人和仓库的比较仍不区分大小写。
- 决定面板共用同一份关闭缓存。更新的遗漏会丢掉已恢复的行，更新的关闭遗漏会推进关闭水位，因此撤销后从另一区域关闭时，各区域计数保持一致。
- Undo 仍只在当前已挂载的面板里存在。离开该面板或重新加载后，Undo 消失。已保存的 done 状态和零计数保留。这个限制没有改。

### 注意（Notes）

- 本候选包含两组成品修复，相对 c106 不是只改元数据。schema、契约版本和依赖选择不变。不升级依赖，不运行 `npm audit fix`。既有依赖 deprecated／audit 告警仍在。构建或隐私门通过不消除这些告警。
- 看板和 Fleet 信息导出可能把已删除 checkout 的命令路径保留约 600 秒，这是现有导出周期。命令用当前安装路径，两份导出都与该路径一致后再恢复派活。本候选不认证、也不修复导出路径的即时新鲜度。
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
