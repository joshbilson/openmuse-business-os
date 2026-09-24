import { Hono } from "hono";
import { z } from "zod";
import type { EngagementService } from "./service.ts";

export function engagementRoutes(service: EngagementService) {
  const app = new Hono<{ Variables: { owner: string } }>();
  app.post("/devices", async (c) =>
    c.json(
      await service.register(
        c.get("owner"),
        z
          .object({
            deviceId: z.string().min(8).max(160),
            platform: z.literal("ios"),
            token: z.string().regex(/^[a-fA-F0-9]{32,512}$/),
            kind: z.enum(["alert", "voip"]),
            environment: z.enum(["sandbox", "production"]),
          })
          .parse(await c.req.json()),
      ),
      201,
    ),
  );
  app.delete("/devices/:deviceId", async (c) => {
    await service.unregister(c.get("owner"), c.req.param("deviceId"));
    return c.json({ ok: true });
  });
  app.get("/notifications/preferences", async (c) =>
    c.json(await service.preferences(c.get("owner"))),
  );
  app.patch("/notifications/preferences", async (c) =>
    c.json(
      await service.preferences(
        c.get("owner"),
        z
          .object({
            pushEnabled: z.boolean().optional(),
            callsEnabled: z.boolean().optional(),
            callPolicy: z.literal("time_sensitive").optional(),
          })
          .parse(await c.req.json()),
      ),
    ),
  );
  app.get("/voice/status", (c) => c.json(service.status()));
  app.post("/voice/sessions", async (c) =>
    c.json(
      await service.createSession(
        c.get("owner"),
        z
          .object({
            sdp: z.string().min(10).max(100_000),
            threadId: z.string().min(1).max(160).optional(),
            callId: z.uuid().optional(),
          })
          .parse(await c.req.json()),
      ),
      201,
    ),
  );
  app.delete("/voice/sessions/:id", async (c) => {
    await service.endSession(c.get("owner"), c.req.param("id"));
    return c.json({ ok: true });
  });
  app.post("/voice/calls", async (c) =>
    c.json(
      await service.invite(
        c.get("owner"),
        z
          .object({
            reason: z.string().trim().min(1).max(2000),
            threadId: z.string().min(1).max(160).optional(),
            eventId: z.string().max(200).optional(),
          })
          .parse(await c.req.json()),
      ),
      201,
    ),
  );
  app.get("/voice/calls/:id", async (c) =>
    c.json(await service.getCall(c.get("owner"), c.req.param("id"))),
  );
  app.post("/voice/calls/:id/answer", async (c) =>
    c.json(await service.answer(c.get("owner"), c.req.param("id"), true)),
  );
  app.post("/voice/calls/:id/decline", async (c) =>
    c.json(await service.answer(c.get("owner"), c.req.param("id"), false)),
  );
  app.post("/voice/calls/:id/end", async (c) =>
    c.json(await service.endCall(c.get("owner"), c.req.param("id"))),
  );
  return app;
}
