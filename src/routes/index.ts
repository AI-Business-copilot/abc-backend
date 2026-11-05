import { Router } from "express";

import authRoutes from "../modules/auth/auth.routes";
import businessRoutes from "../modules/businesses/business.routes";
import categoriesRoutes from "../modules/categories/categories.routes";
import customerReturnsRoutes from "../modules/customer-returns/customer-returns.routes";
import inventoryRoutes from "../modules/inventory/inventory.routes";
import productsRoutes from "../modules/products/routes/products.routes";
import purchasesRoutes from "../modules/purchases/purchases.routes";
import vendorReturnsRoutes from "../modules/vendor-returns/vendor-returns.routes";
import uploadRouter from "./upload.routes";

const router = Router();

router.use("/auth", authRoutes);
router.use("/businesses", businessRoutes);
router.use("/categories", categoriesRoutes);
router.use("/customer-returns", customerReturnsRoutes);
router.use("/inventory", inventoryRoutes);
router.use("/products", productsRoutes);
router.use("/purchases", purchasesRoutes);
router.use("/vendor-returns", vendorReturnsRoutes);
router.use("/upload", uploadRouter);

router.get("/health", (req, res) => {
  res.json({
    status: "OK",
  });
});

export default router;
