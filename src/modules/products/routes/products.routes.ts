// src/modules/products/routes/products.routes.ts
import { Router } from 'express';
import { ProductTemplatesController } from '../controllers/product-templates.controller';
import { AttributesController } from '../controllers/attributes.controller';
import { ProductVariantsController } from '../controllers/product-variants.controller';
import { ProductListController } from '../controllers/product-list.controller';

const router = Router();
const templatesCtrl = new ProductTemplatesController();
const attrsCtrl = new AttributesController();
const variantsCtrl = new ProductVariantsController();
const listCtrl = new ProductListController();

router.get('/list', listCtrl.list.bind(listCtrl));
router.post('/templates', templatesCtrl.create.bind(templatesCtrl));
router.get('/templates', templatesCtrl.list.bind(templatesCtrl));
router.get('/templates/:id', templatesCtrl.getById.bind(templatesCtrl));
router.post('/attributes', attrsCtrl.create.bind(attrsCtrl));
router.post('/attributes/values', attrsCtrl.addValue.bind(attrsCtrl));
router.get('/attributes', attrsCtrl.list.bind(attrsCtrl));
router.post('/templates/:templateId/variants/generate', variantsCtrl.generate.bind(variantsCtrl));

export default router;

