import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { runContainerAgent } = vi.hoisted(() => ({
  runContainerAgent: vi.fn(),
}));

vi.mock('./container-runner.js', async () => {
  const actual = await vi.importActual<typeof import('./container-runner.js')>(
    './container-runner.js',
  );
  return {
    ...actual,
    runContainerAgent,
    writeTasksSnapshot: vi.fn(),
  };
});

import {
  _initTestDatabase,
  createTask,
  getAllSessions,
  getTaskById,
} from './db.js';
import {
  _resetSchedulerLoopForTests,
  computeNextRun,
  startSchedulerLoop,
} from './task-scheduler.js';

describe('task scheduler', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    vi.useFakeTimers();
    runContainerAgent.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pauses due tasks with invalid group folders to prevent retry churn', async () => {
    createTask({
      id: 'task-invalid-folder',
      group_folder: '../../outside',
      chat_jid: 'bad@g.us',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    let started = false;
    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        if (started) return;
        started = true;
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    const task = getTaskById('task-invalid-folder');
    expect(task?.status).toBe('paused');
  });

  it('computeNextRun anchors interval tasks to scheduled time to prevent drift', () => {
    const scheduledTime = new Date(Date.now() - 2000).toISOString(); // 2s ago
    const task = {
      id: 'drift-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: '60000', // 1 minute
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();

    // Should be anchored to scheduledTime + 60s, NOT Date.now() + 60s
    const expected = new Date(scheduledTime).getTime() + 60000;
    expect(new Date(nextRun!).getTime()).toBe(expected);
  });

  it('computeNextRun returns null for once-tasks', () => {
    const task = {
      id: 'once-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'once' as const,
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated' as const,
      next_run: new Date(Date.now() - 1000).toISOString(),
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    expect(computeNextRun(task)).toBeNull();
  });

  it('computeNextRun skips missed intervals without infinite loop', () => {
    // Task was due 10 intervals ago (missed)
    const ms = 60000;
    const missedBy = ms * 10;
    const scheduledTime = new Date(Date.now() - missedBy).toISOString();

    const task = {
      id: 'skip-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: String(ms),
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    // Must be in the future
    expect(new Date(nextRun!).getTime()).toBeGreaterThan(Date.now());
    // Must be aligned to the original schedule grid
    const offset =
      (new Date(nextRun!).getTime() - new Date(scheduledTime).getTime()) % ms;
    expect(offset).toBe(0);
  });

  it('computeNextRun keeps trading-interval tasks inside trading windows', () => {
    const task = {
      id: 'trading-window-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'trading_interval' as const,
      schedule_value: String(15 * 60 * 1000),
      context_mode: 'isolated' as const,
      next_run: '2026-03-17T03:45:00.000Z',
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-03-17T03:30:00.000Z',
    };

    expect(computeNextRun(task)).toBe('2026-03-17T03:46:00.000Z');
  });

  it('computeNextRun starts trading-interval tasks at the next session open', () => {
    const task = {
      id: 'trading-open-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'trading_interval' as const,
      schedule_value: String(15 * 60 * 1000),
      context_mode: 'isolated' as const,
      next_run: '2026-03-17T09:17:09.931Z',
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-03-17T09:17:09.931Z',
    };

    expect(computeNextRun(task)).toBe('2026-03-17T13:16:00.000Z');
  });

  it('retries scheduled group-context tasks with a fresh session after resume failure', async () => {
    createTask({
      id: 'task-group-retry',
      group_folder: 'internal_trading-desk',
      chat_jid: 'tg:6325556041',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-03-12T00:00:00.000Z',
      context_mode: 'group',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-03-12T00:00:00.000Z',
    });

    runContainerAgent
      .mockResolvedValueOnce({
        status: 'error',
        result: null,
        error: 'Claude Code process exited with code 1',
      })
      .mockResolvedValueOnce({
        status: 'success',
        result: null,
        newSessionId: 'fresh-session',
      });

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    const sessions = {
      'internal_trading-desk': 'stale-session',
    };

    startSchedulerLoop({
      registeredGroups: () => ({
        'tg:6325556041': {
          name: 'Telegram Trading Desk',
          folder: 'internal_trading-desk',
          trigger: '@Andy',
          added_at: '2026-03-12T00:00:00.000Z',
        },
      }),
      getSessions: () => sessions,
      queue: {
        enqueueTask,
        closeStdin: vi.fn(),
        notifyIdle: vi.fn(),
      } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(runContainerAgent).toHaveBeenCalledTimes(2);
    expect(runContainerAgent.mock.calls[0]?.[1]?.sessionId).toBe(
      'stale-session',
    );
    expect(runContainerAgent.mock.calls[1]?.[1]?.sessionId).toBeUndefined();
    expect(sessions['internal_trading-desk']).toBe('fresh-session');
    expect(getAllSessions()).toEqual({
      'internal_trading-desk': 'fresh-session',
    });
  });

  it('sends a failure message when a scheduled task times out without output', async () => {
    createTask({
      id: 'task-timeout',
      group_folder: 'internal_trading-desk',
      chat_jid: 'tg:6325556041',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-03-12T00:00:00.000Z',
      context_mode: 'group',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-03-12T00:00:00.000Z',
    });

    runContainerAgent.mockResolvedValueOnce({
      status: 'error',
      result: null,
      error: 'Container timed out after 1800000ms',
    });

    const sendMessage = vi.fn(async () => {});
    let started = false;
    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        if (started) return;
        started = true;
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({
        'tg:6325556041': {
          name: 'Telegram Trading Desk',
          folder: 'internal_trading-desk',
          trigger: '@Andy',
          added_at: '2026-03-12T00:00:00.000Z',
        },
      }),
      getSessions: () => ({}),
      queue: {
        enqueueTask,
        closeStdin: vi.fn(),
        notifyIdle: vi.fn(),
      } as any,
      onProcess: () => {},
      sendMessage,
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenNthCalledWith(
      1,
      'tg:6325556041',
      expect.stringContaining('定时任务开始执行'),
    );
    expect(sendMessage).toHaveBeenNthCalledWith(
      2,
      'tg:6325556041',
      expect.stringContaining('定时任务执行失败'),
    );
    expect(sendMessage).toHaveBeenNthCalledWith(
      2,
      'tg:6325556041',
      expect.stringContaining('Container timed out after 1800000ms'),
    );
  });

  it('sends heartbeat messages while a scheduled task is still running', async () => {
    createTask({
      id: 'task-heartbeat',
      group_folder: 'internal_trading-desk',
      chat_jid: 'tg:6325556041',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-03-12T00:00:00.000Z',
      context_mode: 'group',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-03-12T00:00:00.000Z',
    });

    let resolveRun!: (value: {
      status: 'success';
      result: null;
      newSessionId?: string;
    }) => void;
    runContainerAgent.mockImplementationOnce(
      () =>
        new Promise<{
          status: 'success';
          result: null;
          newSessionId?: string;
        }>((resolve) => {
          resolveRun = resolve;
        }),
    );

    const sendMessage = vi.fn(async () => {});
    let started = false;
    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        if (started) return;
        started = true;
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({
        'tg:6325556041': {
          name: 'Telegram Trading Desk',
          folder: 'internal_trading-desk',
          trigger: '@Andy',
          added_at: '2026-03-12T00:00:00.000Z',
        },
      }),
      getSessions: () => ({}),
      queue: {
        enqueueTask,
        closeStdin: vi.fn(),
        notifyIdle: vi.fn(),
      } as any,
      onProcess: () => {},
      sendMessage,
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(sendMessage).toHaveBeenNthCalledWith(
      1,
      'tg:6325556041',
      expect.stringContaining('定时任务开始执行'),
    );

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(sendMessage).toHaveBeenNthCalledWith(
      2,
      'tg:6325556041',
      expect.stringContaining('定时任务仍在执行'),
    );

    resolveRun({ status: 'success', result: null });
    await vi.advanceTimersByTimeAsync(10);
  });
});
