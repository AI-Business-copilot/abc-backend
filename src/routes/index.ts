import { Router } from "express";

import authRoutes from "../modules/auth/auth.routes";
import businessRoutes from "../modules/businesses/business.routes";
import categoriesRoutes from "../modules/categories/categories.routes";
<<<<<<< HEAD
import cashShiftsRoutes from "../modules/cash-shifts/cash-shifts.routes";
=======
import customerReturnsRoutes from "../modules/customer-returns/customer-returns.routes";
>>>>>>> origin/dev
import inventoryRoutes from "../modules/inventory/inventory.routes";
import productsRoutes from "../modules/products/routes/products.routes";
import purchasesRoutes from "../modules/purchases/purchases.routes";
import salesRoutes from "../modules/sales/sales.routes";
import vendorReturnsRoutes from "../modules/vendor-returns/vendor-returns.routes";

const router = Router();

router.use("/auth", authRoutes);
router.use("/businesses", businessRoutes);
router.use("/categories", categoriesRoutes);
<<<<<<< HEAD
router.use("/cash-shifts", cashShiftsRoutes);
=======
router.use("/customer-returns", customerReturnsRoutes);
>>>>>>> origin/dev
router.use("/inventory", inventoryRoutes);
router.use("/products", productsRoutes);
router.use("/purchases", purchasesRoutes);
router.use("/sales", salesRoutes);
router.use("/vendor-returns", vendorReturnsRoutes);

router.get("/health", (req, res) => {
  res.json({
    status: "OK",
  });
});

export default router;
