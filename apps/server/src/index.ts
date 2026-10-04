import { createApp } from './app.js';

const port = Number(process.env['PORT'] ?? '3400');
createApp().listen(port, () => {
  process.stdout.write(`d3-floorspec api listening on ${String(port)}\n`);
});
