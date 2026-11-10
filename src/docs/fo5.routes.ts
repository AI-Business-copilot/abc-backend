import { Router } from "express";
import swaggerUi from "swagger-ui-express";
import helmet from "helmet";
import { createFo5Document } from "./fo5.openapi";

const router = Router();

// Allow the browser to sign in directly with Supabase, as the frontend does.
router.use((_req, res, next) => {
  const connectSrc = ["'self'"];
  if (process.env.SUPABASE_URL) connectSrc.push(new URL(process.env.SUPABASE_URL).origin);
  helmet.contentSecurityPolicy({ directives: { connectSrc, upgradeInsecureRequests: null } })(_req, res, next);
});

router.get("/openapi.json", (_req, res) => {
  res.set("Cache-Control", "no-store").json(createFo5Document());
});

const options = {
  customSiteTitle: "ABC Retail - F05 & F06 Đổi trả hàng API Docs",
  customCss: ".swagger-ui .topbar { display: none; }",
  swaggerOptions: {
    url: "/fo5/openapi.json",
    validatorUrl: null,
    persistAuthorization: false,
    displayRequestDuration: true,
    docExpansion: "list",
    // swagger-ui-express serializes this function into its initializer script.
    responseInterceptor: function (response: { url: string; status: number; obj?: { access_token?: string } }) {
      if (response.status === 200 && new URL(response.url).pathname === "/auth/v1/token" && response.obj?.access_token) {
        (window as unknown as { ui: { preauthorizeApiKey(name: string, token: string): void } }).ui.preauthorizeApiKey(
          "bearerAuth",
          response.obj.access_token
        );
      }
      return response;
    },
  },
};

router.use(swaggerUi.serveFiles(undefined, options));
router.get("/", swaggerUi.setup(undefined, options));

export default router;

