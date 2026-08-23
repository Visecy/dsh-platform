// packages/platform-domain/src/index.ts
import { DomainFacility, defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import { storageBackendServiceKey } from "@deepseek-ai/dsh-storage";
import { z } from "zod";
var workspacesDomain = defineDomain({
  name: "platform_workspaces",
  version: 1,
  tables: {
    workspaces: domainTable(z.object({
      workspaceId: z.string().min(1),
      name: z.string().default(""),
      owner: z.string().optional(),
      phase: z.enum(["provision", "running", "sleep", "deleted"]),
      pod: z.string().optional(),
      pvc: z.string().optional(),
      lastSleepAt: z.number().optional()
    }))
  }
});
var usersDomain = defineDomain({
  name: "platform_users",
  version: 1,
  tables: {
    users: domainTable(z.object({
      sub: z.string().min(1),
      email: z.string().optional(),
      name: z.string().optional(),
      groups: z.array(z.string()).optional(),
      roles: z.array(z.string())
    }))
  }
});
var settingsDomain = defineDomain({
  name: "platform_settings",
  version: 1,
  tables: {
    settings: domainTable(z.object({
      userId: z.string().min(1),
      namespace: z.string().min(1),
      section: z.record(z.unknown()),
      revision: z.number().int().nonnegative()
    }))
  }
});
var credentialsDomain = defineDomain({
  name: "platform_credentials",
  version: 1,
  tables: {
    credentials: domainTable(z.object({
      userId: z.string().min(1),
      scope: z.string().min(1),
      id: z.string().min(1),
      kind: z.enum(["api-key", "grant"]),
      payload: z.record(z.unknown())
    }))
  }
});
async function apply(ctx, config = {}) {
  const backendName = config.backend ?? "sqlite";
  await ctx.inject([storageBackendServiceKey(backendName)], async () => {
    const facility = new DomainFacility(ctx, { backend: backendName });
    const workspaces = await facility.open(workspacesDomain);
    const users = await facility.open(usersDomain);
    const settings = await facility.open(settingsDomain);
    const credentials = await facility.open(credentialsDomain);
    const domains = { workspaces, users, settings, credentials };
    ctx.provide("platformDomains", domains);
    ctx.effect(async () => {
      await Promise.all([workspaces.close(), users.close(), settings.close(), credentials.close()]);
    }, "@visecy/dsh-platform-domain");
  });
}
export {
  apply,
  credentialsDomain,
  settingsDomain,
  usersDomain,
  workspacesDomain
};
