import { Router } from "express";
import otherRoutes from "./otherRoutes/index.js";

const router = Router();
router.use("/", otherRoutes);

export default router;

