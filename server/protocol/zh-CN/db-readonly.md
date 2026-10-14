查看板生产库一律原地直接打开，用 sqlite3 'file:<路径>?mode=ro&immutable=1'（代码里用 readonly 选项）；不要复制整库。确实要可写副本时，只复制 kanban.db 这一个文件到 $KANBAN_TMP/ 下。
