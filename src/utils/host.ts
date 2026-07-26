export function normalizeConfiguredHostname(hostname: string): string {
  return hostname.toLowerCase();
}

export function getRequestHostCandidates(hostHeader: string | string[] | undefined, protocol?: string): string[] {
  const raw = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
  if (!raw) return [];

  const value = raw.trim().toLowerCase();
  if (!value) return [];

  const parsed = splitHostAndPort(value);
  if (!parsed.hostname) return [];

  const port = parsed.port;
  if (!port) {
    const defaultPort = defaultPortForProtocol(protocol);
    const candidates = [parsed.hostname];
    if (defaultPort) {
      candidates.push(`${parsed.hostname}:${defaultPort}`);
    }
    return candidates;
  }

  if (port === "80" || port === "443") {
    return [parsed.hostname, `${parsed.hostname}:${port}`];
  }

  return [`${parsed.hostname}:${port}`];
}

function defaultPortForProtocol(protocol?: string): string | undefined {
  if (protocol === "https") return "443";
  if (protocol === "http") return "80";
  return undefined;
}

function splitHostAndPort(host: string): { hostname: string; port?: string } {
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end === -1) return { hostname: host };

    const hostname = host.slice(0, end + 1);
    const rest = host.slice(end + 1);
    if (rest.startsWith(":")) {
      return { hostname, port: rest.slice(1) || undefined };
    }
    return { hostname };
  }

  const colon = host.lastIndexOf(":");
  if (colon > -1 && host.indexOf(":") === colon) {
    return {
      hostname: host.slice(0, colon),
      port: host.slice(colon + 1) || undefined,
    };
  }

  return { hostname: host };
}
