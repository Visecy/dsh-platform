// src/index.ts
import { DomainFacility, defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import { storageBackendServiceKey } from "@deepseek-ai/dsh-storage";
import { z } from "zod";

// src/credentials.ts
import { Service } from "@deepseek-ai/cordis";
var PLATFORM_CREDENTIAL_OWNER = "platform";
var REFERENCE_SCOPE = "ref";
var REFERENCE_PREFIX = "ref:";
var SOURCE = "postgres";
var REFERENCE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
var KEY_SEGMENT = /^[a-z0-9][a-z0-9-]*$/;
function assertJsonValue(where, value, seen) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new TypeError(`credentials: ${where} holds a non-finite number`);
  }
  if (typeof value === "object") {
    if (seen.has(value)) throw new TypeError(`credentials: ${where} is cyclic`);
    if (Object.getPrototypeOf(value) === Object.prototype || Array.isArray(value)) {
      seen.add(value);
      for (const nested of Object.values(value)) assertJsonValue(where, nested, seen);
      seen.delete(value);
      return;
    }
  }
  throw new TypeError(`credentials: ${where} holds a value JSON cannot represent`);
}
function assertReferenceName(name) {
  if (!REFERENCE_NAME.test(name)) throw new TypeError(`credentials: '${name}' is not a valid credential reference`);
}
function splitKey(key) {
  const parts = key.split("/");
  if (parts.length !== 2 || !KEY_SEGMENT.test(parts[0]) || !KEY_SEGMENT.test(parts[1])) {
    throw new TypeError(`credentials: '${key}' is not a '<scope>/<id>' credential key`);
  }
  return { scope: parts[0], id: parts[1] };
}
function referenceOf(key) {
  return key.startsWith(REFERENCE_PREFIX) ? key.slice(REFERENCE_PREFIX.length) : void 0;
}
var CredentialStore = class extends Service {
  constructor(ctx, domains) {
    super(ctx, "credentials");
    this.domains = domains;
  }
  domains;
  /** Tail of the write queue; see the class doc. */
  tail = Promise.resolve();
  /** Set at disposal: refuse new writes instead of writing into a closed domain. */
  closed = false;
  table() {
    return this.domains.credentials.table("credentials");
  }
  /** Queue one exclusive write behind every earlier one. */
  enqueue(operation) {
    const task = this.tail.then(operation);
    this.tail = task.then(() => void 0, () => void 0);
    return task;
  }
  assertWritable(what) {
    if (this.closed) throw new Error(`credentials: the platform credential store is disposed; cannot write ${what}`);
  }
  /** The launcher's environment snapshot, when this composition has one. */
  environment() {
    return this.ctx.get("launchEnvironment", false);
  }
  /**
   * The inherited-environment value for a reference: the most trusted layer and
   * the only one that can shadow a write.
   */
  inherited(ref) {
    const entry = this.environment()?.getFrom(ref, ["process"]);
    if (entry !== void 0 && entry.value.length > 0) return { value: entry.value, source: "env" };
    const ambient = process.env[ref];
    return ambient !== void 0 && ambient.length > 0 ? { value: ambient, source: "env" } : void 0;
  }
  /** The `.env` layers, read from the launcher's snapshot only (never from disk here). */
  dotenv(ref) {
    const entry = this.environment()?.getFrom(ref, ["project-env", "user-env"]);
    return entry !== void 0 && entry.value.length > 0 ? { value: entry.value, source: entry.source } : void 0;
  }
  /** The stored value of one reference, or undefined while absent. */
  stored(ref) {
    const row = this.table().get(REFERENCE_PREFIX + ref);
    const value = row?.payload.value;
    return typeof value === "string" && value.length > 0 ? value : void 0;
  }
  /** Resolve one reference: environment, then the store, then `.env`. */
  async resolve(ref) {
    return this.inherited(ref) ?? (this.stored(ref) !== void 0 ? { value: this.stored(ref), source: SOURCE } : void 0) ?? this.dotenv(ref);
  }
  /** Describe one reference without exposing its value. */
  async describe(ref) {
    if (this.inherited(ref) !== void 0) return { configured: true, source: "env", writable: false };
    if (this.stored(ref) !== void 0) return { configured: true, source: SOURCE, writable: true };
    const fallback = this.dotenv(ref);
    if (fallback !== void 0) return { configured: true, source: fallback.source, writable: true };
    return { configured: false, writable: true };
  }
  /** Store one reference value durably. */
  async set(ref, value) {
    assertReferenceName(ref);
    if (value.length === 0) throw new Error(`credentials: an empty value cannot be stored for "${ref}"; use unset`);
    this.assertWritable(`"${ref}"`);
    if (this.inherited(ref) !== void 0) {
      throw new Error(`credentials: "${ref}" is supplied read-only by the launching environment, so a write would be shadowed; unset it in the environment this process was started with instead`);
    }
    await this.enqueue(async () => {
      await this.table().put(REFERENCE_PREFIX + ref, {
        userId: PLATFORM_CREDENTIAL_OWNER,
        scope: REFERENCE_SCOPE,
        id: ref,
        kind: "api-key",
        payload: { value }
      });
      this.notifyUpdated(ref);
    });
  }
  /** Remove one reference from the store; removing an absent one writes nothing. */
  async unset(ref) {
    assertReferenceName(ref);
    this.assertWritable(`"${ref}"`);
    if (this.inherited(ref) !== void 0) {
      throw new Error(`credentials: "${ref}" is supplied read-only by the launching environment, so removing the stored value would be shadowed; unset it in the environment this process was started with instead`);
    }
    await this.enqueue(async () => {
      if (this.table().get(REFERENCE_PREFIX + ref) === void 0) return;
      await this.table().delete(REFERENCE_PREFIX + ref);
      this.notifyUpdated(ref);
    });
  }
  /** Read one stored record. */
  async readRecord(key) {
    const row = this.recordRow(key);
    if (row === void 0) return void 0;
    return row.payload.record;
  }
  /** Describe one record without exposing its value. */
  async describeRecord(key) {
    const row = this.recordRow(key);
    if (row === void 0) return { configured: false, writable: true };
    return { configured: true, kind: row.kind, writable: true };
  }
  /** Every stored record's address and tag. */
  async listRecords() {
    const entries = [];
    for (const [key, row] of this.table().entries()) {
      if (referenceOf(key) !== void 0) continue;
      entries.push({ key, kind: row.kind });
    }
    return entries;
  }
  /**
   * Serialized read-decide-write over one record: `mutate` sees the record as it
   * stands at the moment the write is exclusive, and returning `undefined`
   * leaves the row untouched.
   */
  async modifyRecord(key, mutate) {
    splitKey(key);
    this.assertWritable(`record "${key}"`);
    return this.enqueue(async () => {
      const current = this.recordRow(key)?.payload.record;
      const next = await mutate(current);
      if (next === void 0) return current;
      this.assertStorable(key, next);
      await this.table().put(key, {
        userId: PLATFORM_CREDENTIAL_OWNER,
        scope: splitKey(key).scope,
        id: splitKey(key).id,
        kind: next.kind,
        payload: { record: next }
      });
      this.notifyRecordUpdated(key);
      return next;
    });
  }
  /** Remove one record; removing an absent one is a no-op. */
  async deleteRecord(key) {
    splitKey(key);
    this.assertWritable(`record "${key}"`);
    await this.enqueue(async () => {
      const removed = await this.table().delete(key);
      if (removed) this.notifyRecordUpdated(key);
    });
  }
  /** The stored row of one record, or undefined. */
  recordRow(key) {
    splitKey(key);
    return this.table().get(key);
  }
  /**
   * Refuse a record the read path could not admit, before it is written: an
   * empty key, an env name outside the reference grammar, an empty env value,
   * or a payload that cannot survive the round trip.
   */
  assertStorable(key, record) {
    if (record.kind === "grant") {
      assertJsonValue(`record "${key}" payload`, record.payload, /* @__PURE__ */ new Set());
      return;
    }
    if (record.key !== void 0 && (typeof record.key !== "string" || record.key.length === 0)) {
      throw new TypeError(`credentials: record "${key}" has an empty key; omit the field instead`);
    }
    for (const [name, value] of Object.entries(record.env ?? {})) {
      assertReferenceName(name);
      if (typeof value !== "string" || value.length === 0) {
        throw new TypeError(`credentials: record "${key}" env "${name}" must be a non-empty string`);
      }
    }
  }
  /** Announce one committed reference change (the seam's documented event). */
  notifyUpdated(ref) {
    this.ctx.emit("credentials/reference-updated", ref);
  }
  /** Announce one committed record change. */
  notifyRecordUpdated(key) {
    this.ctx.emit("credentials/record-updated", key);
  }
  /** Stop accepting writes and let the in-flight ones finish. */
  async dispose() {
    this.closed = true;
    await this.tail;
  }
};

// src/index.ts
var inject = ["storage"];
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
    const credentialStore = new CredentialStore(ctx, domains);
    ctx.effect(async () => {
      await credentialStore.dispose();
      await Promise.all([workspaces.close(), users.close(), settings.close(), credentials.close()]);
    }, "@visecy/dsh-platform-domain");
  });
}
export {
  apply,
  credentialsDomain,
  inject,
  settingsDomain,
  usersDomain,
  workspacesDomain
};
