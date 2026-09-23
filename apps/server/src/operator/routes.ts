import { createHash } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import {
  type AgentMemory,
  type AgentNotification,
  createTaskSchema,
} from "../../../../packages/domain/src/agent.ts";
import { proposalSchema } from "../../../../packages/domain/src/index.ts";
import type { ActionService } from "../actions.ts";
import type { Store } from "../db.ts";
import type { EngagementService } from "../engagement/service.ts";
import type { AgentService } from "../engine/service.ts";

const idempotencyKey = z.string().trim().min(8).max(200);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const notificationInput = z.strictObject({
  eventId: idempotencyKey,
  title: z.string().trim().min(1).max(160),
  body: z.string().trim().min(1).max(2000),
  priority: z.enum(["ordinary", "time_sensitive"]).default("ordinary"),
  requiresConversation: z.boolean().default(false),
  taskId: z.string().max(160).optional(),
});

/** Operator tools use the same owner session and durable records as the app. */
export function operatorRoutes(
  db: Store,
  agent: AgentService,
  actions: ActionService,
  engagement: EngagementService,
) {
  const app = new Hono<{ Variables: { owner: string } }>();
  app.get("/status", async (c) => c.json(await agent.snapshot(c.get("owner"))));
  app.get("/tasks/:id", async (c) => c.json(await agent.detail(c.get("owner"), c.req.param("id"))));
  app.post("/tasks", async (c) => {
    const body = z
      .strictObject({ idempotencyKey, task: createTaskSchema })
      .parse(await c.req.json());
    return c.json(
      await agent.createTask(c.get("owner"), body.task, `operator:${body.idempotencyKey}`),
      201,
    );
  });
  app.post("/memories", async (c) => {
    const body = z
      .strictObject({
        idempotencyKey,
        text: z.string().trim().min(1).max(4000),
        source: z.string().trim().min(1).max(200).optional(),
      })
      .parse(await c.req.json());
    const memory: AgentMemory = {
      id: hash(`operator-memory:${body.idempotencyKey}`),
      text: body.text,
      source: body.source ?? "Operator",
      createdAt: new Date().toISOString(),
    };
    return c.json(
      (await db.insertIfAbsent(c.get("owner"), "memories", memory)) ??
        (await db.get(c.get("owner"), "memories", memory.id)),
      201,
    );
  });
  app.post("/notifications", async (c) => {
    const body = notificationInput.parse(await c.req.json());
    const notification: AgentNotification & {
      priority: "ordinary" | "time_sensitive";
      requiresConversation: boolean;
    } = {
      id: hash(`operator-notification:${body.eventId}`),
      title: body.title,
      body: body.body,
      taskId: body.taskId,
      priority: body.priority,
      requiresConversation: body.requiresConversation,
      read: false,
      createdAt: new Date().toISOString(),
    };
    const saved =
      (await db.insertIfAbsent(c.get("owner"), "notifications", notification)) ??
      (await db.get(c.get("owner"), "notifications", notification.id));
    return c.json(saved, 201);
  });
  app.post("/calls", async (c) => {
    const body = z
      .strictObject({
        eventId: idempotencyKey,
        reason: z.string().trim().min(1).max(2000),
        threadId: z.string().min(1).max(160).optional(),
      })
      .parse(await c.req.json());
    return c.json(await engagement.invite(c.get("owner"), body), 201);
  });
  app.post("/actions", async (c) => {
    const body = z
      .strictObject({ idempotencyKey, action: proposalSchema })
      .parse(await c.req.json());
    return c.json(
      await actions.propose(c.get("owner"), body.action, `operator:${body.idempotencyKey}`),
      201,
    );
  });
  return app;
}
