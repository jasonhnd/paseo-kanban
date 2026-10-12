> 单插件只登记 Paseo Kanban（实际 id 为 `paseo-kanban`）。审查比较非空实际 model：同 family 不同 model 允许，缺证据时拒绝。真实 Linux/app/phone 和 provider 首卡仍待独立验收。

# 兼容性与排错

单 manifest 声明 Paseo >=0.11.0 <0.12.0。同时核对 daemon 和桌面 app；daemon 兼容不证明 app 兼容。放宽未来 host 范围前须跑编译、集成和桌面验证。

## 要求与证据边界

| 项目 | 要求 |
|---|---|
| Paseo | daemon/app 均在范围内，全局和单插件开关启用。 |
| Node | 单插件要求 >=22.13.0 且 node:sqlite 可用。须核对 daemon 的 Node 环境。 |
| npm / Git | npm 用于源码开发和本插件的 Git preparation，须在 daemon PATH；Git 用于代码卡、临时 workspace、Git 安装。 |
| Provider | 用户自己安装和登录；发现模型不证明登录、请求或额度成功。 |
| 审查 | 明确、非空的两个实际 model；同 family 不同 model 可审。 |

macOS 有导入/工具链文档里的本机源码、CLI、编译证据，完整干净环境桌面和首卡验证仍为发版闸。Linux 是首发目标，尚无完整原生流程认证记录。WSL2 单独验证；首发不支持原生 Windows，Node 启动器不证明整个流程或 shell helper 可用。本文修改不认证任何平台。发版记录须写 OS、Node、daemon/app、provider/model、来源和伴随提交/tag；可选 macOS 探针不作为核心前置。

## 排错

| 症状 | 检查 |
|---|---|
| 无 provider/模型 | 在 Paseo 安装启用并自行登录，再发现；不要向 issue 发认证文件。 |
| 发现了但请求失败 | 看 provider 自身状态；目录发现不证明认证和额度。 |
| 无角色档案 | Fleet Settings 只预览，手动在 Paseo 建档并保留旧项，确认 role、明确的实际 model 和 pool 策略。 |
| leader 不能建卡/验收 | 分别检查协议和自登记；用启动面板及 kanban_supervise 或 CLI supervise。活着的旧登记须交接。 |
| 协议缺失 | 用面板恢复控制；普通档案选择不注入协议，消息恢复有明确标签。 |
| 额度空/未知 | 只配自己的池，刷新或填有时间的读数；未知不是 0，无保护设置不提供额度护栏。 |
| 新装单插件 | 配置统一 Fleet 策略和自己的 pool；策略缺失或无效时拒绝派活。 |
| 启用但无面板 | 查 Plugins、日志、真实桌面入口；running 或编译绿不证明挂载。 |
| host 拒载/离线 | 核对支持范围和 daemon/app 组合；无法获得结果是未知，不是通过。 |
| 缺命令 bundle | 源码先构建或使用已安装发版产物；每次 Git update 后核对安装路径。 |

```sh
node "$BOARD_INSTALL/bin/afc.mjs" doctor --json
node "$BOARD_INSTALL/bin/paseo-kanban.mjs" doctor
```

输出可能含私有路径、项目，只分享手动脱敏片段。离线构建/类型/测试不证明认证、活 daemon、迁移或桌面。

## 换版

先读 CHANGELOG Notes 的 host 范围、契约、伴随最低版本、顺序、迁移和回退限制。每次 Git update 显式指定已发布 tag：

```sh
paseo plugin update paseo-kanban --check --ref vX.Y.Z
paseo plugin update paseo-kanban --ref vX.Y.Z
```

合并包只注册 paseo-kanban；manifest 准备流程构建统一命令。真实 Linux 宿主、桌面/phone 和真实 provider 首卡仍需独立发版验收，本机 Darwin 编译与匿名 DOM 挂载不能证明这些项目。切来源前备份数据和设置，代码回退不撤销数据写入。见 [RELEASE](RELEASE.md)。
