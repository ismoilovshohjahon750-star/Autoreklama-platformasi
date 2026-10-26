import { Router, type IRouter } from "express";
import healthRouter from "./health";
import sdkRouter from "./sdk";
import autoreklamaRouter from "./autoreklama";
import { requireAuth } from "../middlewares/auth";

const router: IRouter = Router();

router.use(healthRouter);
router.use(sdkRouter);
router.use(requireAuth);
router.use(autoreklamaRouter);

export default router;
