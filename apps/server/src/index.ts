import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "./app.ts";
import { readConfig } from "./config.ts";
import { createStore } from "./db.ts";

const config = readConfig();
const db = await createStore({
  dataDir: `${config.dataDir}/postgres`,
  databaseUrl: config.databaseUrl,
});
await db.recoverInterruptedActions();
const { app, agent, engagement, business } = await createApp(db, config);
if (config.taskWorkerEnabled) {
  agent.start();
  business.start(agent);
}
// One API process owns the live voice connections and APNs outbox.
engagement.start();
const webRoot = resolve(process.env.WEB_DIST_DIR ?? "apps/mobile/dist/web");
if (existsSync(`${webRoot}/index.html`)) {
  app.use("/*", serveStatic({ root: webRoot }));
  app.get("*", async (c) =>
    c.req.path.startsWith("/api/")
      ? c.json({ error: "Not found" }, 404)
      : c.html(await readFile(`${webRoot}/index.html`, "utf8")),
  );
} else {
  app.get("/", (c) =>
    c.json({ name: "OpenMuse", app: "http://localhost:8081", health: "/api/health" }),
  );
}
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, () =>
  console.log(`OpenMuse ${config.mode} API ready at ${config.publicUrl}`),
);
let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  await Promise.all([engagement.stop(), business.stop()]);
  await agent.stop();
  server.close(async () => {
    await db.close();
    process.exit(0);
  });
};
process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});
