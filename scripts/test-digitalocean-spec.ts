import { readFileSync } from "node:fs";
import { parse } from "yaml";

type Env = { key?: string; value?: string; scope?: string; type?: string };
type Component = {
  name?: string;
  github?: { repo?: string; branch?: string; deploy_on_push?: boolean };
  dockerfile_path?: string;
  run_command?: string;
  http_port?: number;
  envs?: Env[];
  health_check?: { http_path?: string };
  kind?: string;
  output_dir?: string;
  catchall_document?: string;
};
type AppSpec = {
  name?: string;
  region?: string;
  services?: Component[];
  workers?: Component[];
  jobs?: Component[];
  static_sites?: Component[];
  databases?: Array<Record<string, unknown>>;
  ingress?: { rules?: Array<{ match?: { path?: { prefix?: string } }; component?: { name?: string; preserve_path_prefix?: boolean } }> };
};

const specPath = new URL("../.do/app.yaml", import.meta.url);
const source = readFileSync(specPath, "utf8");
const spec = parse(source) as AppSpec;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`DigitalOcean spec: ${message}`);
}

function named(components: Component[] | undefined, name: string): Component {
  const component = components?.find((candidate) => candidate.name === name);
  assert(component, `missing ${name} component`);
  return component;
}

function env(component: Component, key: string): Env {
  const value = component.envs?.find((candidate) => candidate.key === key);
  assert(value, `${component.name} is missing ${key}`);
  return value;
}

function assertSource(component: Component): void {
  assert(component.github?.repo === "SaeedKhan36/kapi-final", `${component.name} has the wrong repository`);
  assert(component.github.branch === "main", `${component.name} must deploy main`);
  assert(component.github.deploy_on_push === true, `${component.name} must auto-deploy pushed commits`);
}

function assertPlaceholderSecret(component: Component, key: string): void {
  const variable = env(component, key);
  assert(variable.scope === "RUN_TIME", `${component.name}.${key} must be runtime-only`);
  assert(variable.type === "SECRET", `${component.name}.${key} must be encrypted`);
  assert(variable.value?.startsWith("CHANGE_ME_"), `${component.name}.${key} must remain a non-secret placeholder in git`);
}

assert(spec.name === "kapi", "app name must remain kapi");
assert(spec.region === "sgp", "app region must remain sgp unless the database moves with it");
assert(!/render|onrender/i.test(source), "contains obsolete Render configuration");

const api = named(spec.services, "api");
const worker = named(spec.workers, "operations");
const migration = named(spec.jobs, "migrate");
const web = named(spec.static_sites, "web");
for (const component of [api, worker, migration, web]) assertSource(component);

assert(api.dockerfile_path === "Dockerfile", "API must use the production Dockerfile");
assert(api.run_command === "node apps/control-plane/dist/api.mjs", "API command drifted");
assert(api.http_port === 8787, "API must expose port 8787");
assert(api.health_check?.http_path === "/ready", "API health check must use /ready");
assert(env(api, "DATABASE_URL").value === "${kapi-db.DATABASE_PRIVATE_URL}", "API must use the private database URL");
assert(env(api, "KAPI_OPERATIONS").value === "off", "API must not run background operations");
for (const key of [
  "KAPI_SECRET_KEY", "KAPI_SESSION_SECRET", "WORKOS_CLIENT_ID", "WORKOS_API_KEY",
  "GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET", "KAPI_METRICS_TOKEN",
]) assertPlaceholderSecret(api, key);

assert(worker.dockerfile_path === "Dockerfile", "worker must use the production Dockerfile");
assert(worker.run_command === "node apps/control-plane/dist/worker.mjs", "worker command drifted");
assert(env(worker, "DATABASE_URL").value === "${kapi-db.DATABASE_PRIVATE_URL}", "worker must use the private database URL");
assert(env(worker, "VM_PROVIDER").value === "daytona", "production worker must use Daytona");
assert(env(worker, "KAPI_SCHEDULER").value === "off", "first rollout must keep scheduling off");
assert(env(worker, "KAPI_RECONCILE_DELETE").value === "false", "first rollout must be audit-only");
for (const key of ["KAPI_SECRET_KEY", "DAYTONA_API_KEY"]) assertPlaceholderSecret(worker, key);
for (const apiOnly of ["WORKOS_API_KEY", "GITHUB_APP_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET", "KAPI_SESSION_SECRET"]) {
  assert(!worker.envs?.some((candidate) => candidate.key === apiOnly), `worker must not receive API-only secret ${apiOnly}`);
}

assert(migration.kind === "PRE_DEPLOY", "migration must block deployment");
assert(migration.run_command === "node apps/control-plane/dist/migrate.mjs", "migration command drifted");
assert(env(migration, "DATABASE_URL").value === "${kapi-db.DATABASE_PRIVATE_URL}", "migration must use the private database URL");
assert(web.output_dir === "apps/web/dist", "static output directory drifted");
assert(web.catchall_document === "index.html", "SPA fallback must use index.html");
assert(env(web, "VITE_API_URL").value === "${APP_URL}", "web must call the same-origin API");

const database = spec.databases?.find((candidate) => candidate.name === "kapi-db");
assert(database?.engine === "PG" && database.production === true, "managed PostgreSQL must be production-grade");
assert(database.cluster_name === "kapi-postgres", "database binding must target kapi-postgres");

const routes = new Map(spec.ingress?.rules?.map((rule) => [rule.match?.path?.prefix, rule.component]));
for (const path of ["/api", "/auth", "/webhooks", "/ws", "/live", "/ready", "/metrics"]) {
  const target = routes.get(path);
  assert(target?.name === "api" && target.preserve_path_prefix === true, `${path} must preserve its path to the API`);
}
assert(routes.get("/")?.name === "web", "root traffic must route to the static web app");

console.log("ok DigitalOcean App Platform topology and secret boundaries");
