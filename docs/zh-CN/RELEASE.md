# Git 发布与恢复清单

本批**只通过 Git 分发**。公开仓库为 `https://github.com/jasonhnd/paseo-kanban`，分支 `integration/single-plugin-reviewed`。包版本 `0.1.0` 是实验元数据，不证明 npm、tag 或官方目录已发布。本文列待做检查，不宣称发布、生产切换或外部提交完成，也不授权这些操作。

## 版本及证据规则

单插件只有一个 package／version／CHANGELOG，id 为 `paseo-kanban`。0.x 兼容修复升 patch，新增或配置／行为破坏升 minor；1.x 按 SemVer。契约/schema 版本独立；兼容新增保留，破坏须明确迁移／恢复方案。

Git 分支可变，是否有 tag 都要保存完整审过的公开 commit。该渠道不强制 tag，存在前不写成安装目标。未来使用 tag 时与包／CHANGELOG 对齐、审 tag 元数据，不挪动／覆盖／复用；保留旧验证提交供回退。

发布确认前保持 Unreleased 的 Added／Changed／Fixed／Security／Notes，写明宿主范围、数据／契约变更、真测限制，不把源码检查写成 app/provider 认证。

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

语法按公开 **Paseo CLI 0.11.2 help 和固定文档**核对，未把安装命令运行于真实产品。隔离验证及最终整合主责须填精确候选／宿主、命令、退出码、前后结果；发布主责在最终 ref 公开后从 GitHub 再重放适用项。日志私密，摘要匿名。

所有生命周期命令均用新 home 和明确 endpoint，例如 `paseo --home "$PASEO_TEST_HOME" --host "$PASEO_TEST_HOST" plugin ...`。白名单 env，不继承 agent 身份／token，relay/provider 禁用，可选适配器明确 false；真 provider 只用用户自己建立的隔离登录，不拷生产认证。

| 重放项 | 要求与本文当前状态 |
|---|---|
| `paseo --version`、顶层/plugin/install/update help | 留版本与参数；仅 help 核对，无 daemon 验证。 |
| `install github:jasonhnd/paseo-kanban --ref integration/single-plugin-reviewed --json` | 真远端 revision/path、完成准备的产品；待隔离／发布后重放。 |
| 最终公开 SHA 安装；先本地 `file://` 精确 SHA | 精确内容、锁准备、八个 bundle、fresh cache/production 环境 CLI；待做。 |
| `ls paseo-kanban --json`、`logs paseo-kanban --json` | 来源/revision/path/enabled/错误、脱敏输出；待真实安装检查。 |
| 重复同 id／不存在 ref | 拒绝且旧路径／revision/enabled/data 不变；待做。 |
| `update paseo-kanban --check --ref "$REVIEWED_COMMIT" --json` | 只预览，revision/path/state 不变；待做。 |
| `update paseo-kanban --ref "$REVIEWED_COMMIT" --json` | 精确新版、CLI/RPC/UI 工作、根不变；待做。 |
| `--ref "$PREVIOUS_COMMIT"` 预览／降级／再升级 | 只改代码，数据 sentinel 保留；待做。 |
| 本地 bad prepare/compile/activation refs | 拒绝更新，旧安装／路径／enabled/data 和功能保留；待做。 |
| `disable`／`enable`／`remove`／同 id 重装 | 生命周期、设置、外置根核对；待做。 |
| 开发 directory install/edit/typecheck/reload | directory update 跳过／拒绝；reload 失败不自动回退；待做。 |
| directory 转 Git 及反向 | 默认／显式根、settings/enabled、CLI/exports、scheduler 连续性；待做。 |
| 匿名一致备份与数据恢复 | 与代码降级分开，证明后写入与恢复后果；待做。 |
| 已安装 `paseo-kanban.mjs --help`／`list --json`、`roles.mjs ls`、doctor | Node 独立命令、当前路径、同根、无生产访问；待真实安装重放。 |
| 真 desktop/compact/phone | 真 host/app 版本、匿名截图、导航/RPC/错误/清理；各项独立待做。 |
| 真 provider 首卡 | commit -> 交活 -> 异 model 审查 -> leader 验收 -> 完成／清理；待做。 |

`REVIEWED_COMMIT`／`PREVIOUS_COMMIT` 取发布记录完整公开 SHA；未公开候选用本地 `file://`，不虚构远端。分支可能在预览／应用间前进；受控发布用预览精确 SHA。坏失败测试 ref 绝不 push。

官方依据：[0.11.2 reference](https://github.com/getpaseo/paseo/blob/75953250959979b8f088bbca8dbd6ee61d0151b1/public-docs/plugins/reference.md#cli-reference)、[publishing](https://github.com/getpaseo/paseo/blob/75953250959979b8f088bbca8dbd6ee61d0151b1/public-docs/plugins/publishing.md)、[现行 registry 审查快照](https://github.com/getpaseo/plugins/blob/06c64d182a3b0e0d879992231d1cf3c9a6bbf809/REVIEW.md)。语法／文档核对不认证运行行为。

## 更新与恢复

记录当前／目标完整 commit、来源类型、实际路径、根、enabled。停派活／写者，做[一致数据及独立宿主设置备份](DATA.md#备份和数据恢复)，明确 SHA 预览／应用：

```sh
paseo plugin update paseo-kanban --check --ref "$REVIEWED_COMMIT" --json
paseo plugin update paseo-kanban --ref "$REVIEWED_COMMIT" --json
paseo plugin ls paseo-kanban --json
```

恢复前核 revision、server/CLI/Fleet 根、设置／语言、策略／矩阵、卡数、exports/CLI 路径、真页面、批准的演示闭环。托管更新失败保留旧安装，仍核 revision/path/enabled 和功能。reload 失败须修复／重载，不自动回旧 bundle；只加载源码变化不需重启 daemon。

Git 代码回退在 `update --check --ref`／`update --ref` 指已验证旧公开 SHA，保留当前数据并核 schema。数据恢复另行明确授权：停全部写者、用一致兼容备份，先保留当前状态，因为会丢后续写入。不因更新错误自动恢复数据。

## Directory 转 Git 操作预案

**仅准备，未执行生产迁移。** 使用侧操作者需要实际来源／运行方式切换授权、最终审过的远端 SHA 和已通过的隔离转换／恢复证据。本文不授权 agent 读生产配置、数据库或凭证。

1. 确认目标 host、同 id `paseo-kanban`、旧 directory 路径／source/enabled、实际统一根；保持 `PASEO_HOME` 和 `KANBAN_DATA_DIR`。另存宿主设置／语言／enabled、一致私密根备份，保留旧源码原样。转换不顺便导入旧 Fleet。
2. 停派活、定时 helper 和全部写者。先演练安装期间持续有效的暂停机制：新装可能立即 enabled，恢复设置前循环已启动。无法控制时不做生产转换；中断时间取隔离演练，本文没有实测时长。
3. 同一 host 先 disable/remove directory；源目录保留，但宿主设置可能删除。directory 不能普通 update 转 Git，同 id install 须先 remove。

   ```sh
   paseo plugin disable paseo-kanban --json
   paseo plugin remove paseo-kanban --json
   paseo plugin install github:jasonhnd/paseo-kanban --ref "$REVIEWED_COMMIT" --json
   paseo plugin ls paseo-kanban --json
   ```

   非默认目标每条都加对应 `--home`／`--host`。不手改 source entries、不以 config reload 冒充生命周期切换。
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
