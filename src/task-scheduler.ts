import { ChildProcess } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';

import { ASSISTANT_NAME, SCHEDULER_POLL_INTERVAL, TIMEZONE } from './config.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  deleteSession,
  getAllTasks,
  getDueTasks,
  getTaskById,
  logTaskRun,
  setSession,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup, ScheduledTask } from './types.js';

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const TRADING_EXECUTION_DELAY_MS = 60_000;
const TRADING_WINDOWS_MINUTES: Array<[number, number]> = [
  [9 * 60, 12 * 60],
  [13 * 60 + 30, 15 * 60],
  [21 * 60, 23 * 60],
];

function computeNextTradingRun(
  afterIso: string,
  intervalMs: number,
): string | null {
  if (!intervalMs || intervalMs <= 0) return null;

  const cursorUtcMs = new Date(afterIso).getTime();
  if (Number.isNaN(cursorUtcMs)) return null;

  const cursorLocalMs = cursorUtcMs + SHANGHAI_OFFSET_MS;

  for (let dayOffset = 0; dayOffset < 14; dayOffset += 1) {
    const cursorLocal = new Date(cursorLocalMs);
    const dayLocalMs = Date.UTC(
      cursorLocal.getUTCFullYear(),
      cursorLocal.getUTCMonth(),
      cursorLocal.getUTCDate() + dayOffset,
      0,
      0,
      0,
      0,
    );
    const weekday = new Date(dayLocalMs).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;

    for (const [startMinute, endMinute] of TRADING_WINDOWS_MINUTES) {
      const startLocalMs = dayLocalMs + startMinute * 60_000;
      const endLocalMs = dayLocalMs + endMinute * 60_000;
      let candidateLocalMs =
        startLocalMs + intervalMs + TRADING_EXECUTION_DELAY_MS;
      if (cursorLocalMs >= startLocalMs) {
        const elapsedMs =
          cursorLocalMs - startLocalMs - TRADING_EXECUTION_DELAY_MS;
        if (elapsedMs < 0) {
          if (candidateLocalMs <= endLocalMs) {
            return new Date(
              candidateLocalMs - SHANGHAI_OFFSET_MS,
            ).toISOString();
          }
          continue;
        }
        const steps = Math.floor(elapsedMs / intervalMs) + 1;
        candidateLocalMs =
          startLocalMs + steps * intervalMs + TRADING_EXECUTION_DELAY_MS;
      }
      if (candidateLocalMs <= endLocalMs) {
        return new Date(candidateLocalMs - SHANGHAI_OFFSET_MS).toISOString();
      }
    }
  }

  return null;
}

/**
 * Compute the next run time for a recurring task, anchored to the
 * task's scheduled time rather than Date.now() to prevent cumulative
 * drift on interval-based tasks.
 *
 * Co-authored-by: @community-pr-601
 */
export function computeNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'once') return null;

  const now = Date.now();

  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    return interval.next().toISOString();
  }

  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (!ms || ms <= 0) {
      // Guard against malformed interval that would cause an infinite loop
      logger.warn(
        { taskId: task.id, value: task.schedule_value },
        'Invalid interval value',
      );
      return new Date(now + 60_000).toISOString();
    }
    // Anchor to the scheduled time, not now, to prevent drift.
    // Skip past any missed intervals so we always land in the future.
    let next = new Date(task.next_run!).getTime() + ms;
    while (next <= now) {
      next += ms;
    }
    return new Date(next).toISOString();
  }

  if (task.schedule_type === 'trading_interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (!ms || ms <= 0 || !task.next_run) {
      logger.warn(
        { taskId: task.id, value: task.schedule_value },
        'Invalid trading interval value',
      );
      return new Date(now + 60_000).toISOString();
    }
    const nextRun = computeNextTradingRun(task.next_run, ms);
    return nextRun ?? new Date(now + 60_000).toISOString();
  }

  return null;
}

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

function isRecoverableSessionResumeError(error: string | null): boolean {
  if (!error) return false;
  return error.includes('Claude Code process exited with code 1');
}

function buildScheduledTaskFailureMessage(
  task: ScheduledTask,
  error: string,
): string {
  const reason = error.replace(/\s+/g, ' ').trim().slice(0, 200);
  return `定时任务执行失败\n任务ID: ${task.id}\n原因: ${reason}`;
}

function buildScheduledTaskStartMessage(task: ScheduledTask): string {
  return `定时任务开始执行\n任务ID: ${task.id}`;
}

function buildScheduledTaskHeartbeatMessage(
  task: ScheduledTask,
  elapsedMinutes: number,
): string {
  return `定时任务仍在执行\n任务ID: ${task.id}\n已运行: ${elapsedMinutes} 分钟`;
}

async function sendScheduledTaskMessage(
  deps: SchedulerDependencies,
  task: ScheduledTask,
  text: string,
  logLabel: string,
): Promise<void> {
  try {
    await deps.sendMessage(task.chat_jid, text);
  } catch (sendErr) {
    logger.error(
      {
        taskId: task.id,
        chatJid: task.chat_jid,
        error: sendErr instanceof Error ? sendErr.message : String(sendErr),
      },
      logLabel,
    );
  }
}

async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  const startTime = Date.now();
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(task.group_folder);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Stop retry churn for malformed legacy rows.
    updateTask(task.id, { status: 'paused' });
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder, error },
      'Task has invalid group folder',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error,
    });
    return;
  }
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info(
    { taskId: task.id, group: task.group_folder },
    'Running scheduled task',
  );

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (g) => g.folder === task.group_folder,
  );

  if (!group) {
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder },
      'Group not found for task',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Group not found: ${task.group_folder}`,
    });
    return;
  }

  // Update tasks snapshot for container to read (filtered by group)
  const isMain = group.isMain === true;
  const tasks = getAllTasks();
  writeTasksSnapshot(
    task.group_folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  let result: string | null = null;
  let error: string | null = null;

  // For group context mode, use the group's current session
  const sessions = deps.getSessions();
  const initialSessionId =
    task.context_mode === 'group' ? sessions[task.group_folder] : undefined;
  let completed = false;
  let hasFinalUserMessage = false;

  await sendScheduledTaskMessage(
    deps,
    task,
    buildScheduledTaskStartMessage(task),
    'Failed to send scheduled task start message',
  );

  const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
  const heartbeatTimer = setInterval(() => {
    if (completed || hasFinalUserMessage) return;
    const elapsedMinutes = Math.max(
      1,
      Math.floor((Date.now() - startTime) / 60000),
    );
    void sendScheduledTaskMessage(
      deps,
      task,
      buildScheduledTaskHeartbeatMessage(task, elapsedMinutes),
      'Failed to send scheduled task heartbeat message',
    );
  }, HEARTBEAT_INTERVAL_MS);

  // After the task produces a result, close the container promptly.
  // Tasks are single-turn — no need to wait IDLE_TIMEOUT (30 min) for the
  // query loop to time out. A short delay handles any final MCP calls.
  const TASK_CLOSE_DELAY_MS = 10000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleClose = () => {
    if (closeTimer) return; // already scheduled
    closeTimer = setTimeout(() => {
      logger.debug({ taskId: task.id }, 'Closing task container after result');
      deps.queue.closeStdin(task.chat_jid);
    }, TASK_CLOSE_DELAY_MS);
  };

  const runOnce = async (sessionId?: string): Promise<ContainerOutput> =>
    runContainerAgent(
      group,
      {
        prompt: task.prompt,
        sessionId,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        isMain,
        isScheduledTask: true,
        assistantName: ASSISTANT_NAME,
      },
      (proc, containerName) =>
        deps.onProcess(task.chat_jid, proc, containerName, task.group_folder),
      async (streamedOutput: ContainerOutput) => {
        if (streamedOutput.newSessionId) {
          sessions[task.group_folder] = streamedOutput.newSessionId;
          setSession(task.group_folder, streamedOutput.newSessionId);
        }
        if (streamedOutput.result) {
          result = streamedOutput.result;
          // Forward result to user (sendMessage handles formatting)
          await deps.sendMessage(task.chat_jid, streamedOutput.result);
          hasFinalUserMessage = true;
          scheduleClose();
        }
        if (streamedOutput.status === 'success') {
          deps.queue.notifyIdle(task.chat_jid);
          scheduleClose(); // Close promptly even when result is null (e.g. IPC-only tasks)
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
        }
      },
    );

  try {
    let output = await runOnce(initialSessionId);

    if (
      output.newSessionId &&
      output.newSessionId !== sessions[task.group_folder]
    ) {
      sessions[task.group_folder] = output.newSessionId;
      setSession(task.group_folder, output.newSessionId);
    }

    if (
      output.status === 'error' &&
      task.context_mode === 'group' &&
      initialSessionId &&
      isRecoverableSessionResumeError(output.error || null)
    ) {
      logger.warn(
        {
          taskId: task.id,
          group: task.group_folder,
          sessionId: initialSessionId,
        },
        'Scheduled task failed while resuming session, retrying with a fresh session',
      );
      delete sessions[task.group_folder];
      deleteSession(task.group_folder);
      error = null;
      result = null;
      output = await runOnce(undefined);
      if (output.newSessionId) {
        sessions[task.group_folder] = output.newSessionId;
        setSession(task.group_folder, output.newSessionId);
      }
    }

    if (closeTimer) clearTimeout(closeTimer);

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else if (output.result) {
      // Result was already forwarded to the user via the streaming callback above
      result = output.result;
    }

    logger.info(
      { taskId: task.id, durationMs: Date.now() - startTime },
      'Task completed',
    );
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  } finally {
    completed = true;
    clearInterval(heartbeatTimer);
  }

  const durationMs = Date.now() - startTime;

  if (error && !result) {
    await sendScheduledTaskMessage(
      deps,
      task,
      buildScheduledTaskFailureMessage(task, error),
      'Failed to send scheduled task failure message',
    );
  }

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });

  const nextRun = computeNextRun(task);
  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  updateTaskAfterRun(task.id, nextRun, resultSummary);
}

let schedulerRunning = false;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        deps.queue.enqueueTask(currentTask.chat_jid, currentTask.id, () =>
          runTask(currentTask, deps),
        );
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

/** @internal - for tests only. */
export function _resetSchedulerLoopForTests(): void {
  schedulerRunning = false;
}
