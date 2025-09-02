// OpenCV worker: loads OpenCV.js off the main thread and performs CV ops.
// Messages:
//  - {type:'init'} => loads OpenCV (from CDN) and posts {type:'ready'}
//  - {type:'detectLine', roi:{data:ArrayBuffer,width,height,rx,ry}, click:{x,y}} => posts {type:'detectLine:result', seg:{x1,y1,x2,y2}|null}
//  - {type:'deskew'|'denoise'|'adaptive', image:{data:ArrayBuffer,width,height}} => posts {type:`<op>:result`, image:{data:ArrayBuffer,width,height}}
//  - {type:'buildGraph', id:string, image:{data,width,height}} => build per-page wire graph; posts {type:'buildGraph:result', id}
//  - {type:'tracePath', id:string, click:{x,y}, opts?:{stopAt?:boolean}} => posts {type:'tracePath:result', id, path:[{x,y},...]|null}

let ready = false;
// Cache of graphs per page id
const graphs = new Map();

function loadCV() {
  return new Promise((resolve, reject) => {
    if (ready) return resolve();
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
      case 'buildGraph': {
        const { id, image } = msg;
        const graph = buildWireGraph(image);
        graphs.set(id, graph);
        self.postMessage({ type: 'buildGraph:result', id });
        break;
      }
      case 'tracePath': {
        const { id, click, opts } = msg;
        const g = graphs.get(id);
        if (!g) { self.postMessage({ type:'tracePath:result', id, path:null }); break; }
        const path = tracePathFromClick(g, click.x, click.y, opts||{});
        self.postMessage({ type:'tracePath:result', id, path });
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

// -------------- Graph building --------------
function buildWireGraph(srcRGBA){
  // Returns {w,h, nodes:[{id,x,y,type,deg}], edges:[{a,b,points:[{x,y}]}]}
  const mat = toMatRGBA(srcRGBA);
  try{
    const gray = new cv.Mat(); cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY, 0);
    const bin = new cv.Mat();
    // Adaptive threshold is robust to uneven backgrounds
    cv.adaptiveThreshold(gray, bin, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 21, 15);
    // Light denoise and favor axis-aligned wires
    const kH = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5,1));
    const kV = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(1,5));
    const o1 = new cv.Mat(), o2 = new cv.Mat();
    cv.morphologyEx(bin, o1, cv.MORPH_OPEN, kH);
    cv.morphologyEx(bin, o2, cv.MORPH_OPEN, kV);
    const wires = new cv.Mat(); cv.bitwise_or(o1, o2, wires);
    // Convert to 0/1 bitmap and thin
    const w = wires.cols, h = wires.rows; const bytes = new Uint8Array(w*h);
    for(let y=0; y<h; y++){
      for(let x=0; x<w; x++){
        bytes[y*w+x] = wires.ucharPtr(y,x)[0] ? 1 : 0;
      }
    }
    zhangSuenThin(bytes, w, h);
    const {nodes, edges} = buildGraphFromSkeleton(bytes, w, h, gray);
    gray.delete(); bin.delete(); o1.delete(); o2.delete(); wires.delete();
    return { w, h, nodes, edges };
  } finally { mat.delete(); }
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


function tracePathFromClick(g, x, y, opts){
  // opts.stopAt: when true, stop at first node with deg != 2 (junction or terminal/symbol)
  if(!g || !g.edges || !g.edges.length) return null;
  const snapRadius = 12;
  let best = null;
  let bestD = 1e12;
  let bestIdx = -1;
  // Find nearest edge polyline point
  for(let ei=0; ei<g.edges.length; ei++){
    const e = g.edges[ei];
    const pts = e.points || [];
    for(let i=0;i<pts.length;i++){
      const dx = pts[i].x - x, dy = pts[i].y - y;
      const d = Math.hypot(dx, dy);
      if(d < bestD){ bestD = d; best = {ei, i}; }
    }
  }
  if(!best || bestD > snapRadius) return null;
  const e0 = g.edges[best.ei];
  const i0 = best.i;
  const path = [];
  // Helper to push a segment of points in [iStart..iEnd] inclusive
  const pushSegment = (pts, iStart, iEnd) => {
    if(iStart <= iEnd){
      for(let i=iStart;i<=iEnd;i++) path.push({x:pts[i].x|0, y:pts[i].y|0});
    } else {
      for(let i=iStart;i>=iEnd;i--) path.push({x:pts[i].x|0, y:pts[i].y|0});
    }
  };
  // Build adjacency if missing
  if(!g.adj){
    g.adj = new Map();
    for(let i=0;i<g.nodes.length;i++) g.adj.set(i, []);
    for(let ei=0;ei<g.edges.length;ei++){
      const e = g.edges[ei];
      g.adj.get(e.a).push(ei);
      g.adj.get(e.b).push(ei);
    }
  }
  const stopAt = !!(opts && opts.stopAt);
  // Determine which endpoint node is closer along the polyline from click
  const toA = i0; // distance in indices to start
  const toB = (e0.points.length-1) - i0; // to end
  const dirFirst = (toA <= toB) ? 'A' : 'B';
  const visit = new Set();

  function nodeDeg(nodeId){
    const n = g.nodes[nodeId]; return (n && typeof n.deg==='number') ? n.deg : (g.adj.get(nodeId)||[]).length;
  }

  function walkFromEdge(ei, toward){ // toward: 'A' or 'B'
    let e = g.edges[ei];
    let pts = e.points;
    if(toward === 'A'){
      pushSegment(pts, i0, 0);
      var nodeId = e.a;
    } else {
      pushSegment(pts, i0, pts.length-1);
      var nodeId = e.b;
    }
    // If not stopping, return full line in that direction (continue through deg==2 nodes)
    while(true){
      if(!stopAt){
        // Continue until dead end collecting points through degree-2 nodes
        const edgesAtNode = (g.adj.get(nodeId) || []).filter(k=>k!==ei);
        if(edgesAtNode.length!==1) break; // junction or end
        const nextEi = edgesAtNode[0];
        if(visit.has(nextEi)) break;
        visit.add(nextEi);
        const next = g.edges[nextEi];
        const forward = (next.a===nodeId) ? 'B' : 'A';
        const ptsN = next.points;
        if(forward==='B'){ pushSegment(ptsN, 0, ptsN.length-1); nodeId = next.b; }
        else { pushSegment(ptsN, ptsN.length-1, 0); nodeId = next.a; }
        ei = nextEi;
        continue;
      } else {
        // stopAt=true: stop when encountering first node with deg != 2
        const deg = nodeDeg(nodeId);
        if(deg !== 2) break;
        const edgesAtNode = (g.adj.get(nodeId) || []).filter(k=>k!==ei);
        if(edgesAtNode.length!==1) break;
        const nextEi = edgesAtNode[0];
        if(visit.has(nextEi)) break;
        visit.add(nextEi);
        const next = g.edges[nextEi];
        const nextForward = (next.a===nodeId) ? 'B' : 'A';
        const ptsN = next.points;
        if(nextForward==='B'){ pushSegment(ptsN, 0, ptsN.length-1); nodeId = next.b; }
        else { pushSegment(ptsN, ptsN.length-1, 0); nodeId = next.a; }
        ei = nextEi;
        continue;
      }
    }
  }

  // Walk both directions and merge (but avoid duplicating the starting point twice)
  walkFromEdge(best.ei, dirFirst);
  const len1 = path.length;
  // reset starting index for opposite direction
  walkFromEdge(best.ei, dirFirst==='A'?'B':'A');
  // Deduplicate consecutive identical points
  const dedup = [];
  for(let i=0;i<path.length;i++){
    if(i===0 || path[i].x!==path[i-1].x || path[i].y!==path[i-1].y){
      dedup.push(path[i]);
    }
  }
  return dedup.length>=2 ? dedup : null;
}
for(const e of graph.edges){ const pts=e.points; for(let i=0;i<pts.length-1;i++){ const d=distToSeg(x,y, pts[i].x,pts[i].y, pts[i+1].x,pts[i+1].y); if(d<bestD){ bestD=d; best=e } } }
  if(!best) return null;
  // Return path from a to b (full edge). Caller can downsample or map to world coords.
  return best.points;
}
