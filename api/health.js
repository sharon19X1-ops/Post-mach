// Post Machine - Health Check API for Vercel
export default function handler(req, res) {
  return res.json({
    status: 'ok',
    service: process.env.APP_NAME ?? 'Post Machine',
    env: process.env.APP_ENV ?? 'production',
    ts: Date.now(),
  });
}