import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native / non-ECMAScript packages must stay runtime requires instead of being
  // bundled by Turbopack: better-sqlite3 is a native addon, dockerode pulls in
  // ssh2 + cpu-features assets.
  serverExternalPackages: ["better-sqlite3", "dockerode", "docker-modem", "ssh2", "cpu-features"],
};

export default nextConfig;
