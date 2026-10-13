# 兼容性与排错

manifest 声明 Paseo **daemon 和 app** `>=0.11.0 <0.12.0`。daemon 兼容不证明 app 兼容。固定官方命令／编译器基线为 **0.11.2**，commit `75953250959979b8f088bbca8dbd6ee61d0151b1`；声明范围不证明所有 0.11 patch 或客户端都已测。放宽前须重跑编译和真实集成。

## 要求与证据

| 项目 | 要求或证据边界 |
|---|---|
| Paseo | daemon/app 均匹配范围，全局及单插件开关启用；CLI `--version` 只报告 CLI。 |
| Node | daemon 实际 Node >=24.21.0 且 `node:sqlite` 可用。 |
| npm／Git | 位于 daemon PATH，用于 Git 下载／准备；代码卡及 workspace 也需要 Git。客户端可用不证明远端宿主就绪。 |
| Provider | 用户自行安装、认证；发现不证明登录、额度或请求成功。 |
| 审查 | 两个明确非空实际 model，trim/lower 后比较。同 family 不同 model 可审；同 model 跨 provider/mode/effort 仍拒绝。 |

| 平台／检查 | 当前证据边界 |
|---|---|
| Paseo 下限 | 另行实测 rc.4 在官方 daemon/Web app 0.11.0、Node 24.21.0 下安装 running、RPC／Board 挂载及 13/13 本机门通过；不代表整合 rc.5 生命周期已认证。 |
| macOS | 隔离 arm64、Node 24.21.0/npm 12.1.0：本地 Git 准备、CLI／编译、生命周期／失败恢复及 Edge 中官方 0.11.2 Web app 已测。不认证所有 macOS／工具版本或已认证首卡。 |
| Linux | 首发目标，本文未认证完整原生流程；keychain/screen 不可用。 |
| WSL2 | 须单独记录 Linux 环境验证。 |
| 原生 Windows | 首发不支持；Node 命令不证明 Git/worktree/shell 整体流程。 |
| 桌面／窄视口 | 本机 Edge 中真实官方 0.11.2 Web app/daemon 的侧栏、Board/Fleet、语言／主题、RPC 和无 agent workspace 筛选已测；compact 须关闭侧栏后核正文／操作。原生 Electron 仍未验证。 |
| 真实手机 | 须真实设备/app 接入受测宿主；窄视口不足。 |
| 真实 provider 首卡 | 用户掌握测试登录、执行与审查实际 model 不同，完成／审查／验收／清理均核对；mock 不算通过。 |
| 官方 CLI 命令 | 0.11.2 隔离本地 Git 安装、明确 ref 预览／更新／降级、失败保留、换来源和匿名数据恢复已测；最终公开 GitHub 重放仍需完成。 |

隔离观察不认证生产切换或其他平台。[发布记录](RELEASE.md)须写精确 commit/source/revision、OS、Node/npm、daemon/app/CLI、provider/model 和逐项画面。可选 macOS 探针不是核心看板前置。

## Command Center 与 manifest 图标

官方 Paseo **0.11.2 Web** 中，⌘K／Ctrl+K -> **打开项目看板** 需要当前页面具有本安装的宿主上下文。已打开的插件页或活动工作区提供该上下文；空首页没有。离开插件页回到空首页后，动作消失。先点侧栏 **Paseo Kanban**。命令标题随插件所选语言更新。Settings 中选择宿主，并不保证其他页面具有命令上下文。

客户端目录按已连接宿主加载，不依赖插件页是否挂载。宿主的[命令注册](https://github.com/getpaseo/paseo/blob/v0.11.2/packages/app/src/plugins/command-center/registration.tsx#L18) 从活动工作区或 `/h/<host>/...` 路由取宿主，再按该宿主筛选插件动作。`context: global` 免去工作区／agent 前置条件，不免去宿主条件。见[官方 API 说明](https://paseo.sh/docs/plugins/reference#command-center-items)。调整插件注册时机无法补出首页缺失的宿主上下文。

官方 0.11.2 的[插件列表渲染器](https://github.com/getpaseo/paseo/blob/v0.11.2/packages/app/src/screens/settings/plugins-page.tsx#L117) 不读取 manifest `icon`／`media`。`assets/icon.png` 是用于未来可能的 registry 展示的元数据；该宿主版本的 Settings -> Plugins 不显示它。侧栏和命令 contribution 图标是另一机制。这些限制不代表原生 app 或其他宿主版本的行为已验证。

## 排错

先查目标宿主状态和日志：

```sh
paseo plugin ls paseo-kanban --json
paseo plugin logs paseo-kanban --json
```

其他 daemon 每条命令 `plugin` 前加 `--host "$PASEO_TARGET"`，值为 `tcp://host:port` 等 CLI endpoint。与本地 `--home` 二选一，不同用；插件／SDK 的 `PASEO_URL` 则用带 `/ws` 的 WebSocket URL。

| 症状 | 检查 |
|---|---|
| TARGET_AMBIGUOUS／连接 URL 畸形 | --home 与 --host 不同用。CLI 用 tcp://host:port 或 host:port，不能把 ws://host:port/ws 传给 CLI --host。 |
| Git source/tag/ref 不存在 | 用 `github:jasonhnd/paseo-kanban` 和真实 integration 分支或完整公开审过的 SHA。未公开本地 SHA、虚构 tag、裸 registry id、假定 npm 发布不是该来源。 |
| 相同 id 已安装 | `ls` 看来源。托管 Git 明确 ref 更新；directory 用已准备 remove/install 预案。重复 install 不覆盖。 |
| 依赖／准备／编译报错 | 核 daemon Node/npm/Git、`node:sqlite`、registry/网络和输出。托管更新失败保留旧版，仍核 revision 和功能；不要在托管目录构建。 |
| disabled | 全局 Enable plugins 和单插件各自检查，均须 on；全局开关也可能启动其他插件。 |
| running 但无入口／页面 | 查选中宿主、Settings -> Sidebar 可见性、app 版本、client 错误。打开真实入口；running 只证明 server。 |
| RPC 或页面错误 | 查日志和选中宿主连接，可能为请求验证或 server handler 错误；成功请求及错误态都测。 |
| host 拒绝版本 | daemon 和 app 都核范围；离线／未知不算通过。 |
| 无 provider/model | 在 Paseo 启用／安装并自行登录，再发现；不把认证文件发 issue。 |
| 发现了但请求失败 | 查 provider 状态、登录、额度；目录发现不证明这些。 |
| 无角色 | Fleet Settings 只预览；手动配置档案，保留旧项及明确 role/pool/实际 model。 |
| leader 不能建卡／验收 | 分别核协议、自登记；用 leader 面板和 `kanban_supervise` 或 CLI `supervise`，活旧登记须交接。 |
| 协议缺失 | 用面板恢复控制；普通档案选择不注入看板协议。 |
| 额度未知／空或策略无效 | 配自己的 pool、来源时间、策略；未知不是 0。受保护未知／无效不可变策略拒绝派活；关闭保护会去掉该额度护栏。 |
| 旧存储变量报错 | 取消 `AFC_DATA_DIR`、`ROLES_STATE_DIR`、`AFC_LEGACY_DATA_DIR`，用统一根，不自动读／导入旧资料。 |
| 更新后 CLI／数据根不同 | 保留 id/home/root，`ls` 刷新 `BOARD_INSTALL`，去除废弃 checkout 引用。不能跟代码路径一起换数据根。 |
| 缺命令 bundle | Git 安装应准备全部八个；保留错误，核精确候选。只有开发源码用 `npm run build`。 |
| 可选适配器意外运行 | `fleet/afc.config.json` 显式 `false`；旧 Cursor/keychain marker 能继承未设开关。Antigravity 必须明确 true 且匹配 plan。 |
| directory update 跳过／拒绝 | directory 改源码、typecheck、`plugin reload`；转 Git 是 remove/install，不是普通 update。 |
| reload 失败 | 查 ls/logs，修开发源码、typecheck、重新 reload；不自动恢复旧 bundle，无需为了源码 reload 重启 daemon。 |

`BOARD_INSTALL` 取当前安装路径，CLI 保持相同 home/root，私下运行诊断：

```sh
node "$BOARD_INSTALL/bin/afc.mjs" doctor --json
node "$BOARD_INSTALL/bin/paseo-kanban.mjs" doctor
```

输出可能含私有路径、项目和状态，只分享手动脱敏片段。离线类型／构建／测试不证明活认证、迁移或 client 挂载。

## 换版

先读 CHANGELOG Notes 的 host、契约/schema、顺序和恢复限制。**每次**指定分支或完整公开审过的 SHA：

```sh
paseo plugin update paseo-kanban --check --ref integration/single-plugin-reviewed --json
paseo plugin update paseo-kanban --ref integration/single-plugin-reviewed --json
```

`--ref` 不永久锁定未来普通更新；需要可复现升级／降级时，两条均改成记录的完整 SHA。先备份[一致数据和宿主设置](DATA.md#备份和数据恢复)。代码回退不撤销写入，托管更新保留旧版与失败 reload 不同。见 [Git 安装](../GIT-INSTALL.md)和[发布与恢复](RELEASE.md)。
