import { describe, expect, it, vi } from "vitest";

const log = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock("@/lib/core/logger", () => ({
  default: { child: vi.fn(() => log) },
}));

import { TaskQueue } from "../../lib/task-queue"; // Updated import

describe("TaskQueue Class", () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("processes items and tracks completion", async () => {
    const queue = new TaskQueue({ rateLimit: 1000, maxConcurrent: 10 });
    let completedCount = 0;

    const fn = async () => {
      await sleep(10);
      completedCount++;
      return "done";
    };

    queue.enqueue(fn, "item-1"); // Renamed to enqueue
    queue.enqueue(fn, "item-2");

    const stats = await queue.waitUntilFinished();

    expect(completedCount).toBe(2);
    expect(stats.settledCount).toBe(2);
    expect(stats.failedCount).toBe(0);
    expect(stats.failedItems).toEqual([]);
  });

  it("respects rate limits", async () => {
    // 50 items per second -> 1 every 20ms
    const queue = new TaskQueue({ rateLimit: 50, maxConcurrent: 10 });

    const start = performance.now();
    for (let i = 0; i < 5; i++) {
      queue.enqueue(async () => { }, `item-${i}`);
    }

    await queue.waitUntilFinished();
    const end = performance.now();
    const duration = end - start;

    // 1st item runs immediately. 2nd-5th items are delayed by 20ms each (Total 80ms).
    expect(duration).toBeGreaterThanOrEqual(75);
  });

  it("respects max concurrency", async () => {
    const queue = new TaskQueue({ rateLimit: 1000, maxConcurrent: 2 });
    let running = 0;
    let maxRunning = 0;

    const fn = async () => {
      running++;
      if (running > maxRunning) maxRunning = running;
      await sleep(30);
      running--;
    };

    for (let i = 0; i < 10; i++) {
      queue.enqueue(fn);
    }

    await queue.waitUntilFinished();
    expect(maxRunning).toBe(2);
  });

  it("resolves/rejects enqueue promises correctly", async () => {
    const queue = new TaskQueue({ rateLimit: 1000, maxConcurrent: 10 });

    const successFn = async () => "success-value";
    const failFn = async () => { throw new Error("fail-error"); };

    const successPromise = queue.enqueue(successFn, "s1");
    const failPromise = queue.enqueue(failFn, "f1");

    await expect(successPromise).resolves.toBe("success-value");
    await expect(failPromise).rejects.toThrow("fail-error");

    const stats = await queue.getStats();
    expect(stats.settledCount).toBe(2);
    expect(stats.failedCount).toBe(1);
    expect(stats.failedItems).toContain("f1");
  });

  it("logs only a safe error class and item ID when an item fails", async () => {
    log.warn.mockClear();
    const queue = new TaskQueue({ rateLimit: 1000, maxConcurrent: 10 });
    const privateMessage = "private failure message";
    const privatePayload = { recipient: "recipient.private@example.test", body: "private newsletter body" };
    const error = Object.assign(new Error(privateMessage), { payload: privatePayload });
    error.stack = "private stack trace";

    await expect(queue.enqueue(async () => { throw error; }, "safe-item-id"))
      .rejects.toBe(error);
    await queue.waitUntilFinished();

    expect(log.warn).toHaveBeenCalledWith(
      { errorClass: "Error", itemId: "safe-item-id" },
      "Queue item failed",
    );

    const loggedOutput = JSON.stringify(log.warn.mock.calls);
    for (const privateValue of [privateMessage, error.stack, JSON.stringify(privatePayload)]) {
      expect(loggedOutput).not.toContain(privateValue);
    }
  });

  it("clear() removes queued items and stops processing", async () => {
    const queue = new TaskQueue({ rateLimit: 1000, maxConcurrent: 1 });
    let executedCount = 0;

    const fn = async () => {
      executedCount++;
      await sleep(20);
    };

    for (let i = 0; i < 10; i++) {
      queue.enqueue(fn).catch(() => { });
    }

    await sleep(5);
    queue.clear(); // Renamed to clear

    await queue.waitUntilFinished();

    // Only the first item started before clear() was called
    expect(executedCount).toBe(1);
  });

  it("triggers onFinish listeners multiple times", async () => {
    const queue = new TaskQueue({ rateLimit: 1000, maxConcurrent: 10 });
    let finishCount = 0;

    queue.onFinish(() => {
      finishCount++;
    });

    await queue.enqueue(async () => { });
    await queue.waitUntilFinished();
    expect(finishCount).toBe(1);

    await queue.enqueue(async () => { });
    await queue.waitUntilFinished();
    expect(finishCount).toBe(2);
  });

  it("calculates min, max, and avg time correctly", async () => {
    const queue = new TaskQueue({ rateLimit: 1000, maxConcurrent: 10 });

    queue.enqueue(async () => { await sleep(10); }, "item-10");
    queue.enqueue(async () => { await sleep(30); }, "item-30");

    const stats = await queue.waitUntilFinished();

    expect(stats.min.time).toBeGreaterThanOrEqual(9);
    expect(stats.max.time).toBeGreaterThanOrEqual(29);
    expect(stats.avg).toBeGreaterThanOrEqual(15);
  });

  it("waitUntilFinished can be called after the queue has already finished", async () => {
    const queue = new TaskQueue({ rateLimit: 1000, maxConcurrent: 10 });

    queue.enqueue(async () => { });
    const firstStats = await queue.waitUntilFinished();
    expect(firstStats.settledCount).toBe(1);

    const secondStats = await queue.waitUntilFinished();
    expect(secondStats.settledCount).toBe(1);
  });
});