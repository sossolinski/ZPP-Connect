import { createServer, type Server } from "node:http";
import type { Express } from "express";
import { afterAll } from "vitest";
import { createApp as createExpressApp } from "../app.js";

type ListeningTestApp = Server & { locals: Express["locals"] };

const servers = new Set<ListeningTestApp>();
let sharedServer: ListeningTestApp | undefined;

export function createApp(...args: Parameters<typeof createExpressApp>): ListeningTestApp {
  const app = createExpressApp(...args);
  const server = createServer(app) as ListeningTestApp;
  server.locals = app.locals;
  server.listen(0);
  server.unref();
  servers.add(server);
  return server;
}

export function createSharedApp(...args: Parameters<typeof createExpressApp>): ListeningTestApp {
  sharedServer ??= createApp(...args);
  return sharedServer;
}

afterAll(async () => {
  const activeServers = [...servers];
  await Promise.all(activeServers.map((server) => new Promise<void>((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => {
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(error);
      else resolve();
    });
  })));
  servers.clear();
  sharedServer = undefined;
});
