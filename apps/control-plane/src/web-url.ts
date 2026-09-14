const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Production redirects must use the one configured web origin. During local
 * development, browsers and test runners commonly disagree only on whether
 * the loopback host is named `localhost` or `127.0.0.1`; treat those aliases
 * as the same origin while still requiring the configured protocol and port.
 */
export function isAllowedWebOrigin(
  target: URL, configured: URL, nodeEnv = process.env.NODE_ENV,
): boolean {
  if (target.origin === configured.origin) return true;
  if (nodeEnv === "production") return false;
  return LOOPBACK_HOSTS.has(target.hostname)
    && LOOPBACK_HOSTS.has(configured.hostname)
    && target.protocol === configured.protocol
    && target.port === configured.port;
}
