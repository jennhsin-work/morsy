// Main-thread facade over a small pool of optimizer workers. One geometry per
// job; jobs from different component agents run concurrently.
import * as THREE from "three";

const POOL = Math.max(2, Math.min(6, (navigator.hardwareConcurrency || 4) - 1));

export class OptimizerPool {
  constructor() {
    this.workers = []; this.idle = []; this.queue = []; this.pending = new Map(); this.nextJob = 1;
    for (let i = 0; i < POOL; i++) {
      const w = new Worker(new URL("./optimizer.worker.js", import.meta.url), { type: "module" });
      w.onmessage = (e) => this._done(w, e.data);
      this.workers.push(w); this.idle.push(w);
    }
  }

  optimizeGeometry(geometry, opts) {
    const g = geometry.index ? geometry : geometry; // already fine either way
    const positions = Float32Array.from(g.attributes.position.array);
    const uvs = g.attributes.uv ? Float32Array.from(g.attributes.uv.array) : null;
    const indices = g.index ? Uint32Array.from(g.index.array) : null;
    return this.run({ positions, uvs, indices, opts }).then((res) => {
      const out = new THREE.BufferGeometry();
      out.setAttribute("position", new THREE.BufferAttribute(res.positions, 3));
      out.setAttribute("normal", new THREE.BufferAttribute(res.normals, 3));
      if (res.uvs) out.setAttribute("uv", new THREE.BufferAttribute(res.uvs, 2));
      out.setIndex(new THREE.BufferAttribute(res.indices, 1));
      return { geometry: out, report: res.report };
    });
  }

  run(msg) {
    return new Promise((resolve, reject) => {
      const jobId = this.nextJob++;
      this.pending.set(jobId, { resolve, reject });
      this.queue.push({ jobId, msg });
      this._pump();
    });
  }

  _pump() {
    while (this.idle.length && this.queue.length) {
      const w = this.idle.pop(); const { jobId, msg } = this.queue.shift();
      const transfer = [msg.positions.buffer]; if (msg.uvs) transfer.push(msg.uvs.buffer); if (msg.indices) transfer.push(msg.indices.buffer);
      w.postMessage({ jobId, ...msg }, transfer);
    }
  }

  _done(w, data) {
    this.idle.push(w);
    const p = this.pending.get(data.jobId); this.pending.delete(data.jobId);
    if (p) data.ok ? p.resolve(data) : p.reject(new Error(data.error));
    this._pump();
  }
}
