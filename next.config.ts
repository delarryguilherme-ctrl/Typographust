import type { NextConfig } from "next";

/**
 * GitHub Pages serves the site from /<repo>, so asset URLs need that prefix —
 * but only for that build. Local development and any root-hosted deploy keep
 * their normal paths.
 */
const basePath = process.env.PAGES_BASE_PATH ?? "";

const nextConfig: NextConfig = {
  // Nothing here runs on a server: no API routes, no server-side data. The whole
  // font pipeline is client-side, so the app exports to plain static files.
  output: "export",
  basePath,
  images: { unoptimized: true },
};

export default nextConfig;
