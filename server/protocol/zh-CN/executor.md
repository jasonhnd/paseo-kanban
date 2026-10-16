看板工作守则（执行）：
1. 先调用 kanban_show 读这张卡。
2. 只在卡片的工作目录里干活。每完成一步就 commit。
3. 收尾调用 kanban_complete。handoff 必须包含 files、verification、risks。没有 CI 的仓库，合并前在本机跑测试和构建，结果写进交接。等别的 PR 先合不算卡住；交付已备好、等 PR 合并／等别的卡时，照常交活，在可选的 handoff.waitingOn 写明等什么（例如 PR <url> 合并），卡片显示「等外部：…」，由 <leader> 验收时核对。没有 CI 的仓库，交活前在本机跑完测试和构建并把命令和结果写进 verification；等 CI 时照常交活，在 handoff.waitingOn 写明等待。
4. 真正需要人（权限、用户决定等）才用 kanban_block，kind=needs_human。执行者用 dependency 报等 PR／等别的卡会被拒绝：「这不算卡住，请交活并在交接写明等什么」。 等钟点用 scheduled＋until（未来带偏移 ISO，≤7天），不用 transient；超限让<leader>用 wait-user。
5. {noWaitRule}
6. 工具支持时，能拆开的查找、阅读、测试、核对先派 sub-agent 同时做，再汇总。改代码仍由你自己做，以免互相覆盖。{subagentWait}
7. 需要开 PR 时可以在本卡目录里新建分支，但不要另开 worktree。合并 PR 时，不要在本卡的临时 worktree 里把 PR 的 head 分支 checkout 成当前分支。用独立的本地分支或 ref 推送，或者直接 gh pr merge，不要 checkout head。切到别的 PR 分支处理后，先切回本卡分支再 gh pr merge，否则 Paseo 会在合并后归档整个目录、连你一起收走。
合并卡可以挂在 PR 卡后面，看板会自动识别、不会死锁；使用 role=batch，并在标题／简报写清同仓库 PR 号或完整链接。
8. {tmpHome}不要写进仓库的跟踪文件；卡结束 24 小时后看板会自动删本卡的 KANBAN_TMP 目录，需要长期保留的证据贴进交接或卡片评论。交活前 git status --short 必须为空（未跟踪文件也不行），否则先清掉或移出。
9. {dbReadonly}
{cliFallback}
