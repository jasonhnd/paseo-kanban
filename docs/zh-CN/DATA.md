# 数据、访问与备份

## 路径与归属

server 与所有命令使用一个独立于源码 checkout 的统一数据根：

| 位置 | 归属与行为 |
|---|---|
| `KANBAN_DATA_DIR` | 显式统一根；用稳定绝对路径，daemon 和 CLI 保持相同值。 |
| `PASEO_HOME/plugin-data/paseo-kanban` | 默认 fresh root；Paseo home 默认 `~/.paseo`。 |
| 根下 `kanban.db`、`kanban.config.json`、`kanban-decisions.json` | 看板持久状态、项目配置、本地决定。 |
| `fleet/` | Fleet 配置、策略、决定、面板偏好、采集状态和读数。 |
| `fleet/policy-snapshot.json` | 活服务和独立 CLI 均按当前控制输入核对的不可变策略。 |
| `exports/`、`exports/fleet/` | 同根下看板导出和 Fleet 兼容投影。 |
| 锁、备份、审计／日志、supervisor 凭证、`fleet/secrets/` | 私有运维状态，不整份公开或分享。 |
| Paseo 宿主插件设置与 enabled | 宿主所有，不在本插件数据根备份内，另行保存。 |
| app／浏览器偏好 | 部分语言偏好属于单个 client，切来源后单独检查。 |

`server/storage/root.ts` 解析根。`AFC_DATA_DIR`、`ROLES_STATE_DIR`、`AFC_LEGACY_DATA_DIR` 非空即配置错误，即使新根也有值。不会把旧安装、导出声明目录或 sibling 插件位置当活存储根。自定义根放在托管 checkout 外；更新／卸载可能删除 checkout。相对路径会依赖进程工作目录，不适合来源切换。

Git revision 改代码位置，不改外置根。换来源保留 `paseo-kanban` id、`PASEO_HOME`、`KANBAN_DATA_DIR`；刷新 CLI 安装路径，不让 `KANBAN_HOME` 绑旧托管目录。这是存储契约，不是已完成生产转换的证明。旧资料不会自动转入。

## 文件、进程和网络

Paseo 插件是受信任、**无沙箱**的代码。server／准备命令拥有 daemon 用户的文件、进程、凭证和网络访问；client 运行在 app 内。下表说明实际行为，不代表权限沙箱：

| 触发 | 访问或执行 |
|---|---|
| Git 安装／更新 | Paseo 从 GitHub／Git 下载明确来源；插件准备按锁文件调用 npm 访问宿主配置的 registry，再调用 Node 构建命令。 |
| 项目／卡片操作 | 读写看板／Fleet、配置的项目文件和 Git workspace；通过 Paseo 创建 agent、发任务、停止／归档 agent 和管理 workspace。可能运行 Git／Node／provider 子进程；简报和任务上下文经 agent 发给选定 provider。 |
| 额度采集 | 读取配置的 pool／策略，向 Paseo 请求 provider usage，并可能运行配置的 usage 工具。provider 工具可通过用户自己的登录访问其服务；发现或读数不证明首卡成功。 |
| 可选 Cursor | 使用本插件自己的用户授权登录，向 `cursor.com`、`api2.cursor.sh` 发 usage／login／refresh 请求，携带认证和端点需要的登录／用量请求字段，缓存自己状态。可运行配置的本地 usage-screen 回落和 login watch。 |
| 可选 macOS keychain | 调用本地 `security` 作存在性／状态查询，不请求 secret 值；记录探针状态，可能通知配置的 leader。 |
| 可选 Antigravity | 运行本地 `agy -p "/usage"` 获取显示读数，不读其他工具凭证、不调用私有后端，不证明 CLI 和 Paseo ACP 共用额度池。 |

fresh root 的 `cursor-api`、`keychain`、`antigravity-cli` 均默认 off。开关在 `fleet/afc.config.json`，[示例](../../examples/afc.config.example.json)显式写 `false`。旧 Cursor／keychain 状态 marker 可让**未设置**的开关继承 on；显式 `false` 优先。Antigravity 没有 marker 继承，须显式 `true` 且 plan 匹配。关这些可选开关不等于关闭所有核心 usage 采集或 provider 网络流量。

provider 登录由用户掌握，不借其他应用认证文件，不把生产凭证搬进测试 home。插件登录状态、supervisor 凭证、原始任务、日志、路径和导出都可能敏感，即使公开源码不含 secret。

## 读写边界

| 域 | 边界 |
|---|---|
| Kanban | 持有派活及配置的 workspace／agent 操作。 |
| Fleet 服务 | 一个 start/dispose 所有者管理采集、策略发布和维护任务，使用 Kanban host binding。 |
| 派活入口 | 服务内注入不可变策略；独立 CLI 读持久 revision，核 digest、来源时间、TTL 和 model 门。 |
| 兼容入口 | 旧 JSON、`afc`／`roles` 只解析新根；导出声明不能扩大角色状态读取根。 |
| 决定 | Fleet full/open 和看板本地列表保持归属，拒绝含混重复 id。 |
| 平台功能 | Linux keychain／screen 功能 unavailable；匿名测试不运行真实探针。 |

1 小时采样、62 分钟显示过期、7 分钟额度保护各自独立；发布时间不能替代缺失来源时间。没有全局失败 stream 的限制仍在。

## 备份和数据恢复

更新、降级、卸载／重装或换来源前：

1. 记录实际数据根、完整 revision／source／path、id、enabled 和相关环境设置；留卡数及设置用于比较，不公开原始资料。
2. 停派活及**所有写者**，包括插件循环、活 agent／CLI 写者、外部定时 helper。仅停用插件不证明全部写者已停。
3. 在私密位置备份整个统一根，包括 `fleet/`、配置、决定、导出和需要保留的插件 secret。用一致 SQLite 备份或已正确关闭的数据库。不能只复制活 `kanban.db` 而忽略 WAL，也不能拼无关数据库／WAL；停写期间确认备份可读。
4. 另存 Paseo 宿主的插件设置、语言、enabled。数据根备份不包含宿主设置或所有 client 偏好；凭证由用户自己私密恢复。
5. 备份放在托管源码外、限制访问，记录代码／schema 版本；先用匿名数据验证可恢复性。

`plugin remove` 删托管源码、可能删宿主设置，不自动清空外置数据根。重装保持同一 id／home／root，明确恢复 settings／enabled；恢复写者前核 server、board、Fleet、CLI、exports 的实际根一致。

**代码回退和数据恢复是两件事。** 降到旧 Git SHA 仍保留当前数据。旧代码不能读取新数据／schema 时，不直接启动它。单独授权的数据恢复须停写、用一致兼容备份，并先保留当前状态；恢复会回到备份时刻、丢失之后写入。更新失败不自动恢复数据备份。

## 手动转移与隔离测试

只在确实要搬旧资料时用[手动转移](../MANUAL-MIGRATION.md)：确认 source、停写、自行备份、逐项按白名单复制、解决冲突并自行设置凭证。生成读数、策略快照、控制状态须重算。directory 转 Git 不要求导入旧 Fleet 或移动数据根；见[来源切换预案](RELEASE.md#directory-转-git-操作预案)。

测试只用匿名 home、fresh `KANBAN_DATA_DIR`、明确且未占用的 loopback listener、私有 `TMPDIR`。取消旧变量，白名单 child env，显式关闭可选适配器；不连个人 daemon、不读凭证／生产资料。清理前停本卡进程；编译用的 `PASEO_SERVER_DIR` 只指单独安装的公开宿主包。

状态、审计、备份、日志、凭证保持私有，只分享手动脱敏诊断片段。[English](../DATA.md) · [安全](SECURITY.md) · [兼容性](COMPATIBILITY.md) · [发布与恢复](RELEASE.md)
