/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['repomix'],
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'avatars.githubusercontent.com',
      },
    ],
  },
  experimental: {
    serverActions: {
      bodySizeLimit: '10mb',
    },
  },
  env: {
    // Expose database availability to client
    // This enables auth UI and server-side storage features
    NEXT_PUBLIC_HAS_DATABASE: process.env.DATABASE_URL ? 'true' : 'false',
  },
}

module.exports = nextConfig
