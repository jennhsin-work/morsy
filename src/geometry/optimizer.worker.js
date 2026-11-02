import { optimizeMesh } from "./optimizer.js";

self.onmessage = (e) => {
  const { jobId, positions, uvs, indices, opts } = e.data;
  try {
    const res = optimizeMesh({ positions, uvs, indices }, opts);
    self.postMessage(
      { jobId, ok: true, ...res },
      [res.positions.buffer, res.indices.buffer, res.normals.buffer, ...(res.uvs ? [res.uvs.buffer] : [])],
    );
  } catch (err) {
    self.postMessage({ jobId, ok: false, error: String(err?.stack || err) });
  }
};
