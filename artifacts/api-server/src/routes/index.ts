import { Router, type IRouter } from "express";
import healthRouter from "./health";
import chatRouter from "./chat";
import imageChatRouter from "./image-chat";
import agentRouter from "./agent";

const router: IRouter = Router();

router.use(healthRouter);
router.use(chatRouter);
router.use(imageChatRouter);
router.use(agentRouter);

export default router;
