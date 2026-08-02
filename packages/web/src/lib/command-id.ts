type CommandIdSource = {
  randomUuid?: () => string;
  getRandomValues?: (values: Uint32Array) => Uint32Array;
  now?: () => number;
  random?: () => number;
};

function browserCommandIdSource(): CommandIdSource {
  const browserCrypto = globalThis.crypto;
  return {
    randomUuid:
      typeof browserCrypto?.randomUUID === "function"
        ? () => browserCrypto.randomUUID()
        : undefined,
    getRandomValues:
      typeof browserCrypto?.getRandomValues === "function"
        ? (values) => browserCrypto.getRandomValues(values)
        : undefined,
  };
}

/**
 * Create a client command id for WikiRuns idempotency. LAN HTTP pages do not
 * expose `crypto.randomUUID`, so use `getRandomValues` when available and a
 * timestamp/random fallback only when no Web Crypto API exists at all.
 */
export function newCommandId(source: CommandIdSource = browserCommandIdSource()): string {
  if (source.randomUuid) return source.randomUuid();

  if (source.getRandomValues) {
    const values = source.getRandomValues(new Uint32Array(4));
    return `cmd-${Array.from(values, (value) => value.toString(36).padStart(7, "0")).join("")}`;
  }

  const now = source.now ?? Date.now;
  const random = source.random ?? Math.random;
  return `cmd-${now().toString(36)}-${random().toString(36).slice(2)}`;
}
