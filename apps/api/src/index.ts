import { createApp } from "./app.js";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { prisma } from "./prisma.js";

const app = createApp();

const server = app.listen(config.port, () => {
  logger.info({ port: config.port, authMode: config.authMode }, "ZPP Connect API started");
});

async function shutdown(signal: string) {
  logger.info({ signal }, "Shutting down API");
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

export { app };
