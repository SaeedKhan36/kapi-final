export function allowedOrigins(): string[] {
  const configured = process.env.KAPI_ALLOWED_ORIGINS?.split(",").map((v) => v.trim()).filter(Boolean);
  if (configured?.length) return configured;
  return process.env.NODE_ENV === "production" ? [] : ["http://localhost:5173", "http://localhost:8787"];
}

export function validateProductionConfig(role: "api" | "worker" = "api"): void {
  if (process.env.NODE_ENV !== "production") return;
  const required = role === "api"
    ? ["DATABASE_URL", "KAPI_SECRET_KEY", "KAPI_SESSION_SECRET", "KAPI_ALLOWED_ORIGINS",
        "CONTROL_PLANE_PUBLIC_URL", "KAPI_WEB_URL", "WORKOS_CLIENT_ID", "WORKOS_API_KEY",
        "WORKOS_REDIRECT_URI"]
    : ["DATABASE_URL", "KAPI_SECRET_KEY", "CONTROL_PLANE_PUBLIC_URL"];
  if (role === "worker" && process.env.VM_PROVIDER === "daytona") required.push("DAYTONA_API_KEY");
  const missing = required.filter((key) => !process.env[key]?.trim());
  if (missing.length) throw new Error(`missing required production configuration: ${missing.join(", ")}`);
  if (!process.env.CONTROL_PLANE_PUBLIC_URL!.startsWith("https://")) {
    throw new Error("CONTROL_PLANE_PUBLIC_URL must use https in production");
  }
  if (role === "api" && allowedOrigins().length === 0) throw new Error("at least one KAPI_ALLOWED_ORIGINS value is required");
}
