// A thread that asks the main thread a question, waits for the answer, and ends with it (FLR-T-14.12).
// It speaks runThread's protocol by hand, as threads/serve.ts does: the tests run from sources.
import { parentPort, workerData } from 'node:worker_threads';

parentPort.on('message', (m) => {
  if (m.type === 'answer') {
    const bytes = new Uint8Array(m.value + workerData.add);
    parentPort.postMessage({ type: 'done', value: { sum: m.value + workerData.add, bytes } }, [bytes.buffer]);
  }
});
parentPort.postMessage({ type: 'question', of: workerData.question });
