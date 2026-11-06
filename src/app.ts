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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Swagger UI documentation for F07 & F08 (with F05 & F06 schemas)
const swaggerPathCandidates = [
  path.join(__dirname, "swagger", "f07-f08-openapi.yaml"),
  path.join(__dirname, "../src/swagger", "f07-f08-openapi.yaml"),
  path.join(process.cwd(), "src", "swagger", "f07-f08-openapi.yaml"),
];
const resolvedSwaggerPath = swaggerPathCandidates.find((p) => fs.existsSync(p));
if (resolvedSwaggerPath) {
  try {
    const swaggerDocument = YAML.load(resolvedSwaggerPath);
    app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerDocument, {
      customSiteTitle: "ABC Retail - F07 & F08 API Docs",
      customCss: ".swagger-ui .topbar { display: none }",
    }));
  } catch (err) {
    console.warn("Failed to load swagger documentation:", err);
  }
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
