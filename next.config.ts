import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdf-parse + pdfjs-dist bundle a Web Worker script (`pdf.worker.mjs`)
  // and load it lazily at runtime via a relative path. Next's default
  // bundling rewrites those paths to chunks that don't include the
  // worker, causing "Setting up fake worker failed" when we try to parse
  // a PDF inside a route handler. Listing them here tells Next to leave
  // the packages alone in server bundles, so Node loads them from
  // node_modules the normal way and the worker resolves correctly.
  //
  // `mammoth` is listed too — it bundles fonts / XML helpers that
  // occasionally trip Turbopack's bundler for similar reasons.
  serverExternalPackages: ["pdf-parse", "pdfjs-dist", "mammoth", "xlsx", "exceljs", "libreoffice-convert", "officeparser"],
};

export default nextConfig;
