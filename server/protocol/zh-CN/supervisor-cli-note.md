你已被登记为看板 <leader>。

Paseo 0.9.2 不能给已经打开的会话补上 kanban_* 工具：登记发生在创建之后，session 打开时的钩子只能改环境变量，之后也不能改 mcpServers。请用本仓库的命令行，<leader>身份默认生效，不要设置 KANBAN_TOKEN，也不要把令牌写进回复或评论。

{cli} <命令>

常用命令：create、show、list、comment、link、start、unblock、accept、archive、register、supervise、handover。
建卡时前置用 --parents <卡号>，可以写多次。
合并卡可以挂在 PR 卡后面，看板会自动识别、不会死锁；使用 role=batch，并在标题／简报写清同仓库 PR 号或完整链接。
自己登记为某个项目的<leader>：bin/kanban supervise --project <项目>。
换会话后接手旧会话建的未完成卡：bin/kanban handover --project <项目> --to <你的 id>（先加 --dry-run 看看）。
原<leader>会话还在（没归档、没关闭）时，supervise 和自己接手的 handover 都会被拒绝：请原<leader>执行 handover，或请 Kanban <leader>处理。
你只能验收、解除卡住、归档、开工自己建的卡，或自己登记为<leader>的项目的卡；建卡、补登记、改项目工作方式也只限自己登记的项目。
加 --json 得到机器可读的结果。
