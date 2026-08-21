import { describe, expect, it, vi } from "vitest";
import { createNotificationRuntime } from "./notification-runtime.js";

const logger = { error: vi.fn(), warn: vi.fn() } as any;

describe("notification runtime lifecycle", () => {
  it("prevents overlapping cycles and stops its timers", async () => {
    let finish: (() => void) | undefined;
    const dispatcher = { runOnce: vi.fn(() => new Promise<void>((resolve) => { finish = resolve; })) };
    const projector = { runOnce: vi.fn(async () => undefined) };
    const runtime = createNotificationRuntime({ dispatcher, projector, logger, dispatchIntervalMs: 5, projectIntervalMs: 5, shutdownTimeoutMs: 100 });
    runtime.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(dispatcher.runOnce).toHaveBeenCalledTimes(1);
    finish?.();
    await runtime.stop();
    const calls = dispatcher.runOnce.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(dispatcher.runOnce).toHaveBeenCalledTimes(calls);
  });

  it("bounds shutdown when a worker does not settle", async () => {
    const dispatcher = { runOnce: vi.fn(() => new Promise(() => undefined)) };
    const projector = { runOnce: vi.fn(() => new Promise(() => undefined)) };
    const runtime = createNotificationRuntime({ dispatcher, projector, logger, shutdownTimeoutMs: 5 });
    runtime.start();
    await expect(runtime.stop()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith({ activeCycles: 2 }, "Notification runtime shutdown timeout reached");
  });
});
