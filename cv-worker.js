// OpenCV worker: loads OpenCV.js off the main thread and performs CV ops.
// Messages:
//  - {type:'init'} => loads OpenCV (from CDN) and posts {type:'ready'}
//  - {type:'detectLine', roi:{data:ArrayBuffer,width,height,rx,ry}, click:{x,y}} => posts {type:'detectLine:result', seg:{x1,y1,x2,y2}|null}
//  - {type:'deskew'|'denoise'|'adaptive', image:{data:ArrayBuffer,width,height}} => posts {type:`<op>:result`, image:{data:ArrayBuffer,width,height}}
//  - {type:'buildGraph', id:string, image:{data,width,height}} => build per-page wire graph; posts {type:'buildGraph:result', id}
//  - {type:'tracePath', id:string, click:{x,y}} => posts {type:'tracePath:result', id, path:[{x,y},...]|null}

let ready = false;
// Cache of graphs per page id
const graphs = new Map();

function loadCV() {
  return new Promise((resolve, reject) => {
    if (ready) return resolve();
 DevShgOpenCv
    const sources = [
      // Prefer CORS-friendly CDN first
      'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.9.0/dist/opencv.js',
      'https://unpkg.com/@techstark/opencv-js@4.9.0/dist/opencv.js',
      // Try local vendored copy if provided
      (()=>{ try{ const u=new URL('./vendor/opencv/opencv.js', self.location.href); return u.href }catch(_){ return self.location.origin + '/vendor/opencv/opencv.js' } })(),
      // As a last resort, docs site (often blocked by CORS)
      'https://docs.opencv.org/4.x/opencv.js'
    ];
    (async()=>{
      let lastErr = null;
      for(const url of sources){
        try{
          // Point wasm loader to same base directory as the JS file
          const base = url.slice(0, url.lastIndexOf('/')+1);
          self.Module = { locateFile: (file) => base + file };
          importScripts(url);
          if (self.cv && typeof self.cv['onRuntimeInitialized'] !== 'undefined') {
            self.cv['onRuntimeInitialized'] = () => { ready = true; resolve(); };
            return;
          }
          if (self.cv && typeof self.cv.Mat === 'function') { ready = true; resolve(); return; }
          // Wait briefly for WASM to finish booting if signals are atypical
          await new Promise((res)=>setTimeout(res, 250));
          if (self.cv && typeof self.cv.Mat === 'function') { ready = true; resolve(); return; }
        }catch(e){ lastErr = e; continue }
      }
      reject(lastErr || new Error('Failed to load OpenCV.js from all sources'));
    })();

    // Make sure wasm path resolves when loading from CDN
    self.Module = {
      locateFile: (file) => `https://docs.opencv.org/4.x/${file}`
    };
    try {
      importScripts('https://docs.opencv.org/4.x/opencv.js');
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
 main
  });
}

function toMatRGBA(image) {
  // image: {data:ArrayBuffer,width,height}
  const w = image.width|0, h = image.height|0;
  if (!(w>0 && h>0)) { throw new Error('Invalid image size'); }
  const expected = w * h * 4;
  let arr;
  const src = image && image.data;
  if (!src) throw new Error('Invalid image buffer');
  if (ArrayBuffer.isView(src)) {
    // src is a TypedArray view
    const view = src; // expect Uint8ClampedArray or Uint8Array
    const inLen = view.byteLength|0;
    if (inLen >= expected) {
      arr = new Uint8ClampedArray(view.buffer, view.byteOffset, expected);
    } else {
      arr = new Uint8ClampedArray(expected);
      try { arr.set(new Uint8ClampedArray(view.buffer, view.byteOffset, Math.min(inLen, expected))); } catch (_) {}
    }
  } else if (src instanceof ArrayBuffer) {
    const inLen = src.byteLength|0;
    if (inLen >= expected) {
      arr = new Uint8ClampedArray(src, 0, expected);
    } else {
      arr = new Uint8ClampedArray(expected);
      try { arr.set(new Uint8ClampedArray(src, 0, Math.min(inLen, expected))); } catch (_) {}
    }
  } else {
    throw new Error('Invalid image buffer');
  }
  let imgData;
  try{
    imgData = new ImageData(arr, w, h);
  }catch(e){
    // Re-throw with more context
    let inLen = 0, bo=0, bbl=0;
    try{
      if (ArrayBuffer.isView(src)) { inLen = src.byteLength|0; bo = src.byteOffset|0; bbl = src.buffer?.byteLength|0; }
      else if (src instanceof ArrayBuffer) { inLen = src.byteLength|0; bbl = src.byteLength|0; }
    }catch(_){ }
    throw new Error(`toMatRGBA failed: ${w}x${h} expected=${expected} srcLen=${inLen} bo=${bo} bufLen=${bbl} arrLen=${arr?.length}|${arr?.byteLength} cause=${e?.message||e}`);
  }
  return cv.matFromImageData(imgData);
}

function matToImagePayload(mat) {
  const w = mat.cols, h = mat.rows;
  let rgba;
  if (mat.type() === cv.CV_8UC4) {
    rgba = mat.clone();
  } else {
    rgba = new cv.Mat();
 DevShgOpenCv
    try{
      const ch = mat.channels ? mat.channels() : (mat.type() === cv.CV_8UC1 ? 1 : 4);
      if(ch === 1){ cv.cvtColor(mat, rgba, cv.COLOR_GRAY2RGBA, 0); }
      else if(ch === 3){ cv.cvtColor(mat, rgba, cv.COLOR_RGB2RGBA, 0); }
      else { cv.cvtColor(mat, rgba, cv.COLOR_RGBA2RGBA, 0); }
    }catch(_){
      // Fallback: draw via canvas path
      const w = mat.cols, h = mat.rows; const tmp = new cv.Mat(); cv.cvtColor(mat, tmp, cv.COLOR_RGBA2RGB, 0); const buf3 = new Uint8ClampedArray(tmp.data); const rgbaArr = new Uint8ClampedArray(w*h*4); for(let i=0,j=0;i<buf3.length;i+=3,j+=4){ rgbaArr[j]=buf3[i]; rgbaArr[j+1]=buf3[i+1]; rgbaArr[j+2]=buf3[i+2]; rgbaArr[j+3]=255; } tmp.delete(); const payload = { data: rgbaArr.buffer, width:w, height:h }; return payload;
    }
  }
  const buf = new Uint8ClampedArray(rgba.data);
  // Ensure opaque alpha to avoid compositing artifacts (black tiles)
  for(let i=3;i<buf.length;i+=4){ buf[i]=255; }

    cv.cvtColor(mat, rgba, cv.COLOR_RGBA2RGBA, 0);
  }
  const buf = new Uint8ClampedArray(rgba.data);
 main
  const payload = { data: buf.buffer, width: w, height: h };
  rgba.delete();
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

function opDeskew(srcRGBA, report) {
  const src = toMatRGBA(srcRGBA);
  try {
    if(report) report(10);
    const gray = new cv.Mat(); cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);
    if(report) report(30);
    const edges = new cv.Mat(); cv.Canny(gray, edges, 50, 150, 3, false);
    const lines = new cv.Mat(); cv.HoughLinesP(edges, lines, 1, Math.PI / 180, 100, 100, 10);
    let angles = [];
    for (let i = 0; i < lines.rows; i++) {
      const x1 = lines.data32S[i * 4], y1 = lines.data32S[i * 4 + 1], x2 = lines.data32S[i * 4 + 2], y2 = lines.data32S[i * 4 + 3];
      const a = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;
      if (Math.abs(a) <= 20 || Math.abs(90 - Math.abs(a)) <= 20) angles.push(a);
    }
    if(report) report(55);
    let angle = 0; if (angles.length) { angles.sort((a, b) => a - b); angle = angles[Math.floor(angles.length / 2)]; }
    if (Math.abs(angle) > 45) angle = (angle > 0 ? 90 : -90) - angle;
    const center = new cv.Point(src.cols / 2, src.rows / 2);
    const M = cv.getRotationMatrix2D(center, angle, 1);
    const dst = new cv.Mat(); const size = new cv.Size(src.cols, src.rows);
    cv.warpAffine(src, dst, M, size, cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar());
    const payload = matToImagePayload(dst);
    if(report) report(100);
    gray.delete(); edges.delete(); lines.delete(); dst.delete(); M.delete();
    return payload;
  } finally { src.delete(); }
}

function opBgNormalize(srcRGBA, report){
  const src = toMatRGBA(srcRGBA);
  try{
    if(report) report(15);
    const gray = new cv.Mat(); cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);
    // Estimate background via morphological opening with large kernel
    const kSize = 61; const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(kSize, kSize));
    const bg = new cv.Mat(); cv.morphologyEx(gray, bg, cv.MORPH_OPEN, kernel);
    if(report) report(55);
    // Normalize by division: gray / (bg + eps) -> stretch to 0..255
 DevShgOpenCv
    const fGray = new cv.Mat(); let fBg = new cv.Mat(); gray.convertTo(fGray, cv.CV_32F); bg.convertTo(fBg, cv.CV_32F);

    const fGray = new cv.Mat(); const fBg = new cv.Mat(); gray.convertTo(fGray, cv.CV_32F); bg.convertTo(fBg, cv.CV_32F);
 main
    const eps = 1.0; { const epsMat=new cv.Mat(fBg.rows,fBg.cols,fBg.type()); epsMat.setTo(new cv.Scalar(eps)); const sum=new cv.Mat(); cv.add(fBg, epsMat, sum); fBg.delete(); fBg=sum; epsMat.delete(); }
    const norm = new cv.Mat(); cv.divide(fGray, fBg, norm, 1.0);
    const norm2 = new cv.Mat(); cv.normalize(norm, norm2, 0, 255, cv.NORM_MINMAX);
    const out8 = new cv.Mat(); norm2.convertTo(out8, cv.CV_8U);
    const rgba = new cv.Mat(); cv.cvtColor(out8, rgba, cv.COLOR_GRAY2RGBA, 0);
    if(report) report(100);
    gray.delete(); bg.delete(); kernel.delete(); fGray.delete(); fBg.delete(); norm.delete(); norm2.delete(); out8.delete();
    return matToImagePayload(rgba);
  } finally { src.delete(); }
}

// Detect text regions: returns array of {x,y,w,h}
function detectTextRegions(srcRGBA, options){
  const src = toMatRGBA(srcRGBA);
  try{
    const gray = new cv.Mat(); cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);
    const strength = Math.max(0, Math.min(3, (options && options.strength)|0 || 2));
    // Reuse text mask pipeline
    const tmask = buildTextMask(gray, { strength, upscale:false });
    // Connected components on mask
    const labels = new cv.Mat(); const stats = new cv.Mat(); const cents = new cv.Mat();
    const num = cv.connectedComponentsWithStats(tmask, labels, stats, cents, 8, cv.CV_32S);
    const w=src.cols, h=src.rows; const areaMin = Math.max(8, (options && options.minArea)|0 || 40); const areaMax = Math.max(areaMin, (options && options.maxArea)|0 || Math.floor((w*h)/40));
    const rects = [];
    for(let i=1;i<num;i++){
      const area = stats.intPtr(i, cv.CC_STAT_AREA)[0];
      if(area < areaMin || area > areaMax) continue;
      const x = stats.intPtr(i, cv.CC_STAT_LEFT)[0];
      const y = stats.intPtr(i, cv.CC_STAT_TOP)[0];
      const ww = stats.intPtr(i, cv.CC_STAT_WIDTH)[0];
      const hh = stats.intPtr(i, cv.CC_STAT_HEIGHT)[0];
      rects.push({ x, y, w:ww, h:hh });
    }
    gray.delete(); tmask.delete(); labels.delete(); stats.delete(); cents.delete();
    return rects;
  } finally { src.delete(); }
}

function opDespeckle(srcRGBA, report, options){
  const src = toMatRGBA(srcRGBA);
  try{
    const maxSize = Math.max(1, Math.min(5000, (options && options.maxSize)|0 || 40));
    if(report) report(10);
    const gray = new cv.Mat(); cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);
 DevShgOpenCv
    // Build a conservative text mask to protect real letters from removal
    let tmask = null; try{ tmask = buildTextMask(gray, { strength: 2, upscale:false }); }catch(_){ }
    let tmaskDil = null; if(tmask){ const k=cv.getStructuringElement(cv.MORPH_RECT,new cv.Size(3,3)); tmaskDil=new cv.Mat(); cv.dilate(tmask, tmaskDil, k); k.delete(); }

 main
    // Binarize via Otsu (foreground dark -> invert to white)
    const binInv = new cv.Mat(); cv.threshold(gray, binInv, 0, 255, cv.THRESH_BINARY_INV | cv.THRESH_OTSU);
    if(report) report(40);
    // Connected components; remove tiny white components (dark specks in original)
    const labels = new cv.Mat(); const stats = new cv.Mat(); const cents = new cv.Mat();
    const num = cv.connectedComponentsWithStats(binInv, labels, stats, cents, 8, cv.CV_32S);
    const maskKeep = cv.Mat.zeros(binInv.rows, binInv.cols, cv.CV_8UC1);
    for(let i=1;i<num;i++){
      const a = stats.intPtr(i, cv.CC_STAT_AREA)[0];
      if(a > maxSize){
        // Keep this component
        const x = stats.intPtr(i, cv.CC_STAT_LEFT)[0];
        const y = stats.intPtr(i, cv.CC_STAT_TOP)[0];
        const w = stats.intPtr(i, cv.CC_STAT_WIDTH)[0];
        const h = stats.intPtr(i, cv.CC_STAT_HEIGHT)[0];
        const roiLabels = labels.roi(new cv.Rect(x,y,w,h));
        const roiMask = maskKeep.roi(new cv.Rect(x,y,w,h));
        // roiMask |= (roiLabels==i)
        const low = new cv.Mat(roiLabels.rows, roiLabels.cols, roiLabels.type(), new cv.Scalar(i));
        const high = new cv.Mat(roiLabels.rows, roiLabels.cols, roiLabels.type(), new cv.Scalar(i));
        const cmp = new cv.Mat(); cv.inRange(roiLabels, low, high, cmp); cmp.copyTo(roiMask);
        roiLabels.delete(); roiMask.delete(); cmp.delete(); low.delete(); high.delete();
      }
    }
    if(report) report(75);
    // Pixels to remove: components that were <maxSize
    const removed = new cv.Mat(); cv.subtract(binInv, maskKeep, removed);
 DevShgOpenCv
    // If we have a text mask, keep anything that overlaps text to avoid erasing strokes
    let removeSafe = removed;
    if(tmaskDil){
      const protect = new cv.Mat(); cv.bitwise_and(removed, tmaskDil, protect); // specks inside text regions
      const tmp = new cv.Mat(); cv.subtract(removed, protect, tmp); // only non-text specks
      removeSafe = tmp; protect.delete();
    }
    // Replace removed pixels in src with white
    const white = new cv.Mat(src.rows, src.cols, src.type(), new cv.Scalar(255,255,255,255));
    white.copyTo(src, removeSafe);
    if(report) report(100);
    gray.delete(); binInv.delete(); labels.delete(); stats.delete(); cents.delete(); maskKeep.delete();
    try{ if(removeSafe!==removed) removeSafe.delete(); }catch(_){ }
    removed.delete(); white.delete();
    try{ if(tmaskDil) tmaskDil.delete(); }catch(_){ }
    try{ if(tmask) tmask.delete(); }catch(_){ }

    // Replace removed pixels in src with white
    const white = new cv.Mat(src.rows, src.cols, src.type(), new cv.Scalar(255,255,255,255));
    white.copyTo(src, removed);
    if(report) report(100);
    gray.delete(); binInv.delete(); labels.delete(); stats.delete(); cents.delete(); maskKeep.delete(); removed.delete(); white.delete();
 main
    return matToImagePayload(src);
  } finally { src.delete(); }
}
function opDenoise(srcRGBA, report) {
  const src = toMatRGBA(srcRGBA);
  try {
    if(report) report(20);
    const dst = new cv.Mat(); cv.medianBlur(src, dst, 3);
    const payload = matToImagePayload(dst);
    if(report) report(100);
    dst.delete(); return payload;
  } finally { src.delete(); }
}

function opAdaptive(srcRGBA, report) {
  const src = toMatRGBA(srcRGBA);
  try {
    if(report) report(15);
    const gray = new cv.Mat(); cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);
    if(report) report(45);
    const dst = new cv.Mat(); cv.adaptiveThreshold(gray, dst, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 15, 10);
    const rgba = new cv.Mat(); cv.cvtColor(dst, rgba, cv.COLOR_GRAY2RGBA, 0);
    const payload = matToImagePayload(rgba);
    if(report) report(100);
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
      case 'buildGraph': {
        const { id, image, options } = msg;
        const graph = buildWireGraph(image, options||{});
        graphs.set(id, graph);
        self.postMessage({ type: 'buildGraph:result', id });
        break;
      }
      case 'tracePath': {
        const { id, click } = msg;
        const g = graphs.get(id);
        if (!g) { self.postMessage({ type:'tracePath:result', id, path:null }); break; }
        const path = tracePathFromClick(g, click.x, click.y);
        self.postMessage({ type:'tracePath:result', id, path });
        break;
      }
      case 'traceComponent': {
        const { id, click } = msg;
        const g = graphs.get(id);
        if (!g) { self.postMessage({ type:'traceComponent:result', id, paths:null }); break; }
        const paths = traceComponentFromClick(g, click.x, click.y);
        self.postMessage({ type:'traceComponent:result', id, paths });
        break;
      }
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
        const { reqId } = msg;
        const out = opDeskew(msg.image, (v)=> self.postMessage({ type:'progress', op:'deskew', reqId, value: v }));
        self.postMessage({ type: 'deskew:result', reqId, image: out }, [out.data]);
        break;
      }
      case 'denoise': {
        const { reqId } = msg;
        const out = opDenoise(msg.image, (v)=> self.postMessage({ type:'progress', op:'denoise', reqId, value: v }));
        self.postMessage({ type: 'denoise:result', reqId, image: out }, [out.data]);
        break;
      }
      case 'adaptive': {
        const { reqId } = msg;
        const out = opAdaptive(msg.image, (v)=> self.postMessage({ type:'progress', op:'adaptive', reqId, value: v }));
        self.postMessage({ type: 'adaptive:result', reqId, image: out }, [out.data]);
        break;
      }
      case 'bgNormalize': {
        const { reqId } = msg;
        const out = opBgNormalize(msg.image, (v)=> self.postMessage({ type:'progress', op:'bgnorm', reqId, value: v }));
        self.postMessage({ type: 'bgnorm:result', reqId, image: out }, [out.data]);
        break;
      }
      case 'despeckle': {
        const { reqId, options } = msg;
        const out = opDespeckle(msg.image, (v)=> self.postMessage({ type:'progress', op:'despeckle', reqId, value: v }), options||{});
        self.postMessage({ type: 'despeckle:result', reqId, image: out }, [out.data]);
        break;
      }
      case 'textEnhance': {
        const { reqId, options } = msg;
        const out = opTextEnhance(msg.image, (v)=> self.postMessage({ type:'progress', op:'text', reqId, value: v }), options||{});
        self.postMessage({ type: 'text:result', reqId, image: out }, [out.data]);
        break;
      }
 DevShgOpenCv
      case 'textEnhance2': {
        const { reqId, options } = msg;
        const out = opTextEnhanceSauvola(msg.image, (v)=> self.postMessage({ type:'progress', op:'text2', reqId, value: v }), options||{});
        self.postMessage({ type: 'text2:result', reqId, image: out }, [out.data]);
        break;
      }

main
      case 'exportSVG': {
        const { id, options } = msg;
        let g = graphs.get(id);
        if(!g){
          // As a fallback, try to build from provided image if present
          if(msg.image){ g = buildWireGraph(msg.image, options||{}); } else { self.postMessage({ type:'exportSVG:result', id, svg:'' }); break; }
        }
        const svg = graphToSVG(g, options||{});
        self.postMessage({ type:'exportSVG:result', id, svg });
        break;
      }
      case 'textRegions': {
        const { image, options } = msg;
        const rects = detectTextRegions(image, options||{});
        self.postMessage({ type:'textRegions:result', rects });
        break;
      }
    }
  } catch (err) {
    self.postMessage({ type: 'error', error: String(err && err.message || err) });
  }
};

// -------------- Graph building --------------
function buildWireGraph(srcRGBA, options){
  // Returns {w,h, nodes:[{id,x,y,type,deg}], edges:[{a,b,points:[{x,y}]}]}
  const mat = toMatRGBA(srcRGBA);
  try{
    const gray = new cv.Mat(); cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY, 0);
    let bin = new cv.Mat();
    // Adaptive threshold is robust to uneven backgrounds
    cv.adaptiveThreshold(gray, bin, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 21, 15);
    // Optionally exclude likely text regions (so graph ignores letters)
    let workBin = bin;
    try{
      if(options && options.ignoreText){
        const tmask = buildTextMask(gray, options);
        const inv = new cv.Mat(); cv.bitwise_not(tmask, inv);
        const masked = new cv.Mat(); cv.bitwise_and(bin, inv, masked);
        workBin = masked; tmask.delete(); inv.delete();
      }
    }catch(_){ workBin = bin; }
    // Light denoise and favor axis-aligned wires
    const kH = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5,1));
    const kV = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(1,5));
    const o1 = new cv.Mat(), o2 = new cv.Mat();
    cv.morphologyEx(workBin, o1, cv.MORPH_OPEN, kH);
    cv.morphologyEx(workBin, o2, cv.MORPH_OPEN, kV);
    const wires = new cv.Mat(); cv.bitwise_or(o1, o2, wires);
    // Bridge small gaps with a configurable close to improve continuity
    const bridge = Math.max(0, Math.min(8, (options && options.bridge)|0));
    let closed = new cv.Mat();
    if(bridge>0){
      const kSize = 1 + 2*bridge; // 1->1x1(nop), 1->3x3, 2->5x5, ...
      const kC = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(kSize,kSize));
      cv.morphologyEx(wires, closed, cv.MORPH_CLOSE, kC);
    } else {
      closed = wires.clone();
    }
    // Convert to 0/1 bitmap and thin
    const w = closed.cols, h = closed.rows; const bytes = new Uint8Array(w*h);
    for(let y=0; y<h; y++){
      for(let x=0; x<w; x++){
        bytes[y*w+x] = closed.ucharPtr(y,x)[0] ? 1 : 0;
      }
    }
    zhangSuenThin(bytes, w, h);
    const {nodes, edges} = buildGraphFromSkeleton(bytes, w, h, gray);
    gray.delete(); if(workBin!==bin){ workBin.delete(); } bin.delete(); o1.delete(); o2.delete(); wires.delete(); closed.delete();
    return { w, h, nodes, edges };
  } finally { mat.delete(); }
}

// --- SVG export helpers ---
function rdp(points, epsilon){
  if(!points || points.length<=2) return points||[];
  const sq = (x)=>x*x; const distSq=(p,a,b)=>{
    const t=((p.x-a.x)*(b.x-a.x)+(p.y-a.y)*(b.y-a.y))/Math.max(1e-9, sq(b.x-a.x)+sq(b.y-a.y));
    const u=Math.max(0,Math.min(1,t)); const x=a.x+u*(b.x-a.x), y=a.y+u*(b.y-a.y); return sq(p.x-x)+sq(p.y-y);
  };
  const simplify=(pts,eps2)=>{
    const keep=new Array(pts.length).fill(false); keep[0]=keep[pts.length-1]=true;
    const stack=[[0,pts.length-1]];
    while(stack.length){ const [s,e]=stack.pop(); let maxD=0, idx=-1; for(let i=s+1;i<e;i++){ const d=distSq(pts[i], pts[s], pts[e]); if(d>maxD){ maxD=d; idx=i; } }
      if(maxD>eps2){ keep[idx]=true; stack.push([s,idx],[idx,e]); }
    }
    return pts.filter((_,i)=>keep[i]);
  };
  return simplify(points, (epsilon||0.75)*(epsilon||0.75));
}

function snapHV(points){
  if(!points || points.length<2) return points||[];
  let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity; points.forEach(p=>{ if(p.x<minX)minX=p.x; if(p.x>maxX)maxX=p.x; if(p.y<minY)minY=p.y; if(p.y>maxY)maxY=p.y; });
  const rangeX=maxX-minX, rangeY=maxY-minY;
  if(rangeX>rangeY){ // horizontal-ish
    const ys=points.map(p=>p.y).sort((a,b)=>a-b); const y=ys[Math.floor(ys.length/2)]|0; return points.map(p=>({x:p.x|0, y}));
  } else { // vertical-ish
    const xs=points.map(p=>p.x).sort((a,b)=>a-b); const x=xs[Math.floor(xs.length/2)]|0; return points.map(p=>({x, y:p.y|0}));
  }
}

function graphToSVG(graph, options){
  const w = graph.w|0, h = graph.h|0;
  const stroke = options?.stroke || '#000';
  const strokeWidth = options?.strokeWidth || 1;
  const simplify = (options?.simplify ?? 1) || 0; // px
  const doSnap = options?.snap ? true : false;
  const parts=[];
  parts.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" stroke="${stroke}" fill="none" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">`);
  parts.push(`<g id="wires">`);
  for(const e of graph.edges||[]){
    let pts=e.points||[]; if(pts.length<2) continue;
    if(doSnap) pts = snapHV(pts);
    if(simplify>0) pts = rdp(pts, simplify);
    const d = pts.map((p,i)=> (i?`L${p.x|0},${p.y|0}`:`M${p.x|0},${p.y|0}`)).join(' ');
    parts.push(`<path d="${d}"/>`);
  }
  parts.push(`</g></svg>`);
  return parts.join('');
}

function zhangSuenThin(img, w, h){
  // img: Uint8Array with 0/1; in-place thinning
  const idx=(x,y)=>y*w+x;
  let changed=true; const nbrs=[[-1,0],[ -1,1],[0,1],[1,1],[1,0],[1,-1],[0,-1],[-1,-1]];
  function iter(step){
    const toClear=[];
    for(let y=1;y<h-1;y++){
      for(let x=1;x<w-1;x++){
        const p = img[idx(x,y)]; if(!p) continue;
        // neighbors P2..P9 in order: N, NE, E, SE, S, SW, W, NW
        const P = new Array(8);
        for(let k=0;k<8;k++){ const dx=nbrs[k][0], dy=nbrs[k][1]; P[k]=img[idx(x+dx,y+dy)]?1:0; }
        const B = P.reduce((a,b)=>a+b,0); if(B<2 || B>6) continue;
        // A: 0->1 transitions in circular sequence
        let A=0; for(let k=0;k<8;k++){ if(P[k]===0 && P[(k+1)%8]===1) A++; }
        if(A!==1) continue;
        const p2=P[0], p4=P[2], p6=P[4], p8=P[6];
        if(step===0){ if(p2*p4*p6!==0) continue; if(p4*p6*p8!==0) continue; }
        else { if(p2*p4*p8!==0) continue; if(p2*p6*p8!==0) continue; }
        toClear.push(idx(x,y));
      }
    }
    for(const i of toClear){ img[i]=0 }
    return toClear.length>0;
  }
  while(changed){ changed=false; if(iter(0)) changed=true; if(iter(1)) changed=true; }
}

function buildGraphFromSkeleton(img, w, h, grayMat){
  const idx=(x,y)=>y*w+x; const inside=(x,y)=>x>=0&&y>=0&&x<w&&y<h;
  const deg4=(x,y)=>{ let d=0; if(y>0 && img[idx(x,y-1)]) d++; if(x<w-1 && img[idx(x+1,y)]) d++; if(y<h-1 && img[idx(x,y+1)]) d++; if(x>0 && img[idx(x-1,y)]) d++; return d };
  const isOn=(x,y)=>img[idx(x,y)]===1;
  const nodeIdAt = new Int32Array(w*h); nodeIdAt.fill(-1);
  const nodes=[];
  // Identify nodes (degree!=2)
  for(let y=1;y<h-1;y++){
    for(let x=1;x<w-1;x++){
      if(!isOn(x,y)) continue; const d=deg4(x,y); if(d!==2 && d>0){ const id=nodes.length; nodeIdAt[idx(x,y)]=id; nodes.push({id, x, y, deg:d, type:'node'}); }
    }
  }
  // Tag dot-like nodes (rough circular blob around)
  try{
    if(grayMat){
      const r=4;
      for(const n of nodes){
        let cnt=0,sum=0; for(let dy=-r;dy<=r;dy++){ for(let dx=-r;dx<=r;dx++){ const xx=n.x+dx, yy=n.y+dy; if(!inside(xx,yy)) continue; const rr=dx*dx+dy*dy; if(rr>r*r) continue; const v=grayMat.ucharPtr(yy,xx)[0]; sum+= (v<128?1:0); cnt++; }}
        const fill = cnt? (sum/cnt):0; if(fill>0.55 && n.deg>=3){ n.type='dot'; }
        if(n.deg===1){ n.type='terminal'; }
        if(n.deg>=3 && n.type!=='dot'){ n.type='junction'; }
      }
    }
  }catch(_){ }
  const edges=[]; const visited = new Uint8Array(w*h);
  function pushIfOn(arr,x,y){ if(isOn(x,y) && !visited[idx(x,y)]){ arr.push([x,y]); return true } return false }
  // Trace edges from each node to next node
  const dirs=[[0,-1],[1,0],[0,1],[-1,0]]; // N,E,S,W
  for(const n of nodes){
    for(const [dx,dy] of dirs){
      const sx=n.x+dx, sy=n.y+dy; if(!inside(sx,sy) || !isOn(sx,sy)) continue; if(visited[idx(sx,sy)]) continue;
      let x=sx,y=sy, px=n.x, py=n.y; const pts=[[n.x,n.y]]; // include start node
      while(true){
        visited[idx(x,y)]=1; pts.push([x,y]);
        if(nodeIdAt[idx(x,y)]>=0){ // reached a node
          const nid=nodeIdAt[idx(x,y)]; if(nid===n.id){ break } // back to start
          const endNode=nodes[nid];
          edges.push({ a:n.id, b:endNode.id, points:pts.map(p=>({x:p[0],y:p[1]})) });
          break;
        }
        // choose next 4-neighbor that isn't previous
        let nx=-1,ny=-1; let count=0;
        for(const [ux,uy] of dirs){ const xx=x+ux, yy=y+uy; if(!inside(xx,yy)) continue; if(!isOn(xx,yy)) continue; if(xx===px && yy===py) continue; count++; nx=xx; ny=yy; }
        if(count===0){ // dead end -> create synthetic node at current point
          const id=nodes.length; nodes.push({id,x,y,deg:1,type:'terminal'}); nodeIdAt[idx(x,y)]=id; edges.push({ a:n.id, b:id, points:pts.map(p=>({x:p[0],y:p[1]})) }); break;
        }
        px=x; py=y; x=nx; y=ny;
      }
    }
  }
  return {nodes, edges};
}

function tracePathFromClick(graph, x, y){
  // Find nearest edge polyline to (x,y) and return full edge path as points
  let best=null; let bestD=1e12;
  function distToSeg(px,py, x1,y1,x2,y2){ const vx=x2-x1, vy=y2-y1; const wx=px-x1, wy=py-y1; const c1=vx*wx+vy*wy; if(c1<=0) return Math.hypot(px-x1,py-y1); const c2=vx*vx+vy*vy; if(c2<=c1) return Math.hypot(px-x2,py-y2); const t=c1/c2; const rx=x1+t*vx, ry=y1+t*vy; return Math.hypot(px-rx,py-ry); }
  for(const e of graph.edges){ const pts=e.points; for(let i=0;i<pts.length-1;i++){ const d=distToSeg(x,y, pts[i].x,pts[i].y, pts[i+1].x,pts[i+1].y); if(d<bestD){ bestD=d; best=e } } }
  if(!best) return null;
  // Return path from a to b (full edge). Caller can downsample or map to world coords.
  return best.points;
}

function traceComponentFromClick(graph, x, y){
  // Identify nearest edge as seed, then return all edge polylines connected via nodes.
  if(!graph || !graph.edges || !graph.nodes) return null;
  // Find nearest edge index
  let bestIdx=-1; let bestD=1e12; const edges=graph.edges;
  function distToSeg(px,py, x1,y1,x2,y2){ const vx=x2-x1, vy=y2-y1; const wx=px-x1, wy=py-y1; const c1=vx*wx+vy*wy; if(c1<=0) return Math.hypot(px-x1,py-y1); const c2=vx*vx+vy*vy; if(c2<=c1) return Math.hypot(px-x2,py-y2); const t=c1/c2; const rx=x1+t*vx, ry=y1+t*vy; return Math.hypot(px-rx,py-ry); }
  for(let ei=0; ei<edges.length; ei++){
    const e=edges[ei]; const pts=e.points||[]; for(let i=0;i<pts.length-1;i++){ const d=distToSeg(x,y, pts[i].x,pts[i].y, pts[i+1].x,pts[i+1].y); if(d<bestD){ bestD=d; bestIdx=ei } }
  }
  if(bestIdx<0) return null;
  // Build adjacency: edges adjacent if they share a node id
  const nodeToEdges = new Map();
  for(let ei=0; ei<edges.length; ei++){
    const e=edges[ei]; const a=e.a|0, b=e.b|0;
    if(!nodeToEdges.has(a)) nodeToEdges.set(a, []); nodeToEdges.get(a).push(ei);
    if(!nodeToEdges.has(b)) nodeToEdges.set(b, []); nodeToEdges.get(b).push(ei);
  }
  const visited = new Uint8Array(edges.length);
  const stack=[bestIdx]; visited[bestIdx]=1; const comp=[];
  while(stack.length){
    const ei = stack.pop(); const e = edges[ei]; comp.push(ei);
    const a=e.a|0, b=e.b|0; const as=nodeToEdges.get(a)||[], bs=nodeToEdges.get(b)||[];
    for(const nei of as){ if(!visited[nei]){ visited[nei]=1; stack.push(nei); } }
    for(const nei of bs){ if(!visited[nei]){ visited[nei]=1; stack.push(nei); } }
DevShgOpenCv
  }
  // Return as array of polylines (each edge's points). Caller may merge or simplify.
  const paths = comp.map(ei=>{
    const pts = edges[ei].points||[]; return pts;
  });
  return paths;
}

// --- Text mask and enhancement ---
function buildTextMask(gray, options){
  // Detect likely text as dark, relatively small blobs on light background.
  const strength = Math.max(0, Math.min(3, (options && options.strength)|0 || 2));
  const kSize = Math.max(7, Math.min(25, 11 + strength*4));
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(kSize, kSize));
  const bh = new cv.Mat(); cv.morphologyEx(gray, bh, cv.MORPH_BLACKHAT, kernel);
  const mask = new cv.Mat(); cv.threshold(bh, mask, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
  const open = new cv.Mat(); const k3 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3,3)); cv.morphologyEx(mask, open, cv.MORPH_OPEN, k3);
  // Filter connected components to keep text-like sizes
  const labels = new cv.Mat(); const stats = new cv.Mat(); const cents = new cv.Mat();
  const num = cv.connectedComponentsWithStats(open, labels, stats, cents, 8, cv.CV_32S);
  const out = cv.Mat.zeros(mask.rows, mask.cols, cv.CV_8UC1);
  const areaScale = (options && options.upscale)?4:1;
  const minA = 8*areaScale, maxA = Math.max(2000*areaScale, ((gray.rows*gray.cols)|0)/(200/areaScale));
  for(let i=1;i<num;i++){
    const a = stats.intPtr(i, cv.CC_STAT_AREA)[0];
    const w = stats.intPtr(i, cv.CC_STAT_WIDTH)[0];
    const h = stats.intPtr(i, cv.CC_STAT_HEIGHT)[0];
    if(a>=minA && a<=maxA && w>=2 && h>=2){
      const rect = new cv.Rect(stats.intPtr(i, cv.CC_STAT_LEFT)[0], stats.intPtr(i, cv.CC_STAT_TOP)[0], w, h);
      const roi = out.roi(rect); roi.setTo(new cv.Scalar(255)); roi.delete();
    }
  }
  kernel.delete(); bh.delete(); mask.delete(); open.delete(); labels.delete(); stats.delete(); cents.delete();
  return out;
}

function opTextEnhance(srcRGBA, report, options){
  const src = toMatRGBA(srcRGBA);
  try{
    const strength = Math.max(0, Math.min(3, (options && options.strength)|0 || 2));
    const thicken = Math.max(0, Math.min(2, (options && options.thicken)|0 || 1));
    const thin = Math.max(0, Math.min(2, (options && options.thin)|0 || 0));
    const bgEq = !!(options && options.bgEq);
    const upscale = !!(options && options.upscale);
    if(report) report(10);
    let gray = new cv.Mat(); cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);
    if(bgEq){
      // Background normalization pre-pass
      const kSize = 61; const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(kSize, kSize));
      const bg = new cv.Mat(); cv.morphologyEx(gray, bg, cv.MORPH_OPEN, kernel);
    const fGray = new cv.Mat(); let fBg = new cv.Mat(); gray.convertTo(fGray, cv.CV_32F); bg.convertTo(fBg, cv.CV_32F);
      const eps = 1.0; { const epsMat=new cv.Mat(fBg.rows,fBg.cols,fBg.type()); epsMat.setTo(new cv.Scalar(eps)); const sum=new cv.Mat(); cv.add(fBg, epsMat, sum); fBg.delete(); fBg=sum; epsMat.delete(); }
      const norm = new cv.Mat(); cv.divide(fGray, fBg, norm, 1.0);
      const norm2 = new cv.Mat(); cv.normalize(norm, norm2, 0, 255, cv.NORM_MINMAX);
      const out8 = new cv.Mat(); norm2.convertTo(out8, cv.CV_8U);
      gray.delete(); gray = out8;
      bg.delete(); kernel.delete(); fGray.delete(); fBg.delete(); norm.delete(); norm2.delete();
    }
    // Optional upscale to help tiny text
    let scale = 1;
    if(upscale){ const hi = new cv.Mat(); cv.resize(gray, hi, new cv.Size(gray.cols*2, gray.rows*2), 0, 0, cv.INTER_CUBIC); gray.delete(); gray = hi; scale=2; }
    if(report) report(25);
    // CLAHE for local contrast
    let eq = null; try{
      const tiles = 8 + strength*4; const clip = 2.0 + strength*1.0;
      const clahe = (cv.createCLAHE? cv.createCLAHE(clip, new cv.Size(tiles,tiles)) : new cv.CLAHE(clip, new cv.Size(tiles,tiles)));
      eq = new cv.Mat(); clahe.apply(gray, eq); try{ clahe.delete && clahe.delete(); }catch(_){ }
    }catch(_){ eq = gray.clone(); }
    if(report) report(45);
    // Stronger local binarization tuned for text
    const block = 9 + strength*4; const bsize = (block%2)?block:block+1; const C = 2 + strength*2;
    let bin = new cv.Mat(); cv.adaptiveThreshold(eq, bin, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, bsize, C);
    // Optional thinning/opening to reduce bleed
    if(thin>0){ const k = 1 + thin*2; const kx = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(k,k)); const tmp = new cv.Mat(); cv.morphologyEx(bin, tmp, cv.MORPH_OPEN, kx); bin.delete(); bin = tmp; kx.delete(); }
    // Optional thickening/closing to reconnect broken strokes
    if(thicken>0){ const k = 1 + thicken*2; const kx = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(k,k)); const tmp = new cv.Mat(); cv.morphologyEx(bin, tmp, cv.MORPH_CLOSE, kx); bin.delete(); bin = tmp; kx.delete(); }
    // Build text mask on (possibly upscaled) contrast image
    const tmask = buildTextMask(eq, { strength, upscale });
    if(report) report(70);
    // Build stroke mask (text pixels) and restrict by text-region mask; keep background untouched
    // Ensure sizes match original src
    let binUse = bin;
    let maskUse = tmask;
    if(scale!==1){
      const downBin = new cv.Mat(); cv.resize(bin, downBin, new cv.Size(src.cols, src.rows), 0,0, cv.INTER_NEAREST);
      const downM = new cv.Mat(); cv.resize(tmask, downM, new cv.Size(src.cols, src.rows), 0,0, cv.INTER_NEAREST);
      bin.delete(); binUse = downBin; tmask.delete(); maskUse = downM;
    }
    const strokeMask = new cv.Mat(); // 255 where text strokes are
    cv.bitwise_not(binUse, strokeMask); // bin had background=255, text=0
    const paintMask = new cv.Mat();
    cv.bitwise_and(strokeMask, maskUse, paintMask);
    // Paint strokes black on RGBA source, leave background as-is
    src.setTo(new cv.Scalar(0,0,0,255), paintMask);
    if(report) report(100);
    gray.delete(); eq.delete();
    try{ if(binUse!==bin) binUse.delete(); }catch(_){ }
    try{ bin.delete(); }catch(_){ }
    try{ strokeMask.delete(); }catch(_){ }
    try{ paintMask.delete(); }catch(_){ }
    try{ maskUse.delete(); }catch(_){ }
    return matToImagePayload(src);
  } finally { src.delete(); }
}

// Alternative: Sauvola local thresholding for text
function opTextEnhanceSauvola(srcRGBA, report, options){
  const src = toMatRGBA(srcRGBA);
  try{
    const strength = Math.max(0, Math.min(3, (options && options.strength)|0 || 2));
    const thin = Math.max(0, Math.min(2, (options && options.thin)|0 || 0));
    const thicken = Math.max(0, Math.min(2, (options && options.thicken)|0 || 1));
    const bgEq = !!(options && options.bgEq);
    const upscale = !!(options && options.upscale);
    const maxSpeck = Math.max(0, Math.min(5000, (options && options.maxSpeck)|0 || 0));
    if(report) report(10);
    let gray = new cv.Mat(); cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);
    if(bgEq){
      const kSize = 61; const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(kSize, kSize));
      const bg = new cv.Mat(); cv.morphologyEx(gray, bg, cv.MORPH_OPEN, kernel);
      const fGray = new cv.Mat(); let fBg = new cv.Mat(); gray.convertTo(fGray, cv.CV_32F); bg.convertTo(fBg, cv.CV_32F);
      const eps = 1.0; { const epsMat=new cv.Mat(fBg.rows,fBg.cols,fBg.type()); epsMat.setTo(new cv.Scalar(eps)); const sum=new cv.Mat(); cv.add(fBg, epsMat, sum); fBg.delete(); fBg=sum; epsMat.delete(); }
      const norm = new cv.Mat(); cv.divide(fGray, fBg, norm, 1.0);
      const norm2 = new cv.Mat(); cv.normalize(norm, norm2, 0, 255, cv.NORM_MINMAX);
      const out8 = new cv.Mat(); norm2.convertTo(out8, cv.CV_8U);
      gray.delete(); gray = out8;
      bg.delete(); kernel.delete(); fGray.delete(); fBg.delete(); norm.delete(); norm2.delete();
    }
    // Optional upscale to help tiny text
    let scale = 1;
    if(upscale){ const hi = new cv.Mat(); cv.resize(gray, hi, new cv.Size(gray.cols*2, gray.rows*2), 0, 0, cv.INTER_CUBIC); gray.delete(); gray = hi; scale=2; }
    if(report) report(30);
    // Mild sharpening (unsharp mask)
    const blurred = new cv.Mat(); cv.GaussianBlur(gray, blurred, new cv.Size(0,0), 1.0, 1.0, cv.BORDER_DEFAULT);
    const sharp = new cv.Mat(); cv.addWeighted(gray, 1.2, blurred, -0.2, 0, sharp); blurred.delete(); gray.delete(); gray=sharp;
    // Sauvola threshold
    const win = Math.max(9, 15 + strength*8); const bsize = (win%2)?win:win+1; const kval = 0.34 + strength*0.06; // 0.34..0.52
    const f32 = new cv.Mat(); gray.convertTo(f32, cv.CV_32F);
    const mean = new cv.Mat(); cv.blur(f32, mean, new cv.Size(bsize,bsize));
    const sq = new cv.Mat(); cv.multiply(f32, f32, sq);
    const mean2 = new cv.Mat(); cv.blur(sq, mean2, new cv.Size(bsize,bsize));
    const mm = new cv.Mat(); cv.multiply(mean, mean, mm);
    const variance = new cv.Mat(); cv.subtract(mean2, mm, variance);
    const stddev = new cv.Mat(); cv.sqrt(variance, stddev);
    const R = new cv.Mat(stddev.rows, stddev.cols, stddev.type(), new cv.Scalar(128.0));
    const sOverR = new cv.Mat(); cv.divide(stddev, R, sOverR);
    const one = new cv.Mat(sOverR.rows, sOverR.cols, sOverR.type(), new cv.Scalar(1.0));
    const sTerm = new cv.Mat(); cv.subtract(sOverR, one, sTerm); // (s/R - 1)
    const kMat = new cv.Mat(sTerm.rows, sTerm.cols, sTerm.type(), new cv.Scalar(kval));
    const kTerm = new cv.Mat(); cv.multiply(kMat, sTerm, kTerm); // k*(s/R - 1)
    const base = new cv.Mat(); cv.add(one, kTerm, base); // 1 + ...
    const T = new cv.Mat(); cv.multiply(mean, base, T); // m*(...)
    let bin = new cv.Mat(); cv.compare(f32, T, bin, cv.CMP_GT); // 255 for background

    // Optional despeckle: remove tiny dark specks (isolated black dots)
    if(maxSpeck > 0){
      // Invert so foreground (text/specks) = 255, background = 0 for CC stats
      const inv = new cv.Mat(); cv.bitwise_not(bin, inv);
      const labels = new cv.Mat(); const stats = new cv.Mat(); const cents = new cv.Mat();
      const num = cv.connectedComponentsWithStats(inv, labels, stats, cents, 8, cv.CV_32S);
      const keep = cv.Mat.zeros(inv.rows, inv.cols, cv.CV_8UC1);
      for(let i=1;i<num;i++){
        const a = stats.intPtr(i, cv.CC_STAT_AREA)[0];
        if(a >= maxSpeck){
          const x = stats.intPtr(i, cv.CC_STAT_LEFT)[0];
          const y = stats.intPtr(i, cv.CC_STAT_TOP)[0];
          const w = stats.intPtr(i, cv.CC_STAT_WIDTH)[0];
          const h = stats.intPtr(i, cv.CC_STAT_HEIGHT)[0];
          const roiLabels = labels.roi(new cv.Rect(x,y,w,h));
          const roiMask = keep.roi(new cv.Rect(x,y,w,h));
          const low = new cv.Mat(roiLabels.rows, roiLabels.cols, roiLabels.type(), new cv.Scalar(i));
          const high = new cv.Mat(roiLabels.rows, roiLabels.cols, roiLabels.type(), new cv.Scalar(i));
          const cmp = new cv.Mat(); cv.inRange(roiLabels, low, high, cmp); cmp.copyTo(roiMask);
          roiLabels.delete(); roiMask.delete(); cmp.delete(); low.delete(); high.delete();
        }
      }
      // Re-invert so background=255, text=0, but without tiny specks
      const cleanedInv = new cv.Mat(); cv.bitwise_not(keep, cleanedInv);
      bin.delete(); bin = cleanedInv;
      inv.delete(); labels.delete(); stats.delete(); cents.delete(); keep.delete();
    }

    // Optional morphology to clean edges
    if(thin>0){ const k = 1 + thin*2; const kx = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(k,k)); const tmp = new cv.Mat(); cv.morphologyEx(bin, tmp, cv.MORPH_OPEN, kx); bin.delete(); bin = tmp; kx.delete(); }
    if(thicken>0){ const k = 1 + thicken*2; const kx = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(k,k)); const tmp = new cv.Mat(); cv.morphologyEx(bin, tmp, cv.MORPH_CLOSE, kx); bin.delete(); bin = tmp; kx.delete(); }
    // Build text-region mask similar to regular Text Enhance
    const tmask = buildTextMask(gray, { strength, upscale });
    let binUse = bin; let maskUse = tmask;
    if(scale!==1){
      const down = new cv.Mat(); cv.resize(bin, down, new cv.Size(src.cols, src.rows), 0,0, cv.INTER_NEAREST);
      const downM = new cv.Mat(); cv.resize(tmask, downM, new cv.Size(src.cols, src.rows), 0,0, cv.INTER_NEAREST);
      bin.delete(); binUse = down; tmask.delete(); maskUse = downM;
    }

  }
  // Return as array of polylines (each edge's points). Caller may merge or simplify.
  const paths = comp.map(ei=>{
    const pts = edges[ei].points||[]; return pts;
  });
  return paths;
}

// --- Text mask and enhancement ---
function buildTextMask(gray, options){
  // Detect likely text as dark, relatively small blobs on light background.
  const strength = Math.max(0, Math.min(3, (options && options.strength)|0 || 2));
  const kSize = Math.max(7, Math.min(25, 11 + strength*4));
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(kSize, kSize));
  const bh = new cv.Mat(); cv.morphologyEx(gray, bh, cv.MORPH_BLACKHAT, kernel);
  const mask = new cv.Mat(); cv.threshold(bh, mask, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
  const open = new cv.Mat(); const k3 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3,3)); cv.morphologyEx(mask, open, cv.MORPH_OPEN, k3);
  // Filter connected components to keep text-like sizes
  const labels = new cv.Mat(); const stats = new cv.Mat(); const cents = new cv.Mat();
  const num = cv.connectedComponentsWithStats(open, labels, stats, cents, 8, cv.CV_32S);
  const out = cv.Mat.zeros(mask.rows, mask.cols, cv.CV_8UC1);
  const areaScale = (options && options.upscale)?4:1;
  const minA = 8*areaScale, maxA = Math.max(2000*areaScale, ((gray.rows*gray.cols)|0)/(200/areaScale));
  for(let i=1;i<num;i++){
    const a = stats.intPtr(i, cv.CC_STAT_AREA)[0];
    const w = stats.intPtr(i, cv.CC_STAT_WIDTH)[0];
    const h = stats.intPtr(i, cv.CC_STAT_HEIGHT)[0];
    if(a>=minA && a<=maxA && w>=2 && h>=2){
      const rect = new cv.Rect(stats.intPtr(i, cv.CC_STAT_LEFT)[0], stats.intPtr(i, cv.CC_STAT_TOP)[0], w, h);
      const roi = out.roi(rect); roi.setTo(new cv.Scalar(255)); roi.delete();
    }
  }
  kernel.delete(); bh.delete(); mask.delete(); open.delete(); labels.delete(); stats.delete(); cents.delete();
  return out;
}

function opTextEnhance(srcRGBA, report, options){
  const src = toMatRGBA(srcRGBA);
  try{
    const strength = Math.max(0, Math.min(3, (options && options.strength)|0 || 2));
    const thicken = Math.max(0, Math.min(2, (options && options.thicken)|0 || 1));
    const thin = Math.max(0, Math.min(2, (options && options.thin)|0 || 0));
    const bgEq = !!(options && options.bgEq);
    const upscale = !!(options && options.upscale);
    if(report) report(10);
    let gray = new cv.Mat(); cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);
    if(bgEq){
      // Background normalization pre-pass
      const kSize = 61; const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(kSize, kSize));
      const bg = new cv.Mat(); cv.morphologyEx(gray, bg, cv.MORPH_OPEN, kernel);
      const fGray = new cv.Mat(); const fBg = new cv.Mat(); gray.convertTo(fGray, cv.CV_32F); bg.convertTo(fBg, cv.CV_32F);
      const eps = 1.0; { const epsMat=new cv.Mat(fBg.rows,fBg.cols,fBg.type()); epsMat.setTo(new cv.Scalar(eps)); const sum=new cv.Mat(); cv.add(fBg, epsMat, sum); fBg.delete(); fBg=sum; epsMat.delete(); }
      const norm = new cv.Mat(); cv.divide(fGray, fBg, norm, 1.0);
      const norm2 = new cv.Mat(); cv.normalize(norm, norm2, 0, 255, cv.NORM_MINMAX);
      const out8 = new cv.Mat(); norm2.convertTo(out8, cv.CV_8U);
      gray.delete(); gray = out8;
      bg.delete(); kernel.delete(); fGray.delete(); fBg.delete(); norm.delete(); norm2.delete();
    }
    // Optional upscale to help tiny text
    let scale = 1;
    if(upscale){ const hi = new cv.Mat(); cv.resize(gray, hi, new cv.Size(gray.cols*2, gray.rows*2), 0, 0, cv.INTER_CUBIC); gray.delete(); gray = hi; scale=2; }
    if(report) report(25);
    // CLAHE for local contrast
    let eq = null; try{
      const tiles = 8 + strength*4; const clip = 2.0 + strength*1.0;
      const clahe = (cv.createCLAHE? cv.createCLAHE(clip, new cv.Size(tiles,tiles)) : new cv.CLAHE(clip, new cv.Size(tiles,tiles)));
      eq = new cv.Mat(); clahe.apply(gray, eq); try{ clahe.delete && clahe.delete(); }catch(_){ }
    }catch(_){ eq = gray.clone(); }
    if(report) report(45);
    // Stronger local binarization tuned for text
    const block = 9 + strength*4; const bsize = (block%2)?block:block+1; const C = 2 + strength*2;
    let bin = new cv.Mat(); cv.adaptiveThreshold(eq, bin, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, bsize, C);
    // Optional thinning/opening to reduce bleed
    if(thin>0){ const k = 1 + thin*2; const kx = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(k,k)); const tmp = new cv.Mat(); cv.morphologyEx(bin, tmp, cv.MORPH_OPEN, kx); bin.delete(); bin = tmp; kx.delete(); }
    // Optional thickening/closing to reconnect broken strokes
    if(thicken>0){ const k = 1 + thicken*2; const kx = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(k,k)); const tmp = new cv.Mat(); cv.morphologyEx(bin, tmp, cv.MORPH_CLOSE, kx); bin.delete(); bin = tmp; kx.delete(); }
    // Build text mask on (possibly upscaled) contrast image
    const tmask = buildTextMask(eq, { strength, upscale });
    if(report) report(70);
    // Build stroke mask (text pixels) and restrict by text-region mask; keep background untouched
    // Ensure sizes match original src
    let binUse = bin;
    let maskUse = tmask;
    if(scale!==1){
      const downBin = new cv.Mat(); cv.resize(bin, downBin, new cv.Size(src.cols, src.rows), 0,0, cv.INTER_NEAREST);
      const downM = new cv.Mat(); cv.resize(tmask, downM, new cv.Size(src.cols, src.rows), 0,0, cv.INTER_NEAREST);
      bin.delete(); binUse = downBin; tmask.delete(); maskUse = downM;
    }
 main
    const strokeMask = new cv.Mat(); // 255 where text strokes are
    cv.bitwise_not(binUse, strokeMask); // bin had background=255, text=0
    const paintMask = new cv.Mat();
    cv.bitwise_and(strokeMask, maskUse, paintMask);
    // Paint strokes black on RGBA source, leave background as-is
    src.setTo(new cv.Scalar(0,0,0,255), paintMask);
    if(report) report(100);
 DevShgOpenCv
    // Cleanup
    f32.delete(); mean.delete(); sq.delete(); mean2.delete(); mm.delete(); variance.delete(); stddev.delete(); R.delete(); sOverR.delete(); one.delete(); sTerm.delete(); kMat.delete(); kTerm.delete(); base.delete(); T.delete();
    try{ if(binUse!==bin) binUse.delete(); }catch(_){ }

    gray.delete(); eq.delete();
    try{ if(binUse!==bin) binUse.delete(); }catch(_){ }
    try{ bin.delete(); }catch(_){ }
 main
    try{ strokeMask.delete(); }catch(_){ }
    try{ paintMask.delete(); }catch(_){ }
    try{ maskUse.delete(); }catch(_){ }
    return matToImagePayload(src);
  } finally { src.delete(); }
}
