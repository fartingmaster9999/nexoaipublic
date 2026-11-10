import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

app.use((error: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = (error as { status?: number })?.status;
  const safeStatus = status === 413 ? 413 : status === 400 ? 400 : 500;
  req.log.error({ event: "http.request.failed", status: safeStatus }, "Request could not be processed");
  if (res.headersSent) { res.destroy(); return; }
  res.status(safeStatus).json({ error: safeStatus === 413 ? "This request is too large." : safeStatus === 400 ? "Please send a valid JSON request." : "The request could not be completed. Please try again." });
});

export default app;
