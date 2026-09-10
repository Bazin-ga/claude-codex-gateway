import { Worker } from 'node:worker_threads';

const DEFAULT_MAX_PENDING = 8;

function workerError(value, fallback) {
  const error = new Error(value?.message ?? fallback);
  error.name = value?.name ?? 'Error';
  if (value?.code) error.code = value.code;
  return error;
}

export class MetricsQueryService {
  constructor({ dbPath, maxPending = DEFAULT_MAX_PENDING, workerFactory = null } = {}) {
    if (typeof dbPath !== 'string' || !dbPath) throw new Error('metrics query dbPath is required');
    this.dbPath = dbPath;
    this.maxPending = Number.isSafeInteger(maxPending) && maxPending > 0
      ? maxPending
      : DEFAULT_MAX_PENDING;
    this.workerFactory = workerFactory ?? (() => new Worker(
      new URL('./metrics-query-worker.js', import.meta.url),
      {
        workerData: { dbPath: this.dbPath },
        execArgv: ['--no-warnings'],
        // The gateway process has a deliberately small systemd memory ceiling.
        // Keep the independent reader isolate bounded so a pathological chart
        // cannot trade event-loop stalls for an unbounded worker heap.
        resourceLimits: {
          maxOldGenerationSizeMb: 64,
          maxYoungGenerationSizeMb: 16,
          stackSizeMb: 4,
        },
      },
    ));
    this.worker = null;
    this.pending = new Map();
    this.nextId = 1;
    this.ready = false;
    this.closed = false;
  }

  async init() {
    if (this.ready) return this;
    if (this.closed) throw new Error('metrics query service is closed');
    const worker = this.workerFactory();
    this.worker = worker;
    await new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        fn(value);
      };
      worker.on('message', (message) => {
        if (message?.type === 'ready') {
          this.ready = true;
          settle(resolve);
          return;
        }
        if (message?.type === 'fatal') {
          settle(reject, workerError(message.error, 'metrics query worker failed'));
          return;
        }
        this.#handleMessage(message);
      });
      worker.once('error', (error) => {
        settle(reject, error);
        this.#fail(error);
      });
      worker.once('exit', (code) => {
        const error = new Error(`metrics query worker exited (${code})`);
        if (!this.closed) settle(reject, error);
        this.#fail(error);
      });
    });
    return this;
  }

  #handleMessage(message) {
    if (!['result', 'error'].includes(message?.type) || !Number.isSafeInteger(message.id)) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.type === 'result') pending.resolve(message.dataset);
    else pending.reject(workerError(message.error, 'metrics query failed'));
  }

  #fail(error) {
    this.ready = false;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  query(filters) {
    if (!this.ready || !this.worker || this.closed) {
      return Promise.reject(new Error('metrics query service is unavailable'));
    }
    if (this.pending.size >= this.maxPending) {
      const error = new Error('metrics query queue is full');
      error.code = 'METRICS_QUERY_BUSY';
      return Promise.reject(error);
    }
    const id = this.nextId;
    this.nextId = this.nextId >= Number.MAX_SAFE_INTEGER ? 1 : this.nextId + 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.worker.postMessage({ type: 'query', id, filters });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const error = new Error('metrics query service closed');
    this.#fail(error);
    const worker = this.worker;
    this.worker = null;
    if (!worker) return;
    try {
      worker.postMessage({ type: 'close' });
    } catch {
      // It may already have exited; terminate remains idempotent.
    }
    await worker.terminate();
  }
}
