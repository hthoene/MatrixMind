import cron from "node-cron";
import { v4 as uuidv4 } from "uuid";
import { CronStore, CronJob } from "./CronStore.js";
import { getLogger } from "../logger.js";

const log = getLogger("CronEngine");

type MessageCallback = (roomId: string, message: string) => Promise<void>;

export class CronEngine {
  private readonly tasks = new Map<string, cron.ScheduledTask>();
  private readonly stores = new Map<string, CronStore>();
  private onMessage: MessageCallback = async () => {};

  setMessageCallback(cb: MessageCallback): void {
    this.onMessage = cb;
  }

  loadFromWorkspace(workspacePath: string): void {
    const store = this.getOrCreateStore(workspacePath);
    const jobs = store.list();
    for (const job of jobs) {
      this.scheduleTask(job);
    }
    log.info({ count: jobs.length, workspacePath }, "Loaded cron jobs");
  }

  schedule(
    workspacePath: string,
    cronExpression: string,
    message: string,
    roomId: string
  ): CronJob {
    if (!cron.validate(cronExpression)) {
      throw new Error(`Invalid cron expression: ${cronExpression}`);
    }

    const job: CronJob = {
      id: uuidv4(),
      cronExpression,
      message,
      roomId,
      createdAt: new Date().toISOString(),
    };

    const store = this.getOrCreateStore(workspacePath);
    store.add(job);
    this.scheduleTask(job);
    return job;
  }

  remove(workspacePath: string, jobId: string): void {
    const task = this.tasks.get(jobId);
    if (task) {
      task.stop();
      this.tasks.delete(jobId);
    }
    const store = this.getOrCreateStore(workspacePath);
    store.remove(jobId);
  }

  private scheduleTask(job: CronJob): void {
    if (this.tasks.has(job.id)) return;
    if (!cron.validate(job.cronExpression)) {
      log.warn({ jobId: job.id, expr: job.cronExpression }, "Invalid cron expression, skipping");
      return;
    }

    const task = cron.schedule(job.cronExpression, () => {
      this.onMessage(job.roomId, job.message).catch((err) => {
        log.error({ err, jobId: job.id }, "Cron job execution failed");
      });
    });

    this.tasks.set(job.id, task);
    log.debug({ jobId: job.id, expr: job.cronExpression }, "Cron task scheduled");
  }

  private getOrCreateStore(workspacePath: string): CronStore {
    const existing = this.stores.get(workspacePath);
    if (existing) return existing;
    const store = new CronStore(workspacePath);
    this.stores.set(workspacePath, store);
    return store;
  }

  stop(): void {
    for (const task of this.tasks.values()) {
      task.stop();
    }
    for (const store of this.stores.values()) {
      store.close();
    }
    this.tasks.clear();
    this.stores.clear();
  }
}
