import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import swaggerUi from "swagger-ui-express";
import YAML from "yamljs";
import path from "path";
import fs from "fs";

import routes from "./routes";
import fo3Routes from "./docs/fo3.routes";
import fo4Routes from "./docs/fo4.routes";
import fo5Routes from "./docs/fo5.routes";
import { errorHandler } from "./shared/http/error-handler";

const app = express();

app.use(helmet());
app.use(cors());
app.use(morgan("dev"));

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));

// Swagger UI documentation for F01 & F02, F07 & F08 (with F05 & F06 schemas)
function findSwaggerFile(fileName: string): string | undefined {
  const candidates = [
    path.join(__dirname, "swagger", fileName),
    path.join(__dirname, "../src/swagger", fileName),
    path.join(process.cwd(), "src", "swagger", fileName),
  ];
  return candidates.find((p) => fs.existsSync(p));
}

const f01f02Path = findSwaggerFile("f01-f02-openapi.yaml");
const f07f08Path = findSwaggerFile("f07-f08-openapi.yaml");

let f01f02Doc: any = null;
let f07f08Doc: any = null;

if (f01f02Path) {
  try {
    f01f02Doc = YAML.load(f01f02Path);
  } catch (err) {
    console.warn("Failed to load f01-f02 swagger:", err);
  }
}

if (f07f08Path) {
  try {
    f07f08Doc = YAML.load(f07f08Path);
  } catch (err) {
    console.warn("Failed to load f07-f08 swagger:", err);
  }
}

// Serve raw spec JSONs for Swagger dropdown
app.get("/api-docs/specs/f01-f02.json", (_req, res) => {
  if (f01f02Doc) return res.json(f01f02Doc);
  res.status(404).json({ error: "Spec not found" });
});

app.get("/api-docs/specs/f07-f08.json", (_req, res) => {
  if (f07f08Doc) return res.json(f07f08Doc);
  res.status(404).json({ error: "Spec not found" });
});

// Dedicated route for F01 & F02
if (f01f02Doc) {
  app.use("/api-docs/f01-f02", swaggerUi.serve, swaggerUi.setup(f01f02Doc, {
    customSiteTitle: "ABC Retail - F01 & F02 API Docs (Sản phẩm & Kho tồn FEFO)",
    customCss: ".swagger-ui .topbar { display: none }",
  }));
}

// Main Swagger UI at /api-docs with multi-spec selector dropdown
const specUrls: Array<{ url: string; name: string }> = [];
if (f01f02Doc) {
  specUrls.push({ url: "/api-docs/specs/f01-f02.json", name: "F01 & F02: Quản trị Danh mục Sản phẩm & Kho tồn FEFO" });
}
if (f07f08Doc) {
  specUrls.push({ url: "/api-docs/specs/f07-f08.json", name: "F05 - F08: Đổi trả, Kiểm kê & Quản lý Lô/Hủy hàng" });
}

if (specUrls.length > 0) {
  app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(undefined, {
    swaggerOptions: {
      urls: specUrls,
      "urls.primaryName": specUrls[0].name,
    },
    customSiteTitle: "ABC Retail - API Documentation",
  }));
}

app.use("/fo3", fo3Routes);
app.use("/fo4", fo4Routes);
app.use("/fo5", fo5Routes);
app.use("/fo6", fo5Routes);
app.use("/fo5-fo6", fo5Routes);
app.use("/api", routes);

app.get("/", (req, res) => {
  res.json({
    message: "ABC Retail Backend API",
    version: "1.0.0",
    docs: "/api-docs",
  });
});

app.use(errorHandler);

export default app;
