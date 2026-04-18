import pino from "pino";
import { getConfig } from "./config.js";

let _logger: pino.Logger | null = null;

export function getLogger(name?: string): pino.Logger {
  if (!_logger) {
    const config = getConfig();
    const isDev = process.env["NODE_ENV"] !== "production";
    _logger = pino({
      level: config.LOG_LEVEL,
      ...(isDev
        ? {
            transport: {
              target: "pino-pretty",
              options: { colorize: true, translateTime: "SYS:HH:MM:ss" },
            },
          }
        : {}),
    });
  }
  return name ? _logger.child({ name }) : _logger;
}
