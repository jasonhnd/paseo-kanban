# Paseo Kanban

用于 [Paseo](https://github.com/getpaseo/paseo) 的单插件：看板、Fleet 阵容、额度、决定和设置。[English](../../README.md)

包为 `@jasonhnd/paseo-kanban`，唯一插件 id 为 `paseo-kanban`，显示名为 Paseo Kanban。一个侧栏入口，是标准项（id、title、icon、surface），与画面共用 `board`，保留深链与 workspace 项目限制。真实手机仍须单独验收。

> 未发布的实验版本。真实 app/phone、Linux 真宿主和真实 provider 首卡仍须独立验收。本机编译和匿名挂载不能代替这些验证。

## 要求与设置

- daemon 与 app 均为 `>=0.11.0 <0.12.0`，启用全局和本插件开关。
- Node >=22.13.0，`node:sqlite` 可用；Git、npm 在测试或 daemon PATH 中。
- 用户自行登录 provider 并配置角色档案。执行与审查必须使用两个明确、非空的实际 model，trim/lower 后比较。同 family 不同 model 允许；同 model 跨 provider、mode 或 effort 拒绝，缺证据就等。
- Fleet 设置提供角色预览，不自动写真实档案。保留已有档案，配置角色、pool 与实际 model。额度来源未知且受保护时，拒绝派活。

只有独立批准发布后才安装 npm 版本：

`paseo plugin install npm:@jasonhnd/paseo-kanban`

源码安装先执行 `npm ci` 和 `npm run build`。不要同时注册旧 Fleet 插件；新装使用统一 fresh root，旧资料只按[手动转移说明](../MANUAL-MIGRATION.md)处理，没有自动迁移。

首卡演示使用匿名、可丢弃的 Git workspace。配置项目、短号和保护分支；在项目 leader 面板预览并启动 leader，再登记 `kanban_supervise`。执行者按自包含简报提交，异实际模型审查，最后由 leader 验收。不要把普通角色对话或审查通过当成最终验收；演示无需 push 或发布。

## 本机检查与资料

`npm run verify` 的十三项本机闸包含 typecheck、脚本/插件回归、CLI 与严格真实编译器、源码/可达历史/身份/secrets、内部契约及兼容负例、单 package/lock/插件身份和实际包字节检查。不依赖或重新启用 GitHub Actions。历史失败仍拒绝，匿名导出历史通过不代表原历史通过。

`npm run contract:check` 与 `npm run shared:check` 检查同一源码及实质负例，无需另一仓。`afc`/`roles` 是同根下的兼容入口，不依赖跨进程内存。默认测试不需要 Python。

[工作流](WORKFLOW.md) · [数据与隐私](DATA.md) · [策略和兼容契约](../CONTRACT.md) · [兼容性](COMPATIBILITY.md) · [发布](RELEASE.md) · [参与开发](CONTRIBUTING.md) · [安全](SECURITY.md)
