import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";

import routes from "./routes";
import fo3Routes from "./docs/fo3.routes";
import fo4Routes from "./docs/fo4.routes";
import { errorHandler } from "./shared/http/error-handler";

const app = express();

app.use(cors());
app.use(helmet());
app.use(morgan("dev"));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/fo3", fo3Routes);
app.use("/fo4", fo4Routes);
app.use("/api", routes);

app.get("/", (req, res) => {
  res.json({
    message: "Business AI Copilot API",
  });
});

app.use(errorHandler);

export default app;
