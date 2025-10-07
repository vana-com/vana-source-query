/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['repomix'],
  experimental: {
    serverActions: {
      bodySizeLimit: '10mb',
    },
  },
}

module.exports = nextConfig
