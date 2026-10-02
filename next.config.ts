import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native / non-ECMAScript packages must stay runtime requires instead of being
  // bundled by Turbopack: libsql ships a native client, dockerode pulls in
  // ssh2 + cpu-features assets.
  serverExternalPackages: ["@libsql/client", "@libsql/hrana-client", "libsql", "dockerode", "docker-modem", "ssh2", "cpu-features"],
};

export default nextConfig;
