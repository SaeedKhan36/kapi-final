import { chmodSync, writeFileSync } from "node:fs";
import { loadEnv } from "@kapi/env";
import { readAppConfig, validateAppPrivateKey } from "@kapi/identity";

loadEnv();

const outputFlag = process.argv.indexOf("--output");
const output = outputFlag >= 0 ? process.argv[outputFlag + 1] : undefined;
if (!output) throw new Error("usage: tsx scripts/write-azure-parameters.ts --output <temporary-file>");

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for Azure deployment`);
  return value;
};

const optional = (name: string, fallback: string): string =>
  process.env[name]?.trim() || fallback;

const prefix = optional("AZURE_PREFIX", "kapi");
if (!/^[a-z][a-z0-9-]{2,11}$/.test(prefix)) {
  throw new Error("AZURE_PREFIX must be 3-12 lowercase letters, digits, or hyphens and start with a letter");
}

const location = optional("AZURE_LOCATION", "centralindia");
if (!/^[a-z0-9]+$/.test(location)) throw new Error("AZURE_LOCATION must be an Azure location code");

const postgresAdminLogin = optional("AZURE_POSTGRES_ADMIN_LOGIN", "kapiadmin");
if (!/^[a-z][a-z0-9_]{2,62}$/i.test(postgresAdminLogin) || postgresAdminLogin.toLowerCase() === "postgres") {
  throw new Error("AZURE_POSTGRES_ADMIN_LOGIN is invalid or reserved");
}
const postgresAdminPassword = required("AZURE_POSTGRES_ADMIN_PASSWORD");
if (postgresAdminPassword.length < 16 || postgresAdminPassword.length > 128) {
  throw new Error("AZURE_POSTGRES_ADMIN_PASSWORD must be 16-128 characters");
}

const secretKey = required("KAPI_SECRET_KEY");
if (Buffer.from(secretKey, "base64").length !== 32) {
  throw new Error("KAPI_SECRET_KEY must decode to exactly 32 bytes");
}
const sessionSecret = required("KAPI_SESSION_SECRET");
if (sessionSecret.length < 32) throw new Error("KAPI_SESSION_SECRET must be at least 32 characters");

const github = readAppConfig();
if (!github) throw new Error("GITHUB_APP_ID and a GitHub App private key are required");
validateAppPrivateKey(github);

const parameters = {
  "$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#",
  contentVersion: "1.0.0.0",
  parameters: {
    prefix: { value: prefix },
    location: { value: location },
    postgresAdminLogin: { value: postgresAdminLogin },
    postgresAdminPassword: { value: postgresAdminPassword },
    postgresTier: { value: optional("AZURE_POSTGRES_TIER", "Burstable") },
    postgresSkuName: { value: optional("AZURE_POSTGRES_SKU", "Standard_B1ms") },
    postgresHighAvailability: { value: optional("AZURE_POSTGRES_HA", "Disabled") },
    postgresBackupRetentionDays: {
      value: Number(optional("AZURE_POSTGRES_BACKUP_DAYS", "7")),
    },
    kapiSecretKey: { value: secretKey },
    kapiSessionSecret: { value: sessionSecret },
    workosClientId: { value: required("WORKOS_CLIENT_ID") },
    workosApiKey: { value: required("WORKOS_API_KEY") },
    githubAppId: { value: github.appId },
    githubAppPrivateKey: { value: github.privateKey },
    githubWebhookSecret: { value: required("GITHUB_WEBHOOK_SECRET") },
    metricsToken: { value: required("KAPI_METRICS_TOKEN") },
    daytonaApiKey: { value: required("DAYTONA_API_KEY") },
  },
};

writeFileSync(output, `${JSON.stringify(parameters)}\n`, { encoding: "utf8", mode: 0o600 });
chmodSync(output, 0o600);
console.log("Azure secure deployment parameters prepared");
