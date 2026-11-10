import app from "./app";
import { logger } from "./lib/logger";

// Vercel invokes the default-exported Express app as a serverless handler.
// Replit runs the same file as a standalone server and supplies PORT.
export default app;

const rawPort = process.env["PORT"];

if (!rawPort && process.env["VERCEL"] !== "1") {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

if (rawPort) {
  const port = Number(rawPort);

  if (Number.isNaN(port) || port <= 0) {
    throw new Error(`Invalid PORT value: "${rawPort}"`);
  }

  app.listen(port, (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }

    logger.info({ port }, "Server listening");
  });
}
