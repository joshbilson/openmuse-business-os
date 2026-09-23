import { createHash } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { publishBusinessViewSchema } from "../../../../packages/domain/src/business-view.ts";
import { AppError } from "../errors.ts";
import type { BusinessService } from "./service.ts";
import { businessProviders } from "./types.ts";
import type { BusinessViews } from "./views.ts";

const providerSchema = z.enum(businessProviders);
const kindSchema = z.enum([
  "merchant",
  "location",
  "payment",
  "organisation",
  "account",
  "bank_transaction",
  "invoice",
  "contact",
  "transaction",
  "mail",
]);
const owner = (c: { get: (key: "owner") => string }) => c.get("owner");
function sessionBinding(authorization?: string): string {
  const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization ?? "")?.[1];
  if (!token) throw new AppError("Sign in again before connecting Revolut", 401);
  return createHash("sha256").update(token).digest("hex");
}

/** Mount behind the application's existing /api bearer-session middleware. */
export function businessRoutes(service: BusinessService, views?: BusinessViews) {
  const router = new Hono<{ Variables: { owner: string } }>();
  router.get("/connections", async (c) => c.json(await service.connections(owner(c))));
  router.get("/capabilities", async (c) => c.json(await service.capabilities(owner(c))));
  router.get("/connections/:provider/status", async (c) =>
    c.json(await service.status(owner(c), providerSchema.parse(c.req.param("provider")))),
  );
  router.post("/connections/:provider/verify", async (c) =>
    c.json(await service.verify(owner(c), providerSchema.parse(c.req.param("provider")))),
  );
  router.post("/connections/:provider/connect", async (c) =>
    c.json(
      await service.startOAuth(
        owner(c),
        providerSchema.parse(c.req.param("provider")),
        c.req.param("provider") === "revolut"
          ? sessionBinding(c.req.header("authorization"))
          : undefined,
      ),
    ),
  );
  router.get("/connections/revolut/pending", async (c) =>
    c.json(await service.pendingRevolut(owner(c), sessionBinding(c.req.header("authorization")))),
  );
  router.post("/connections/square/token", async (c) => {
    const { token } = z.object({ token: z.string().min(1).max(4096) }).parse(await c.req.json());
    return c.json(await service.connectSquareToken(owner(c), token));
  });
  router.post("/connections/xero/tenant", async (c) => {
    const { tenantId } = z.object({ tenantId: z.string().uuid() }).parse(await c.req.json());
    return c.json(await service.selectXeroTenant(owner(c), tenantId));
  });
  router.post("/connections/:provider/complete", async (c) => {
    const provider = providerSchema.parse(c.req.param("provider"));
    if (provider !== "revolut") throw new AppError("Use the provider callback", 422);
    const { state, code } = z
      .object({ state: z.string().min(20).max(256), code: z.string().min(1).max(4096) })
      .parse(await c.req.json());
    return c.json(
      await service.completeOAuth(
        owner(c),
        provider,
        state,
        code,
        sessionBinding(c.req.header("authorization")),
      ),
    );
  });
  router.post("/connections/:provider/disconnect", async (c) =>
    c.json(await service.disconnect(owner(c), providerSchema.parse(c.req.param("provider")))),
  );
  router.post("/sync", async (c) => {
    const body = z
      .object({
        provider: providerSchema,
        kind: kindSchema,
        cursor: z.string().max(2048).optional(),
      })
      .parse(await c.req.json());
    return c.json(await service.sync(owner(c), body.provider, body.kind, body.cursor));
  });
  router.get("/entities", async (c) => {
    const query = z
      .object({
        provider: providerSchema.optional(),
        kind: kindSchema.optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
        sort: z.enum(["newest", "oldest"]).optional(),
      })
      .parse(c.req.query());
    return c.json(await service.entities(owner(c), query));
  });
  router.get("/observation", async (c) => c.json(await service.observation(owner(c))));
  if (views) {
    router.get("/views", async (c) => c.json(await views.list(owner(c))));
    router.post("/views", async (c) =>
      c.json(
        await views.publish(owner(c), publishBusinessViewSchema.parse(await c.req.json())),
        201,
      ),
    );
  }
  return router;
}

/** Public OAuth callback. Mount before /api session middleware, like GoogleAuth's callback. */
export function businessCallbackRoutes(service: BusinessService) {
  const router = new Hono();
  router.get("/oauth/:provider/callback", async (c) => {
    if (c.req.query("error")) throw new AppError("Business authorization was declined", 400);
    const provider = providerSchema.parse(c.req.param("provider"));
    const state = c.req.query("state"),
      code = c.req.query("code");
    // Revolut completion always passes through the authenticated, session-bound
    // handoff. A provider-supplied state must not bypass that binding.
    if (provider === "revolut" && code)
      return new Response(
        '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Finish Revolut connection</title></head><body><h1>Finish connecting Revolut</h1><p>Copy this page\'s address and paste it into your pending Revolut connection in OpenMuse within two minutes of approval.</p><p>The address contains a temporary authorization code. Keep it private.</p></body></html>',
        {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
            "Content-Security-Policy": "default-src 'none'",
          },
        },
      );
    if (!state || !code) throw new AppError("Business authorization callback is incomplete", 400);
    await service.oauthCallback(provider, state, code);
    return c.html(
      "<h1>Business account connected</h1><p>Return to Wine & Larder OS to review the connection status.</p>",
    );
  });
  return router;
}
