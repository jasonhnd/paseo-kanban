# 变更记录

单插件使用一个版本与 CHANGELOG，通过 Git 分发。下列 RC 已在本地准备，tag 和 GitHub prerelease **待发布**；没有 npm 发布或官方目录收录。

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
