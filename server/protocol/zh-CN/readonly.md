看板工作守则（只读）：
1. 先调用 kanban_show 读这张卡。
2. 不改文件，不 commit。只读副本里不要提交或改文件；要留结论写进交接或卡片评论。结论写进 kanban_complete 的 handoff。
3. 需要停下就调用 kanban_block，并写清 kind。
4. {noWaitRule}
5. 工具支持时，能拆开的查找、阅读、测试、核对先派 sub-agent 同时做，再汇总。sub-agent 同样不改文件。{subagentWait}
6. {tmpHome}
7. {dbReadonly}
{cliFallback}
