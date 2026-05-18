import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: new URL(".", import.meta.url).pathname,
  typescript: {
    tsconfigPath: "./tsconfig.json"
  },
  /**
   * `@/*` maps to project root, so `@/lib/bitrixbot/...` would wrongly resolve to `./lib/bitrixbot/...`.
   * tsconfig paths are not always applied the same in webpack; force the real folder.
   */
  webpack(config) {
    config.resolve.alias = {
      ...config.resolve.alias,
      "@/lib/bitrixbot": path.resolve(__dirname, "src/lib/bitrixbot")
    };
    return config;
  }
};

export default nextConfig;

