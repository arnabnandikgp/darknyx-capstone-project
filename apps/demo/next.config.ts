import path from "node:path";

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    root: path.join(__dirname, "..", ".."),
  },
  async headers() {
    return [
      {
        // Circuit artefacts are content-addressed by the upstream build and
        // never mutated in-place. Cache aggressively so repeat proofs reuse
        // the in-memory snarkjs cache without re-downloading 5MB+ assets.
        source: "/circuits/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
          {
            // Required so a future Web Worker fetch from a different origin
            // (e.g. preview deploys behind a CDN) doesn't get blocked.
            key: "Access-Control-Allow-Origin",
            value: "*",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
