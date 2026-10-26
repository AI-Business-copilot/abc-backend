import { Router } from "express";

import authRoutes from "../modules/auth/auth.routes";
import businessRoutes from "../modules/businesses/business.routes";
import categoriesRoutes from "../modules/categories/categories.routes";
import productsRoutes from "../modules/products/routes/products.routes";

const router = Router();

router.use("/auth", authRoutes);
router.use("/businesses", businessRoutes);
router.use("/categories", categoriesRoutes);
router.use("/products", productsRoutes);

router.get("/health", (req, res) => {
  res.json({
    status: "OK",
  });
});

export default router;
