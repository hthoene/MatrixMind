import Database from "better-sqlite3";
import path from "path";
import { safePath, ensureDir } from "../utils/safePath.js";
import { getLogger } from "../logger.js";

const log = getLogger("CronStore");

export interface CronJob {
  id: string;
  cronExpression: string;
  message: string;
  roomId: string;
  createdAt: string;
}

export class CronStore {
  private readonly db: Database.Database;

  constructor(workspacePath: string) {
    const cronDir = safePath(workspacePath, ".cron");
    ensureDir(cronDir);
    const dbPath = path.join(cronDir, "jobs.db");
    this.db = new Database(dbPath);
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cron_jobs (
        id TEXT PRIMARY KEY,
        cron_expression TEXT NOT NULL,
        message TEXT NOT NULL,
        room_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
  }

  list(): CronJob[] {
    const rows = this.db
      .prepare("SELECT * FROM cron_jobs")
      .all() as Array<{
        id: string;
        cron_expression: string;
        message: string;
        room_id: string;
        created_at: string;
      }>;
    return rows.map((r) => ({
      id: r.id,
      cronExpression: r.cron_expression,
      message: r.message,
      roomId: r.room_id,
      createdAt: r.created_at,
    }));
  }

  add(job: CronJob): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO cron_jobs (id, cron_expression, message, room_id, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(job.id, job.cronExpression, job.message, job.roomId, job.createdAt);
    log.info({ jobId: job.id, cron: job.cronExpression }, "Cron job saved");
  }

  remove(id: string): void {
    this.db.prepare("DELETE FROM cron_jobs WHERE id = ?").run(id);
    log.info({ jobId: id }, "Cron job removed");
  }

  close(): void {
    this.db.close();
  }
}
