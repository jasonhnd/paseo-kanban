# 卡片工作目录

执行、审查、通读、决策、杂活卡开工时都会得到绝对路径 `KANBAN_TMP`，以及带结尾斜杠的 `TMPDIR`。日志、副本、构建产物、截图、浏览器配置及其他可重建内容都放在这里。目录用当前卡的显示卡号，并行卡彼此隔离。

默认路径是 `<项目 workspace>/.kanban-work/<卡号>/`。优先取 `kanban.config.json` 的 `projects.<项目>.workspacePath`（旧的 `workspace` 写法也支持）。没有配置目录时取卡片的原始仓库目录；临时 worktree 使用已记录的源仓库目录。例如：

```json
{
  "projects": {
    "demo": {
      "defaultWorkspace": "dir",
      "workspacePath": "/path/to/<project-workspace>/demo"
    }
  }
}
```

workspace 必须是可写的 Git 仓库根。看板会保留已有规则，只在 Git 本地 `info/exclude` 中加入 `.kanban-work/`。Git 会为关联 worktree 找到公共目录中的 exclude；不改跟踪的忽略文件。新建卡片目录和 generation 标记只允许当前用户访问。

项目不是 Git 仓库、目录丢失或工作目录/exclude 无法安全写入时，回退到 `<plugin-data-root>/work/<项目>/<卡号>/`。`<plugin-data-root>` 是 `KANBAN_DATA_DIR`，否则是 `$PASEO_HOME/plugin-data/paseo-kanban`；未设置 `PASEO_HOME` 时为 `~/.paseo/plugin-data/paseo-kanban`。项目名编码成单个目录段。不会回退到系统临时目录。`KANBAN_TMP_ROOT` 仍可显式指定 `<覆盖根>/<卡号>/`；显式覆盖不可用时记录错误，不悄悄换根。工作目录无法准备时拒绝开 agent，不继承进程的默认目录。

实际准备的路径记入卡片事件。恢复原 agent 时，即使配置或覆盖根改变，也在原路径旋转 generation。通读/决策权限只允许本卡目录以及原有 workspace/文档范围，不允许父目录或其他卡目录。`--brief-file` 只供 supervisor 使用，允许当前 Git 仓库和配置/回退/显式覆盖工作根；读取前检查真实路径，逃逸符号链接仍拒绝。默认不再接受任意系统临时文件。

卡片进入 done 或 archived 后，当轮或下一轮清理会删除其工作目录，不再等待。返工、阻塞和其他未结束的卡片保留目录。清理仍会拒绝：属主不是当前用户、卡片根本身是 Git 仓库、generation 已变化、本卡开过的 agent 仍在、或有进程把该目录当作工作目录。删除前不按文件数遍历，也没有文件数上限。删不掉时 doctor 报红，并按退避重试。进程工作目录来自每轮一次的 `lsof` 列表：先按 PATH 找 `lsof`，找不到再试 `/usr/sbin/lsof` 和 `/usr/bin/lsof`，因为服务管理器启动的 daemon 可能只有很精简的 PATH。三处都没有时清理不会永久报红：本卡开过的 agent 都已不存在或已归档，且没有任何在用 agent 的工作目录位于该目录内，就删除目录，并写一条 info 说明未找到 lsof、已按 agent 列表确认；有在用 agent 的工作目录在其中则保留目录并继续报红。配置变化不会遗漏已记录的路径，默认清理不跟随被替换成符号链接的工作根，也不会删除证据目录。交活前把长期证据存进交接或其他获准的持久位置。

## 容量

每一轮调度用 `du -sk` 统计卡片临时根的已分配大小（按块，不是表面大小；被测路径本身是符号链接时不跟随）。成功的读数缓存约 10 分钟，或直到该目录的 mtime 变化。卡目录里面的文件变大但目录 mtime 没变时，用量最多滞后到缓存过期。磁盘剩余用 `statfs`，每轮都读，不缓存。

统计的根是各项目的 `.kanban-work` 和插件数据目录里的回退根。设置了 `KANBAN_TMP_ROOT` 时只统计这个根。总量是各根自己的 `du`，不是把子目录再加一遍。多个根在不同磁盘上时，各盘与自己的保留量比较；任一块不足就暂停全新卡的首次开工。doctor 显示剩余空间减去保留量后余量最小的盘。

默认：临时根总量大于 10 GiB，或磁盘剩余小于 min(50 GiB, max(3 GiB, 磁盘容量的 25%))，就暂停。两条只要碰到一条即暂停。在 `kanban.config.json` 里可显式覆盖自动值：

```json
"capacity": { "maxWorkGiB": 10, "minFreeGiB": 50 }
```

文件里没有 `capacity` 时用上述默认，保存配置不会把这个键写回去。`minFreeGiB` 缺失、无效、为 `0` 或其他非正数时继续按盘自动计算，包含只设置 `maxWorkGiB` 的情况。正数 `minFreeGiB` 覆盖所有盘的自动值。刚好达到任一阈值不暂停。

刹车期间，还没跑过的执行、杂活、通读、决策卡，`start` 和自动开工返回原因，卡继续排队。审查卡、返工（原 agent 续跑、换人续做、重新打开后回到待开工的卡）以及 `in_review` / `reviewing` 的推进照常开工。已经在跑或在审查的卡不打断。下一轮两个量都回到阈值以内时，暂停自动解除。验收后的清理把用量降回阈值以下时，再下一轮排队的新卡会开工。

`kanban doctor` 报红色 `board:capacity`，写明当前量、两个阈值，以及最大的 5 个卡目录和各自的卡状态。看板 leader 在同一次容量不足里只收到一次提醒，不会每轮再刷。`du` 或 `statfs` 失败本身不新开暂停：沿用上次成功读数，并按当前阈值重判，doctor 另加一条 info。没有上次读数时，新卡照常开。

卡片完成或验收时记录一次 `tmp_work_bytes`。`show`、列表和看板在有这个数时显示临时目录大小。之后目录再变大也不改已记录的数。目录不存在或 `du` 失败时字段留空，不挡住完成。

## 共享程序，以及卡根里留什么

卡根只放这张卡不能和别人共用的可写状态：宿主的 `HOME` 和 `PASEO_HOME`、看板数据库、端口配置。程序、依赖安装和 npm 缓存放在卡外的共享目录。默认 runtime 目录是 `$HOME/.kanban-cache/paseo-runtime/<官方 package-lock 的 sha256>`，由 `scripts/shared-runtime.mjs` 只安装一次，然后改成只读。同一份 lock 的第二次安装会等锁文件，然后复用那个目录。`KANBAN_SHARED_RUNTIME_ROOT` 用来换父目录。测试把 `PASEO_SERVER_DIR` 指到其中的 `node_modules/@getpaseo/server`。真的需要一份可写副本时，用 APFS clone（`cp -c`），不要再 `npm ci` 一次。

默认 npm 缓存是 `$HOME/.kanban-cache/npm`，用 `KANBAN_SHARED_NPM_CACHE` 覆盖。`scripts/isolated-environment.mjs` 会设置这个缓存，并设置 `PASEO_VOICE_MODE_ENABLED=0` 和 `PASEO_DICTATION_ENABLED=0`。测试写出的宿主 `config.json` 把 `features.voiceMode.enabled` 和 `features.dictation.enabled` 写成 false。要显式检查语音时，另起一个打开这两个开关的宿主，那不是默认。

测试成功后立刻删掉卡根里的工作副本。收据、哈希和日志摘要要在删除前放进证据目录。证据目录不在被删的工作副本里面。看板之后对已结束卡片目录的清理不变。

## 测试与现有安装切换

完整测试入口覆盖继承的 `KANBAN_TMP_ROOT`，每个测试进程还预载自己的显式卡片根，结束后清理。CLI 和假 launcher 的子进程继承这个根。每轮测试前后对比真实默认根的卡目录名称，发现新增即失败；负向验证只在自建项目目录中模拟残留。

安装切换按另行授权的流程进行。先核对项目目录与本地 exclude 可写；想用新默认值时去掉旧 `KANBAN_TMP_ROOT`。检查第一张新卡的环境及 `card_tmp_prepared` 事件。已有 agent 继续使用创建时的环境；已保存的简报和守则不会被改写。没有 prepared-path 事件的旧系统临时目录不会自动加入新清理根，应单独盘点，获准后再处理。本次源码改动不进行生产迁移或发布。

默认磁盘保留量为 min(50 GiB, max(3 GiB, 磁盘总容量的 25%))：20 GiB 云盘保留 5 GiB，≥200 GiB 大盘仍保留 50 GiB。正数 `capacity.minFreeGiB` 会在所有盘上覆盖自动值；缺失、无效或非正数则继续自动计算，即使只设置了 `maxWorkGiB`。多盘分别判断，任一盘不足就排队。看板进程检查自己的卡临时目录所在盘；云机上运行看板时检查云机，宿主派云卡时检查宿主，云提供商的 `no_capacity` 是另一道检查。
