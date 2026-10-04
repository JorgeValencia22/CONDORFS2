/**
 * TaskLoader — runs weighted asynchronous loading tasks in sequence, yielding to the browser
 * between them so the loading screen can show real progress based on finished work.
 */
(function (SIM) {
  'use strict';

  /**
   * Yields to the browser so the UI can repaint between loading chunks. Uses a MessageChannel
   * macrotask (not requestAnimationFrame) so loading speed does not depend on the frame rate and
   * keeps progressing in background tabs.
   */
  const channel = typeof MessageChannel !== 'undefined' ? new MessageChannel() : null;
  const queue = [];
  if (channel) channel.port1.onmessage = () => queue.shift()();
  const nextFrame = () => new Promise((resolve) => {
    if (!channel) return setTimeout(resolve, 0);
    queue.push(resolve);
    channel.port2.postMessage(0);
  });

  class TaskLoader {
    constructor() {
      this.tasks = [];
      this.listeners = [];
    }

    /**
     * @param {string} group  display group (e.g. LOADING WORLD)
     * @param {string} label  task description
     * @param {Function} fn   sync or async function; receives a `progress(fraction)` callback
     * @param {number} weight relative cost
     */
    add(group, label, fn, weight = 1) {
      this.tasks.push({ group, label, fn, weight });
      return this;
    }

    onProgress(fn) {
      this.listeners.push(fn);
    }

    emit(info) {
      this.listeners.forEach((fn) => fn(info));
    }

    async run() {
      const total = this.tasks.reduce((s, t) => s + t.weight, 0) || 1;
      let done = 0;
      for (let i = 0; i < this.tasks.length; i++) {
        const task = this.tasks[i];
        const base = done;
        const report = (f) => {
          this.emit({ group: task.group, label: task.label, index: i, count: this.tasks.length, progress: (base + task.weight * SIM.MathUtil.clamp(f, 0, 1)) / total });
        };
        report(0);
        await nextFrame();
        const t0 = performance.now();
        await task.fn(report);
        const ms = performance.now() - t0;
        if (ms > 50) console.info(`[Loader] ${task.group} › ${task.label}: ${ms.toFixed(0)} ms`);
        done += task.weight;
        report(1);
      }
      this.emit({ group: 'READY', label: 'Flight ready', index: this.tasks.length, count: this.tasks.length, progress: 1 });
      await nextFrame();
    }
  }

  SIM.TaskLoader = TaskLoader;
  SIM.nextFrame = nextFrame;
})(window.SIM);
