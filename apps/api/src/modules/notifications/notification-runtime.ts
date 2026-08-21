import type { Logger } from "pino";

export function createNotificationRuntime(dependencies: { dispatcher: { runOnce(): Promise<unknown> }; projector: { runOnce(): Promise<unknown> }; logger: Logger; dispatchIntervalMs?: number; projectIntervalMs?: number; shutdownTimeoutMs?: number }) {
  let dispatchTimer: NodeJS.Timeout | undefined;
  let projectTimer: NodeJS.Timeout | undefined;
  let started = false;
  let dispatching: Promise<unknown> | undefined;
  let projecting: Promise<unknown> | undefined;
  const dispatch = () => {
    if (dispatching) return dispatching;
    dispatching = dependencies.dispatcher.runOnce().catch((error) => dependencies.logger.error({ err: error }, "Notification dispatch failed")).finally(() => { dispatching = undefined; });
    return dispatching;
  };
  const project = () => {
    if (projecting) return projecting;
    projecting = dependencies.projector.runOnce().catch((error) => dependencies.logger.error({ err: error }, "Notification condition projection failed")).finally(() => { projecting = undefined; });
    return projecting;
  };
  return {
    start() {
      if (started) return;
      started = true;
      void dispatch(); void project();
      dispatchTimer = setInterval(() => void dispatch(), dependencies.dispatchIntervalMs ?? 5_000);
      projectTimer = setInterval(() => void project(), dependencies.projectIntervalMs ?? 60_000);
      dispatchTimer.unref(); projectTimer.unref();
    },
    async stop() {
      if (dispatchTimer) clearInterval(dispatchTimer);
      if (projectTimer) clearInterval(projectTimer);
      dispatchTimer = undefined; projectTimer = undefined; started = false;
      const active = [dispatching, projecting].filter((cycle): cycle is Promise<unknown> => Boolean(cycle));
      if (!active.length) return;
      let timeout: NodeJS.Timeout | undefined;
      const completed = await Promise.race([
        Promise.allSettled(active).then(() => true),
        new Promise<false>((resolve) => { timeout = setTimeout(() => resolve(false), dependencies.shutdownTimeoutMs ?? 10_000); timeout.unref(); }),
      ]);
      if (timeout) clearTimeout(timeout);
      if (!completed) dependencies.logger.warn({ activeCycles: active.length }, "Notification runtime shutdown timeout reached");
    },
    runDispatcherOnce: dispatch,
    runProjectorOnce: project,
  };
}
