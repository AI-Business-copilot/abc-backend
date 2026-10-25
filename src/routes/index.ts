import { Router } from "express";

import authRoutes from "../modules/auth/auth.routes";
import businessRoutes from "../modules/businesses/business.routes";

const router = Router();

router.use("/auth", authRoutes);
router.use("/businesses", businessRoutes);

router.get("/health", (req, res) => {
  res.json({
    status: "OK",
  });
});

export default router;