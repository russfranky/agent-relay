import { buildApp } from "./app.js";

export { buildApp };

const isMain = process.argv[1] && process.argv[1].endsWith("server.js");

if (isMain) {
  const app = await buildApp();
  try {
    await app.listen({ port: app.config.port, host: app.config.host });
    app.log.info({ port: app.config.port }, "agent-relay listening");
  } catch (err) {
    app.log.error({ err: err.message }, "failed to listen");
    process.exit(1);
  }
}
