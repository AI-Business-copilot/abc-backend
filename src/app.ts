import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import swaggerUi from "swagger-ui-express";
import YAML from "yamljs";
import path from "path";

import routes from "./routes";
import fo3Routes from "./docs/fo3.routes";
import fo4Routes from "./docs/fo4.routes";
import { errorHandler } from "./shared/http/error-handler";

const app = express();

app.use(helmet());
app.use(cors());
app.use(morgan("dev"));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Swagger UI documentation for F07 & F08
const swaggerDocument = YAML.load(path.join(__dirname, "swagger", "f07-f08-openapi.yaml"));
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerDocument, {
  customSiteTitle: "ABC Retail - F07 & F08 API Docs",
  customCss: ".swagger-ui .topbar { display: none }",
}));

app.use("/fo3", fo3Routes);
app.use("/fo4", fo4Routes);
app.use("/api", routes);

app.get("/", (req, res) => {
  res.json({
    message: "Welcome to Business AI Copilot API",
  });
});

app.use(errorHandler);

export default app;
