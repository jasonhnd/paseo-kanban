# 变更记录

单插件使用一个版本与 CHANGELOG。本批以 Git 分发；此文不宣布版本化发布、npm 发布或官方目录收录。

## 未发布

### 新增（Added）

- 默认审查派活增加独立 Codex 槽 `reviewer.gpt-6-sol`（模型 `gpt-6-sol`，L1 到 L4 均为 xhigh）。只按这个精确模型匹配，不占用 GPT-6.1 槽。
- Experimental 插件源码、独立 Node 命令及英文/简体中文界面。
- 上手、工作流、数据、兼容、人工发布文档。
- Bug/功能/兼容报告模板与私下安全披露指引。

### 变更（Changed）

- 中英文上手改用真实公开 `integration/single-plugin-reviewed` ref，明确每次 update／check 的 ref、启用、卸载和当前 revision 确认。
- 用户 Git 安装与开发 directory 流程分开；补充无沙箱／适配器继承、统一数据根备份及代码／数据回退区别。
- 提供命令重放清单、使用侧 directory 转 Git 预案和目录申请草稿；均不表示生产切换、真实产品验收或外部提交已完成。

### 修复（Fixed）

- 侧栏只注册一个标准项（id、title、icon、surface），与画面共用 `board`。桌面和紧凑侧栏打开同一面板：九个标签、设置、共用的语言控件，以及登记在 `board` 上的工作区面板。真实手机仍未验证。

### 安全（Security）

- 本机隐私、身份、历史泄漏、包内容闸必做。
- 所有者须发版前启用私下漏洞报告。

### 注意（Notes）

- 包元数据为 0.1.0，experimental；公开 Git 源码不等于版本化发布或已存在 tag。
- Paseo daemon/app >=0.11.0 <0.12.0；官方命令／编译器基线 0.11.2。help/docs 核语法不等于已安装产品验证，完整平台/桌面/手机/provider 首卡仍需独立证据。
- 派活使用不可变 paseo-policy/v1；fleet-quota/v1、contractVersion 1.2.0 为同根兼容接口。本文档修改不变契约或迁移数据。
- 统一数据根为 KANBAN_DATA_DIR 或 PASEO_HOME/plugin-data/paseo-kanban；旧 Fleet 不自动导入。
- 发版前须 Git 安装、包、桌面、首卡、回退证据，见 RELEASE；代码回退不撤销数据写入。
