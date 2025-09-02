// OpenCV worker: loads OpenCV.js off the main thread and performs CV ops.
// Messages:
//  - {type:'init'} => loads OpenCV (from local copy) and posts {type:'ready'}
//  - {type:'detectLine', roi:{data:ArrayBuffer,width,height,rx,ry}, click:{x,y}} => posts {type:'detectLine:result', seg:{x1,y1,x2,y2}|null}
//  - {type:'deskew'|'denoise'|'adaptive', image:{data:ArrayBuffer,width,height}} => posts {type:`<op>:result`, image:{data:ArrayBuffer,width,height}}

let ready = false;

function loadCV() {
  return new Promise((resolve, reject) => {
    if (ready) return resolve();
    // Ensure wasm (if used) resolves next to the local script
    self.Module = {
      locateFile: (file) => `opencv/${file}`
    };
    try {
      // Load from same-origin to avoid CORS issues on GitHub Pages
      importScripts('opencv/opencv.js');
    } catch (e) {
      reject(e);
      return;
    }
    if (self.cv && typeof self.cv['onRuntimeInitialized'] !== 'undefined') {
      self.cv['onRuntimeInitialized'] = () => { ready = true; resolve(); };
    } else {
      // Some builds initialize immediately
      ready = true; resolve();
    }
  });
}

function toMatRGBA(image) {
  // image: {data:ArrayBuffer,width,height}
  const imgData = new ImageData(new Uint8ClampedArray(image.data), image.width, image.height);
  return cv.matFromImageData(imgData);
}

function matToImagePayload(mat) {
  const w = mat.cols, h = mat.rows;
  const out = new cv.Mat();
  if (mat.type() !== cv.CV_8UC4) {
    cv.cvtColor(mat, out, cv.COLOR_RGBA2RGBA, 0);
  } else {
    out.data.set(mat.data);
  }
  const buf = new Uint8ClampedArray(out.data); // copy view
  const payload = { data: buf.buffer, width: w, height: h };
  out.delete();
  return payload;
}

function detectLineInROI(roiMat, rx, ry, clickX, clickY) {
  // roiMat: RGBA
  const gray = new cv.Mat();
  cv.cvtColor(roiMat, gray, cv.COLOR_RGBA2GRAY, 0);
  const edges = new cv.Mat();
  cv.Canny(gray, edges, 50, 150, 3, false);
  const lines = new cv.Mat();
  const minDim = Math.max(roiMat.cols, roiMat.rows);
  const minLen = Math.max(20, Math.floor(minDim * 0.25));
  cv.HoughLinesP(edges, lines, 1, Math.PI / 180, 60, minLen, 10);
  let best = null; let bestD = 1e12;
  const distPtSeg = (x, y, x1, y1, x2, y2) => {
    const vx = x2 - x1, vy = y2 - y1; const wx = x - x1, wy = y - y1;
    const c1 = vx * wx + vy * wy; if (c1 <= 0) return Math.hypot(x - x1, y - y1);
    const c2 = vx * vx + vy * vy; if (c2 <= c1) return Math.hypot(x - x2, y - y2);
    const t = c1 / c2; const rxp = x1 + t * vx, ryp = y1 + t * vy; return Math.hypot(x - rxp, y - ryp);
  };
  for (let i = 0; i < lines.rows; i++) {
    const x1 = rx + lines.data32S[i * 4];
    const y1 = ry + lines.data32S[i * 4 + 1];
    const x2 = rx + lines.data32S[i * 4 + 2];
    const y2 = ry + lines.data32S[i * 4 + 3];
    const dx = Math.abs(x2 - x1), dy = Math.abs(y2 - y1);
    if (dx < 4 && dy < 4) continue;
    // Only consider near-horizontal or near-vertical segments
  const hvTol = 2; if (!(dx <= hvTol || dy <= hvTol)) continue;
    const d = distPtSeg(clickX, clickY, x1, y1, x2, y2);
    if (d < bestD) { bestD = d; best = { x1, y1, x2, y2 }; }
  }
  gray.delete(); edges.delete(); lines.delete();
  return (best && bestD <= 12) ? best : null;
}

function opDeskew(srcRGBA) {
  const src = toMatRGBA(srcRGBA);
  try {
    const gray = new cv.Mat(); cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);
    const edges = new cv.Mat(); cv.Canny(gray, edges, 50, 150, 3, false);
    const lines = new cv.Mat(); cv.HoughLinesP(edges, lines, 1, Math.PI / 180, 100, 100, 10);
    let angles = [];
    for (let i = 0; i < lines.rows; i++) {
      const x1 = lines.data32S[i * 4], y1 = lines.data32S[i * 4 + 1], x2 = lines.data32S[i * 4 + 2], y2 = lines.data32S[i * 4 + 3];
      const a = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;
      if (Math.abs(a) <= 20 || Math.abs(90 - Math.abs(a)) <= 20) angles.push(a);
    }
    let angle = 0; if (angles.length) { angles.sort((a, b) => a - b); angle = angles[Math.floor(angles.length / 2)]; }
    if (Math.abs(angle) > 45) angle = (angle > 0 ? 90 : -90) - angle;
    const center = new cv.Point(src.cols / 2, src.rows / 2);
    const M = cv.getRotationMatrix2D(center, angle, 1);
    const dst = new cv.Mat(); const size = new cv.Size(src.cols, src.rows);
    cv.warpAffine(src, dst, M, size, cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar());
    const payload = matToImagePayload(dst);
    gray.delete(); edges.delete(); lines.delete(); dst.delete(); M.delete();
    return payload;
  } finally { src.delete(); }
}

function opDenoise(srcRGBA) {
  const src = toMatRGBA(srcRGBA);
  try {
    const dst = new cv.Mat(); cv.medianBlur(src, dst, 3); const payload = matToImagePayload(dst); dst.delete(); return payload;
  } finally { src.delete(); }
}

function opAdaptive(srcRGBA) {
  const src = toMatRGBA(srcRGBA);
  try {
    const gray = new cv.Mat(); cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);
    const dst = new cv.Mat(); cv.adaptiveThreshold(gray, dst, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 15, 10);
    const rgba = new cv.Mat(); cv.cvtColor(dst, rgba, cv.COLOR_GRAY2RGBA, 0);
    const payload = matToImagePayload(rgba);
    gray.delete(); dst.delete(); rgba.delete();
    return payload;
  } finally { src.delete(); }
}

self.onmessage = async (e) => {
  const msg = e.data || {};
  try {
    if (msg.type === 'init') {
      await loadCV();
      self.postMessage({ type: 'ready' });
      return;
    }
    if (!ready) { await loadCV(); }
    switch (msg.type) {
      case 'detectLine': {
        const { roi, click } = msg; // roi: {data,width,height,rx,ry}
        const imgData = new ImageData(new Uint8ClampedArray(roi.data), roi.width, roi.height);
        const mat = cv.matFromImageData(imgData);
        try {
          const seg = detectLineInROI(mat, roi.rx, roi.ry, click.x, click.y);
          self.postMessage({ type: 'detectLine:result', seg });
        } finally { mat.delete(); }
        break;
      }
      case 'deskew': {
        const out = opDeskew(msg.image);
        self.postMessage({ type: 'deskew:result', image: out }, [out.data]);
        break;
      }
      case 'denoise': {
        const out = opDenoise(msg.image);
        self.postMessage({ type: 'denoise:result', image: out }, [out.data]);
        break;
      }
      case 'adaptive': {
        const out = opAdaptive(msg.image);
        self.postMessage({ type: 'adaptive:result', image: out }, [out.data]);
        break;
      }
    }
  } catch (err) {
    self.postMessage({ type: 'error', error: String(err && err.message || err) });
  }
};
