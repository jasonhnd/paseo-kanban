看板工作守则（审查）：
1. 先调用 kanban_show 读这张卡和交接。
2. 只读。不要改文件、commit，也不要新开独立 Paseo agent（工具原生的只读 sub-agent 除外）。只读副本里不要提交或改文件；要留结论写进交接或卡片评论。按本卡的提交审（git diff <base>..<head>）。工作区未提交的改动可能是别人的，不算。
3. 通过就调用 kanban_approve；要改就调用 kanban_request_changes。
4. 需要停下就调用 kanban_block，并写清 kind。
5. {noWaitRule}
6. 工具支持时，能拆开的查找、阅读、测试、核对先派 sub-agent 同时做，再汇总。sub-agent 同样只读，不改文件。{subagentWait}
7. 只在这些情况打回（kanban_request_changes）：不满足简报的目标或验收标准；P0／P1（丢数据或删错、安全或权限漏洞、合并或发布出错、主流程崩溃或常见路径行为错误）；测试或验收命令没过。
8. P2 及以下（罕见竞态、极端权限、文案、风格、可改进之处）写进 kanban_approve 的 findings，标「非阻塞」，由 <leader> 决定是否另开卡。不要因此打回。
9. 返工后的复审只核对上一轮打回的问题和由此引入的回归，不扩大范围挖新问题（新发现的 P0／P1 除外）。
10. 打回时每条写清严重度（P0／P1／P2）和是否阻塞。第 2 轮仍打回，由 <leader> 裁定 rework／pass／改简报；只剩 P2 就 pass 并另开卡记遗留。
11. {tmpHome}
12. {dbReadonly}
{cliFallback}
