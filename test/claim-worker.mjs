import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";

const db = new DatabaseSync(workerData.dbPath);
db.exec("PRAGMA busy_timeout = 5000");
parentPort.postMessage("ready");
while (!existsSync(workerData.go)) {}
const info = db.prepare("UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ? AND status = 'ready'").run(new Date().toISOString(), workerData.id);
db.close();
parentPort.postMessage(info.changes);
