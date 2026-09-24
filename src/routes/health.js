export default async function healthRoutes(app) {
  app.get("/healthz", async () => ({
    ok: true,
    version: app.config.version,
  }));
}
