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

卡片 done/archived 满 24 小时后仍可自动清理；原有 owner、agent cwd、Git、目录活动/generation、退役日志和每轮数量限制继续生效。配置变化不会遗漏已记录的路径，默认清理不跟随被替换成符号链接的工作根。交活前把长期证据存进交接或其他获准的持久位置。

## 容量

每一轮调度用 `du -sk` 统计卡片临时根的已分配大小（按块，不是表面大小；被测路径本身是符号链接时不跟随）。成功的读数缓存约 10 分钟，或直到该目录的 mtime 变化。卡目录里面的文件变大但目录 mtime 没变时，用量最多滞后到缓存过期。磁盘剩余用 `statfs`，每轮都读，不缓存。

统计的根是各项目的 `.kanban-work` 和插件数据目录里的回退根。设置了 `KANBAN_TMP_ROOT` 时只统计这个根。总量是各根自己的 `du`，不是把子目录再加一遍。多个根在不同磁盘上时，剩余取最小的一块；任一块低于剩余阈值就暂停开新卡。

默认：临时根总量大于 10 GiB，或磁盘剩余小于 50 GiB，就暂停。两条只要碰到一条即暂停。在 `kanban.config.json` 里写：

```json
"capacity": { "maxWorkGiB": 10, "minFreeGiB": 50 }
```

文件里没有 `capacity` 时用上述默认，保存配置不会把这个键写回去。`0` 和其他非正数都退回同一默认。刚好 10 GiB 的卡片用量，或刚好 50 GiB 剩余，不暂停。

刹车期间，`start` 和自动开工返回原因，卡继续排队。已经在跑或在审查的卡不打断。下一轮两个量都回到阈值以内时，暂停自动解除。

`kanban doctor` 报红色 `board:capacity`，写明当前量、两个阈值，以及最大的 5 个卡目录和各自的卡状态。看板 leader 在同一次容量不足里只收到一次提醒，不会每轮再刷。`du` 或 `statfs` 失败本身不新开暂停：沿用上次成功读数，并按当前阈值重判，doctor 另加一条 info。没有上次读数时，新卡照常开。

卡片完成或验收时记录一次 `tmp_work_bytes`。`show`、列表和看板在有这个数时显示临时目录大小。之后目录再变大也不改已记录的数。目录不存在或 `du` 失败时字段留空，不挡住完成。

## 测试与现有安装切换

完整测试入口覆盖继承的 `KANBAN_TMP_ROOT`，每个测试进程还预载自己的显式卡片根，结束后清理。CLI 和假 launcher 的子进程继承这个根。每轮测试前后对比真实默认根的卡目录名称，发现新增即失败；负向验证只在自建项目目录中模拟残留。

安装切换按另行授权的流程进行。先核对项目目录与本地 exclude 可写；想用新默认值时去掉旧 `KANBAN_TMP_ROOT`。检查第一张新卡的环境及 `card_tmp_prepared` 事件。已有 agent 继续使用创建时的环境；已保存的简报和守则不会被改写。没有 prepared-path 事件的旧系统临时目录不会自动加入新清理根，应单独盘点，获准后再处理。本次源码改动不进行生产迁移或发布。
