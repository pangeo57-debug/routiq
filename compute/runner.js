'use strict';
// One optimisation run in its own thread, so several run at once and a
// cancelled job can be stopped by terminating its threads.
const { parentPort, workerData } = require('worker_threads');
const { run } = require('./engine');

(async () => {
  try {
    const out = await run(workerData.job, { warm: workerData.warm, seed: workerData.seed,
      onProgress: workerData.progress ? (p, a, b, c) => parentPort.postMessage({ progress: [p, a, b, c] }) : null });
    parentPort.postMessage({ ok: true, out: JSON.parse(JSON.stringify({ schedule: out.schedule, students: out.students, result: out.result })) });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: String((e && e.message) || e) });
  }
})();
