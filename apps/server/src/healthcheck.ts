// Container healthcheck. Runs inside the image, so it must not import the app.
const port = process.env['PORT'] ?? '3400';
try {
  const res = await fetch(`http://127.0.0.1:${port}/readyz`);
  process.exit(res.ok ? 0 : 1);
} catch {
  process.exit(1);
}
