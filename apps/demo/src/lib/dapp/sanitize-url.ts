/**
 * Display-only helpers for RPC endpoint URLs. Strip credentials, API keys,
 * and any query/hash from a URL so it never lands in DOM or logs.
 *
 * The browser dapp page renders `connection.rpcEndpoint` in a status pill —
 * if someone configures `NEXT_PUBLIC_DEVNET_RPC_URL` to a protected provider
 * URL (e.g. `https://devnet.helius-rpc.com/?api-key=...`) the raw value would
 * otherwise be:
 *   - written into the React-rendered DOM,
 *   - inlined into the public JS bundle at build time,
 *   - shipped to every visitor.
 *
 * Use `sanitizeRpcUrl(...)` everywhere we print an endpoint.
 */

const REDACT = "•••";

/**
 * Return a host-only summary safe to render in the browser:
 *   "https://devnet.helius-rpc.com/?api-key=abc"       -> "devnet.helius-rpc.com"
 *   "https://user:pw@solana-mainnet.example/v1?k=xyz"  -> "solana-mainnet.example"
 *   "https://api.devnet.solana.com"                    -> "api.devnet.solana.com"
 *   ""                                                 -> "—"
 *
 * If the input cannot be parsed as a URL we fall back to the redact marker
 * rather than echoing the raw string back.
 */
export function sanitizeRpcUrl(raw: string | null | undefined): string {
  if (!raw) return "—";
  try {
    const u = new URL(raw);
    return u.hostname || REDACT;
  } catch {
    return REDACT;
  }
}

/**
 * Like `sanitizeRpcUrl` but also drops credentials and query/hash from the
 * full URL while keeping the protocol + host + path. Useful for non-display
 * logging (server logs, error messages) where you still want enough context
 * to identify which environment was contacted.
 */
export function stripUrlCredentials(raw: string | null | undefined): string {
  if (!raw) return "";
  try {
    const u = new URL(raw);
    u.username = "";
    u.password = "";
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return REDACT;
  }
}
