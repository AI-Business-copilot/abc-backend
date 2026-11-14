import { Router } from "express";

import authRoutes from "../modules/auth/auth.routes";
import adminRoutes from "../modules/admin/admin.routes";
import businessRoutes from "../modules/businesses/business.routes";
import categoriesRoutes from "../modules/categories/categories.routes";
import cashShiftsRoutes from "../modules/cash-shifts/cash-shifts.routes";
import customerReturnsRoutes from "../modules/customer-returns/customer-returns.routes";
import businessDataRoutes from "../modules/business-data/business-data.routes";
import aiInsightRoutes from "../modules/ai-insights/ai-insights.routes";
import shopeeReportRoutes from "../modules/online-reports/shopee/shopee.routes";
import inventoryRoutes from "../modules/inventory/inventory.routes";
import productsRoutes from "../modules/products/routes/products.routes";
import purchasesRoutes from "../modules/purchases/purchases.routes";
import promotionsRoutes from "../modules/promotions/promotions.routes";
import salesRoutes from "../modules/sales/sales.routes";
import vendorReturnsRoutes from "../modules/vendor-returns/vendor-returns.routes";
import uploadRouter from "./upload.routes";

const router = Router();

router.use("/auth", authRoutes);
router.use("/admin", adminRoutes);
router.use("/businesses", businessRoutes);
router.use("/business-data", businessDataRoutes);
router.use("/ai-insights", aiInsightRoutes);
// Optional supplementary feature; remove this line (and src/modules/online-reports) to disable it.
router.use("/online-reports/shopee", shopeeReportRoutes);
router.use("/categories", categoriesRoutes);
router.use("/cash-shifts", cashShiftsRoutes);
router.use("/customer-returns", customerReturnsRoutes);
router.use("/inventory", inventoryRoutes);
router.use("/products", productsRoutes);
router.use("/purchases", purchasesRoutes);
router.use("/promotions", promotionsRoutes);
router.use("/sales", salesRoutes);
router.use("/vendor-returns", vendorReturnsRoutes);
router.use("/upload", uploadRouter);

router.get("/health", (req, res) => {
  res.json({
    status: "OK",
  });
});

export default router;
