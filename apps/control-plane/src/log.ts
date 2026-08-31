export function log(
  level: "debug" | "info" | "warn" | "error",
  message: string,
  fields: Record<string, unknown> = {},
) {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...fields });
  (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(line);
}
