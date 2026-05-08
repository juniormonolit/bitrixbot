/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: new URL(".", import.meta.url).pathname,
  typescript: {
    tsconfigPath: "./tsconfig.json"
  }
};

export default nextConfig;

