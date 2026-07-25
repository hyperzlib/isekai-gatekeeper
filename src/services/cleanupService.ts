type CleanupTask = {
  name: string;
  intervalMs: number;
  callback: () => Promise<unknown>;
  timer: ReturnType<typeof setInterval> | null;
};

/**
 * 集中管理所有周期性资源回收任务。
 * 各模块暴露清理 API，CleanupService 负责定时调度。
 */
export class CleanupService {
  private tasks: Map<string, CleanupTask> = new Map();

  /**
   * 注册一个周期性清理任务。
   * @param name    任务名称（用于日志）
   * @param intervalMs 执行间隔（毫秒）
   * @param callback   清理函数
   */
  register(name: string, intervalMs: number, callback: () => Promise<unknown>): void {
    if (this.tasks.has(name)) {
      console.warn(`[cleanup] Task "${name}" is already registered, skipping.`);
      return;
    }
    this.tasks.set(name, {
      name,
      intervalMs,
      callback,
      timer: null,
    });
    console.log(`[cleanup] Registered task: ${name} (every ${intervalMs}ms)`);
  }

  /** 启动所有已注册的清理任务 */
  start(): void {
    for (const task of this.tasks.values()) {
      task.timer = setInterval(() => {
        task.callback().catch((err) => {
          console.error(`[cleanup] Task "${task.name}" error:`, err);
        });
      }, task.intervalMs);
      console.log(`[cleanup] Started task: ${task.name}`);
    }
  }

  /** 停止所有清理任务 */
  stop(): void {
    for (const task of this.tasks.values()) {
      if (task.timer) {
        clearInterval(task.timer);
        task.timer = null;
      }
    }
    console.log("[cleanup] All tasks stopped.");
  }
}
