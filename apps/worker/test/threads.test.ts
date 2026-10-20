import { MessageChannel } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { answerJobThread, canJobThread, jobFileBuffers, jobThreadData, threadJob, type JobThreadData } from '../src/queue/offthread.js';
import { createHandlers, type Handler, type JobFile, type JobRow } from '../src/queue/handlers.js';
import { revive, runThread, transferable, type ThreadEnd } from '../src/threads/index.js';
import { endWith } from '../src/threads/serve.js';

/**
 * FLR-T-14.12: work on a thread of its own — the helper films (FLR-T-14.10), stills and every heavy
 * job now share. The main thread answers what the thread asks and takes its result; it stays free
 * while the thread works; a signal ends the thread at once, mid-loop; a refusal stays a RangeError.
 * And a job's thread: its progress and its reads of another version go to the main thread, and its
 * file comes back whole.
 */

const fixture = (name: string): URL => new URL(`./fixtures/threads/${name}.mjs`, import.meta.url);

describe('a thread of its own', () => {
  it('answers what the thread asks, and takes its result, its buffer moved', async () => {
    const asked: unknown[] = [];
    const r = await runThread<{ sum: number; bytes: Uint8Array }>(fixture('ask'), { question: 'how many?', add: 2 }, {
      onMessage: (m, post) => {
        asked.push(m);
        post({ type: 'answer', value: 40 });
      },
    });
    expect(asked).toEqual([{ type: 'question', of: 'how many?' }]);
    expect(r.sum).toBe(42);
    expect(r.bytes.byteLength).toBe(42);
  });

  it('keeps the main thread free while the thread holds its own, and ends it at once on the signal', async () => {
    const stop = new AbortController();
    let started = 0;
    const work = runThread(fixture('spin'), {}, {
      signal: stop.signal,
      stopped: () => new Error('the job was stopped'),
      onMessage: () => { started = performance.now(); },
    });
    work.catch(() => undefined);
    // The main thread's timers keep their time while the thread spins.
    let late = 0;
    for (let i = 0; i < 10; i++) {
      const t = performance.now();
      await new Promise((resolve) => setTimeout(resolve, 20));
      late = Math.max(late, performance.now() - t - 20);
    }
    expect(started).toBeGreaterThan(0);
    expect(late).toBeLessThan(100);
    const t = performance.now();
    stop.abort();
    await expect(work).rejects.toThrow('the job was stopped');
    expect(performance.now() - t).toBeLessThan(100);
  });

  it('says the signal\'s own reason by default, and never starts a thread for a signal already aborted', async () => {
    const stop = new AbortController();
    const work = runThread(fixture('spin'), {}, { signal: stop.signal, onMessage: () => { stop.abort(new Error('cancelled by a person')); } });
    await expect(work).rejects.toThrow('cancelled by a person');
    await expect(runThread(fixture('ask'), {}, { signal: stop.signal })).rejects.toThrow('cancelled by a person');
  });

  it('ends the thread when answering it fails, with that failure', async () => {
    await expect(runThread(fixture('spin'), {}, { onMessage: () => { throw new Error('the job is no longer this worker\'s'); } })).rejects.toThrow('the job is no longer this worker\'s');
    await expect(runThread(fixture('spin'), {}, { onMessage: () => Promise.reject(new Error('no longer')) })).rejects.toThrow('no longer');
  });

  it('keeps a refusal a RangeError, and says when a thread stopped without a word', async () => {
    const refused = runThread(fixture('fail'), {});
    await expect(refused).rejects.toBeInstanceOf(RangeError);
    await expect(refused).rejects.toThrow('a still at that size is more work than a still may take');
    await expect(runThread(fixture('fail'), { exit: true }, { name: 'the tour thread' })).rejects.toThrow('the tour thread stopped (3) before it finished');
  });

  it('revives an error as its kind, its name kept', () => {
    expect(revive({ name: 'TypeError', message: 'x' })).toBeInstanceOf(TypeError);
    const gone = revive({ name: 'JobGone', message: 'cancelled' });
    expect([gone.name, gone.message]).toEqual(['JobGone', 'cancelled']);
  });

  it('moves only whole buffers, each once — never a view onto part of one, or Node\'s pool', () => {
    const whole = new Uint8Array(64);
    const part = new Uint8Array(new ArrayBuffer(64), 8, 16);
    const pooled = Buffer.from('a few bytes');
    expect(transferable([whole, whole, part, pooled, undefined])).toEqual([whole.buffer]);
  });
});

describe('a job on a thread of its own', () => {
  /** Run `table`'s handler as a job's thread would, over a MessageChannel, answered by `job` as the drain's thread answers. */
  async function overChannel(data: JobThreadData, table: Readonly<Record<string, Handler>>, job: JobRow): Promise<JobFile> {
    const { port1: main, port2: thread } = new MessageChannel();
    try {
      const answer = answerJobThread(job);
      const ended = new Promise<JobFile>((resolve, reject) => {
        main.on('message', (m: ThreadEnd<JobFile> | { type: string }) => {
          if (m.type === 'done') resolve((m as { value: JobFile }).value);
          else if (m.type === 'error') reject(revive((m as { error: { name: string; message: string } }).error));
          else answer(m, (a) => { main.postMessage(a); }).catch(reject);
        });
      });
      // Awaited below, after the thread's side has ended: a failure before then is not unhandled.
      ended.catch(() => undefined);
      await endWith(thread, threadJob(data, thread, table), jobFileBuffers);
      return await ended;
    } finally {
      main.close();
      thread.close();
    }
  }

  const row: JobRow = { id: 'J1', projectId: 'P1', kind: 'export.pair', params: { pair: 'B' }, versionHash: 'a'.repeat(64) };

  it('reports its progress to the main thread, reads another version through it, and hands its file back whole', async () => {
    const said: Record<string, unknown>[] = [];
    const versions: Record<string, object> = { ['b'.repeat(64)]: { name: 'B' } };
    const table: Record<string, Handler> = {
      'export.pair': async (document, job) => {
        await job.progress?.({ shot: 1, shots: 2 });
        const other = await job.load?.('b'.repeat(64));
        await expect(job.load?.('c'.repeat(64)) ?? Promise.resolve()).rejects.toThrow('version cccccccccccc is not in the store');
        return { name: 'pair.zip', contentType: 'application/zip', bytes: new Uint8Array([1, 2, 3]), assets: [{ path: 'a.png', contentType: 'image/png', bytes: new Uint8Array([4]) }], summary: { a: document, b: other, claimed: [...(job.claimed ?? [])] } };
      },
    };
    const job: JobRow = {
      ...row,
      claimed: new Set(['d1']),
      progress: (p) => { said.push(p); return Promise.resolve(); },
      load: (hash) => {
        const v = versions[hash];
        return v === undefined ? Promise.reject(new Error(`version ${hash.slice(0, 12)} is not in the store`)) : Promise.resolve(v);
      },
    };
    const data = jobThreadData({ name: 'A' }, job);
    expect(data).toEqual({ document: { name: 'A' }, job: { id: 'J1', projectId: 'P1', kind: 'export.pair', params: { pair: 'B' }, versionHash: 'a'.repeat(64) }, claimed: ['d1'], load: true });
    const file = await overChannel(data, table, job);
    expect(said).toEqual([{ shot: 1, shots: 2 }]);
    expect([...file.bytes]).toEqual([1, 2, 3]);
    expect(file.assets?.map((a) => [a.path, [...a.bytes]])).toEqual([['a.png', [4]]]);
    expect(file.summary).toEqual({ a: { name: 'A' }, b: { name: 'B' }, claimed: ['d1'] });
  });

  it('fails with the handler\'s own words, and refuses a kind nobody knows', async () => {
    const table: Record<string, Handler> = { 'export.pair': () => Promise.reject(new RangeError('a pair job names its B')) };
    const job: JobRow = { ...row };
    const refused = overChannel(jobThreadData({}, job), table, job);
    await expect(refused).rejects.toBeInstanceOf(RangeError);
    await expect(refused).rejects.toThrow('a pair job names its B');
    const unknown: JobRow = { ...row, kind: 'export.nothing' };
    await expect(overChannel(jobThreadData({}, unknown), table, unknown)).rejects.toThrow('no worker knows how to run a export.nothing job');
  });

  it('stops the thread when the job is no longer this worker\'s: its progress throws', async () => {
    const table: Record<string, Handler> = {
      'export.pair': async (_document, job) => {
        await job.progress?.({ pass: 1 });
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { name: 'x', contentType: 'x', bytes: new Uint8Array() };
      },
    };
    const job: JobRow = { ...row, progress: () => Promise.reject(new Error('job J1 is no longer this worker\'s: it was cancelled')) };
    await expect(overChannel(jobThreadData({}, job), table, job)).rejects.toThrow('it was cancelled');
  });

  it('runs in-process from sources, where there is no compiled thread to start', () => {
    expect(canJobThread()).toBe(false);
    expect(Object.keys(createHandlers({}))).toEqual(Object.keys(createHandlers({ inline: true })));
  });
});
