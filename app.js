// Schematic Studio — v2 from scratch
// Single-file module orchestrating UI, viewer, tools, and persistence.

/*
  High-level architecture
  - App: bootstraps UI and wires events
  - State: pages, annotations, layers, enhancements, scale calibration
  - Viewer: high-perf canvas with zoom/pan and overlay rendering
  - Tools: pan, annotate (rect/text/arrow), measure, calibrate
  - IO: import images (drag/drop/input), export/import project JSON
*/

const $$ = (sel, root=document) => root.querySelector(sel);
const $$$ = (sel, root=document) => [...root.querySelectorAll(sel)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const DPR = () => (window.devicePixelRatio || 1);
// Simple debounce to coalesce rapid inputs
const debounce = (fn, delay=80) => { let t; return function(...args){ clearTimeout(t); t = setTimeout(()=>fn.apply(this, args), delay) } };
// Safe UUID generator (fallback if crypto.randomUUID is unavailable)
const uuid = () => {
  try{ if(typeof crypto!=='undefined' && typeof crypto.randomUUID==='function') return crypto.randomUUID() }catch(_){ }
  try{
    if(typeof crypto!=='undefined' && typeof crypto.getRandomValues==='function'){
      const b=new Uint8Array(16); crypto.getRandomValues(b);
      b[6]=(b[6]&0x0f)|0x40; b[8]=(b[8]&0x3f)|0x80;
      const h=[...b].map(x=>x.toString(16).padStart(2,'0'));
      return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h[10]}${h[11]}${h[12]}${h[13]}${h[14]}${h[15]}`;
    }
  }catch(_){ }
  let d=Date.now();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c=>{
    const r = (d + Math.random()*16) % 16 | 0; d=Math.floor(d/16);
    return (c==='x'?r:(r&0x3)|0x8).toString(16);
  });
};

class Emitter {
  constructor(){this.map=new Map()}
  on(t,fn){const a=this.map.get(t)||[];a.push(fn);this.map.set(t,a);return()=>this.off(t,fn)}
  off(t,fn){const a=this.map.get(t)||[];const i=a.indexOf(fn);if(i>=0)a.splice(i,1)}
  emit(t,p){(this.map.get(t)||[]).forEach(f=>{try{f(p)}catch(e){console.error(e)}})}
}

class PageImage {
  constructor(id, name, bitmap){
    this.id = id;
    this.name = name;
    this.bitmap = bitmap; // ImageBitmap (source of truth)
    this.processedCanvas = null; // Offscreen rendering for enhancements
    this.thumbDataUrl = null; // for sidebar
    this.enhance = {brightness:0, contrast:0, threshold:0, invert:false, grayscale:false, sharpen:0};
    this.layers = [ { id: 'default', name: 'Default', visible:true } ];
    this.activeLayerId = 'default';
    this.annotations = []; // [{id,type,layerId, points:[{x,y}], text, props}]
    this.scale = { // pixels per unit
      unit: 'in', // in, cm, mm
      pixelsPerUnit: 10,
    };
    this.vectorOverlayUrl = null; // object URL for SVG preview
    this.vectorOverlayOpts = null;
  }
}

class AppState extends Emitter {
  constructor(){
    super();
    this.pages = []; // PageImage[]
    this.current = -1;
  }
  get page(){return this.pages[this.current] || null}
  addPage(name, bitmap){
    const id = uuid();
    const p = new PageImage(id, name, bitmap);
    this.pages.push(p); this.current = this.pages.length - 1; this.emit('pages',null);
    return p;
  }
  removePage(id){
    const idx = this.pages.findIndex(p=>p.id===id);
    if(idx>=0){ this.pages.splice(idx,1); if(this.current>=this.pages.length) this.current=this.pages.length-1; this.emit('pages',null); }
  }
  setCurrent(idx){ this.current = clamp(idx,0,this.pages.length-1); this.emit('current',null) }
}

class Viewer extends Emitter {
  constructor(root){
    super();
    this.root = root;
    this.wrap = $$('.canvas-wrap', root);
    this.canvas = document.createElement('canvas');
    this.overlay = document.createElement('canvas');
    this.overlay.className = 'overlay';
    this.wrap.appendChild(this.canvas);
    this.wrap.appendChild(this.overlay);
    this.svgLayer = document.createElement('img');
    this.svgLayer.className = 'vector-overlay';
    Object.assign(this.svgLayer.style, { position:'absolute', left:'0', top:'0', pointerEvents:'none', display:'none' });
    this.wrap.appendChild(this.svgLayer);
    this.ctx = this.canvas.getContext('2d', { alpha:false, desynchronized:true });
    this.octx = this.overlay.getContext('2d');
    this.w = this.h = 0;
    this.state = { x:0, y:0, scale:1 };
    this.minScale = 0.02; this.maxScale = 40;
    this.drag = null;
    this.hover = null;
    this.renderPending = false;
    this.fitWhenReady = true;
    this.log = (window.DEBUG_MEMO_LOG)||(()=>{});
    this._initEvents();
    this.resize();
  }
  resize(){
    const r = this.wrap.getBoundingClientRect();
    this.w = Math.max(1, r.width|0); this.h = Math.max(1, r.height|0);
    const d = DPR();
    [this.canvas, this.overlay].forEach(c=>{c.width=this.w*d; c.height=this.h*d; c.style.width=this.w+'px'; c.style.height=this.h+'px'});
    this.ctx.setTransform(d,0,0,d,0,0);
    this.octx.setTransform(d,0,0,d,0,0);
    this.requestRender();
  }
  setImage(page){ this.page = page; if(page?.bitmap){ this.log('viewer:setImage', {w:page.bitmap.width,h:page.bitmap.height}) } if(this.fitWhenReady) this.fit(); this.requestRender(); }
  setEnhance(){ this.requestRender(true); }
  screenToWorld(px,py){
    const {x,y,scale} = this.state; return { x:(px-x)/scale, y:(py-y)/scale };
  }
  worldToScreen(wx,wy){ const {x,y,scale}=this.state; return { x: wx*scale + x, y: wy*scale + y } }
  fit(){
    if(!this.page?.bitmap) return;
    const bw = this.page.bitmap.width, bh = this.page.bitmap.height;
    const pad = 20; const sw = this.w - pad*2, sh = this.h - pad*2;
    const s = Math.min(sw/bw, sh/bh); this.state.scale = clamp(s, this.minScale, this.maxScale);
    const cx = (this.w - bw*this.state.scale)/2; const cy = (this.h - bh*this.state.scale)/2;
    this.state.x = cx; this.state.y = cy; this.requestRender();
    try{ (window.DEBUG_MEMO_LOG||(()=>{}))('viewer:fit', {canvas:{w:this.w,h:this.h}, image:{w:bw,h:bh}, scale:this.state.scale}) }catch(_){ }
  }
  zoomAt(factor, cx, cy){
    const {x,y,scale} = this.state;
    const wx = (cx - x) / scale; const wy = (cy - y) / scale;
    const ns = clamp(scale*factor, this.minScale, this.maxScale);
    this.state.scale = ns;
    this.state.x = cx - wx*ns; this.state.y = cy - wy*ns;
    this.requestRender();
  }
  requestRender(force=false){
    if(this.renderPending && !force) return; this.renderPending=true;
    // Use rAF to batch visual updates to frame rate
    const cb = ()=>{ this.renderPending=false; this._render() };
    if('requestAnimationFrame' in window){ requestAnimationFrame(cb); }
    else { queueMicrotask(cb); }
  }
  clear(){ this.ctx.fillStyle = '#0b0e17'; this.ctx.fillRect(0,0,this.w,this.h); this.octx.clearRect(0,0,this.w,this.h); }
  _render(){
    this.clear(); const page = this.page; if(!page?.bitmap) return;
    const img = page.processedCanvas || page.bitmap;
    const {x,y,scale} = this.state;
    const dw = img.width * scale; const dh = img.height * scale;
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.drawImage(img, 0,0,img.width,img.height, x,y,dw,dh);
    // Position vector SVG overlay if present
    if(this.svgLayer && this.svgLayer.style.display!=='none'){
      this.svgLayer.style.width = img.width + 'px';
      this.svgLayer.style.height = img.height + 'px';
      this.svgLayer.style.transformOrigin = '0 0';
      this.svgLayer.style.transform = `translate(${x}px,${y}px) scale(${scale})`;
    }
    // Grid (optional subtle)
    this._drawGrid();
    // Annotations overlay
    this._drawAnnotations();
  }
  _drawGrid(){
    const {scale} = this.state; if(scale < 0.2) return;
    const step = 50; const {x,y} = this.state;
    const left = -x/scale, top = -y/scale; const right = (this.w-x)/scale, bottom=(this.h-y)/scale;
    const s = step; this.octx.save(); this.octx.strokeStyle='rgba(255,255,255,0.06)'; this.octx.lineWidth=1;
    this.octx.beginPath();
    for(let gx=Math.floor(left/s)*s; gx<right; gx+=s){ const p1=this.worldToScreen(gx,top); const p2=this.worldToScreen(gx,bottom); this.octx.moveTo(p1.x, p1.y); this.octx.lineTo(p2.x,p2.y) }
    for(let gy=Math.floor(top/s)*s; gy<bottom; gy+=s){ const p1=this.worldToScreen(left,gy); const p2=this.worldToScreen(right,gy); this.octx.moveTo(p1.x, p1.y); this.octx.lineTo(p2.x,p2.y) }
    this.octx.stroke(); this.octx.restore();
  }
  _drawAnnotations(){
    const page = this.page; if(!page) return; const anns = page.annotations;
    const ctx=this.octx; ctx.save(); ctx.lineWidth=1; ctx.font='12px ui-sans-serif';
    for(const a of anns){
      const layer = page.layers.find(l=>l.id===a.layerId); if(layer && !layer.visible) continue;
      switch(a.type){
        case 'rect': this._drawRect(a); break;
        case 'arrow': this._drawArrow(a); break;
        case 'text': this._drawText(a); break;
        case 'measure': this._drawMeasure(a); break;
        case 'symbol': this._drawSymbol(a); break;
        case 'highlight': this._drawHighlight(a); break;
      }
    }
    ctx.restore();
  }
  _p(pt){ return this.worldToScreen(pt.x, pt.y) }
  _drawRect(a){
    const ctx=this.octx; ctx.save(); ctx.strokeStyle=a.props?.color||'#6df2bf'; ctx.setLineDash(a.props?.dash?[4,4]:[]);
    const p1=this._p(a.points[0]), p2=this._p(a.points[1]); const x=Math.min(p1.x,p2.x), y=Math.min(p1.y,p2.y), w=Math.abs(p1.x-p2.x), h=Math.abs(p1.y-p2.y);
    ctx.strokeRect(x,y,w,h); ctx.restore();
  }
  _drawArrow(a){
    const ctx=this.octx; ctx.save(); ctx.strokeStyle=a.props?.color||'#4cc2ff'; ctx.fillStyle=ctx.strokeStyle; ctx.lineWidth=1.5;
    const p1=this._p(a.points[0]), p2=this._p(a.points[1]);
    ctx.beginPath(); ctx.moveTo(p1.x,p1.y); ctx.lineTo(p2.x,p2.y); ctx.stroke();
    const ang=Math.atan2(p2.y-p1.y,p2.x-p1.x); const size=8;
    ctx.beginPath(); ctx.moveTo(p2.x,p2.y); ctx.lineTo(p2.x-size*Math.cos(ang-0.4), p2.y-size*Math.sin(ang-0.4));
    ctx.lineTo(p2.x-size*Math.cos(ang+0.4), p2.y-size*Math.sin(ang+0.4)); ctx.closePath(); ctx.fill();
    ctx.restore();
  }
  _drawText(a){
    const ctx=this.octx; ctx.save();
    const color=a.props?.color||'#000000';
    const size=Math.max(6, +(a.props?.size||13));
    ctx.fillStyle=color; ctx.strokeStyle='#0009'; ctx.lineWidth=Math.max(2, size*0.18);
    const p=this._p(a.points[0]); const text=a.text||''; ctx.font=`${size}px ui-sans-serif`;
    ctx.strokeText(text, p.x+1, p.y+1); ctx.fillText(text, p.x, p.y);
    if(this.selectedId && a.id===this.selectedId){
      // draw a subtle selection box
      const w = ctx.measureText(text).width; const h = size*1.2;
      ctx.save(); ctx.strokeStyle='#4cc2ff'; ctx.setLineDash([4,3]);
      ctx.strokeRect(p.x-3, p.y-h+4, w+6, h+4);
      ctx.restore();
    }
    ctx.restore();
  }
  _drawHighlight(a){
    const ctx=this.octx; ctx.save();
    const color=a.props?.color||'#ffd166';
    ctx.strokeStyle=color; ctx.lineWidth=a.props?.width||4; ctx.lineCap='round';
    { // apply UI alpha (Transparency slider is 0..100, where 0 = opaque)
      const t = +(this.hlAlpha?.value||0);
      const alpha = Math.max(0, Math.min(1, 1 - (t/100)));
      ctx.globalAlpha = alpha;
    }
    ctx.shadowColor=color; ctx.shadowBlur=8;
    const pts=a.points||[]; if(pts.length<2){ ctx.restore(); return }
    ctx.beginPath();
    const p0=this._p(pts[0]); ctx.moveTo(p0.x,p0.y);
    for(let i=1;i<pts.length;i++){ const p=this._p(pts[i]); ctx.lineTo(p.x,p.y) }
    ctx.stroke();
    ctx.restore();
  }
  _drawMeasure(a){
    const ctx=this.octx; ctx.save(); ctx.strokeStyle='#e8ecf1'; ctx.fillStyle='#e8ecf1';
    const p1=this._p(a.points[0]), p2=this._p(a.points[1]);
    ctx.setLineDash([6,4]); ctx.beginPath(); ctx.moveTo(p1.x,p1.y); ctx.lineTo(p2.x,p2.y); ctx.stroke(); ctx.setLineDash([]);
    const midx=(p1.x+p2.x)/2, midy=(p1.y+p2.y)/2; const text=a.props?.label||'';
    if(text){ ctx.font='12px ui-sans-serif'; ctx.fillStyle='#0b0e17'; ctx.strokeStyle='#e8ecf1';
      const pad=4; const w=ctx.measureText(text).width+pad*2; const h=18;
      ctx.beginPath(); ctx.roundRect(midx-w/2, midy-20, w, h, 6); ctx.fill(); ctx.stroke();
      ctx.fillStyle='#e8ecf1'; ctx.fillText(text, midx-w/2+pad, midy-6);
    }
    ctx.restore();
  }
  _drawSymbol(a){
    const ctx=this.octx; const p=a.points[0]||{x:0,y:0}; const kind=(a.props&&a.props.kind)||'resistor'; const angle=(a.props&&a.props.angle)||0; const scale=(a.props&&a.props.scale)||1;
    const sp=this.worldToScreen(p.x,p.y); ctx.save(); ctx.translate(sp.x, sp.y); ctx.rotate(angle*Math.PI/180); ctx.scale(scale, scale);
    const color = a.props?.color || '#000000';
    ctx.lineWidth=2; ctx.strokeStyle=color; ctx.fillStyle=color;
    const L=36, H=18;
    const drawRes=()=>{ ctx.beginPath(); ctx.moveTo(-L,0); ctx.lineTo(-12,0); ctx.moveTo(12,0); ctx.lineTo(L,0); ctx.moveTo(-12,0); ctx.lineTo(-6,-8); ctx.lineTo(0,8); ctx.lineTo(6,-8); ctx.lineTo(12,0); ctx.stroke(); };
    const drawCap=()=>{ ctx.beginPath(); ctx.moveTo(-L,0); ctx.lineTo(-8,0); ctx.moveTo(8,0); ctx.lineTo(L,0); ctx.moveTo(-8,-H/2); ctx.lineTo(-8,H/2); ctx.moveTo(8,-H/2); ctx.lineTo(8,H/2); ctx.stroke(); };
    const drawInd=()=>{ ctx.beginPath(); ctx.moveTo(-L,0); ctx.lineTo(-12,0); for(let i=0;i<4;i++){ const x=-12+i*8; ctx.moveTo(x,0); ctx.arc(x+4,0,4,Math.PI,0,false); } ctx.moveTo(20,0); ctx.lineTo(L,0); ctx.stroke(); };
    const drawDiode=()=>{ ctx.beginPath(); ctx.moveTo(-L,0); ctx.lineTo(-10,0); ctx.moveTo(10,0); ctx.lineTo(L,0); ctx.moveTo(-10,-10); ctx.lineTo(10,0); ctx.lineTo(-10,10); ctx.closePath(); ctx.stroke(); ctx.beginPath(); ctx.moveTo(10,-10); ctx.lineTo(10,10); ctx.stroke(); };
    const drawNPN=()=>{ ctx.beginPath(); ctx.moveTo(-L,0); ctx.lineTo(-8,0); ctx.moveTo(20,0); ctx.lineTo(L,0); ctx.beginPath(); ctx.arc(6,0,12,0,Math.PI*2); ctx.stroke(); ctx.beginPath(); ctx.moveTo(-8,0); ctx.lineTo(0,0); ctx.stroke(); ctx.beginPath(); ctx.moveTo(12,6); ctx.lineTo(18,10); ctx.moveTo(12,6); ctx.lineTo(14,12); ctx.stroke(); };
    const drawPNP=()=>{ ctx.beginPath(); ctx.moveTo(-L,0); ctx.lineTo(-8,0); ctx.moveTo(20,0); ctx.lineTo(L,0); ctx.beginPath(); ctx.arc(6,0,12,0,Math.PI*2); ctx.stroke(); ctx.beginPath(); ctx.moveTo(-8,0); ctx.lineTo(0,0); ctx.stroke(); ctx.beginPath(); ctx.moveTo(14,12); ctx.lineTo(12,6); ctx.moveTo(12,6); ctx.lineTo(18,10); ctx.stroke(); };
    const drawGnd=()=>{ ctx.beginPath(); ctx.moveTo(0,-10); ctx.lineTo(0,0); ctx.moveTo(-12,0); ctx.lineTo(12,0); ctx.moveTo(-8,4); ctx.lineTo(8,4); ctx.moveTo(-4,8); ctx.lineTo(4,8); ctx.stroke(); };
    const drawVcc=()=>{ ctx.beginPath(); ctx.moveTo(0,10); ctx.lineTo(0,0); ctx.moveTo(0,0); ctx.lineTo(-6,6); ctx.moveTo(0,0); ctx.lineTo(6,6); ctx.stroke(); };
    const drawLED=()=>{ drawDiode(); ctx.beginPath(); ctx.moveTo(14,-2); ctx.lineTo(22,-10); ctx.moveTo(10,2); ctx.lineTo(18,-6); ctx.stroke(); };
    const drawOpamp=()=>{ ctx.beginPath(); ctx.moveTo(-20,-12); ctx.lineTo(-20,12); ctx.lineTo(20,0); ctx.closePath(); ctx.stroke(); ctx.beginPath(); ctx.moveTo(-30,-6); ctx.lineTo(-20,-6); ctx.moveTo(-30,6); ctx.lineTo(-20,6); ctx.moveTo(20,0); ctx.lineTo(34,0); ctx.stroke(); };
    const drawSwitch=()=>{ ctx.beginPath(); ctx.moveTo(-L,8); ctx.lineTo(-10,8); ctx.moveTo(-10,8); ctx.lineTo(10,-4); ctx.moveTo(10,-4); ctx.lineTo(L,-4); ctx.stroke(); };
    const drawBattery=()=>{ ctx.beginPath(); ctx.moveTo(-L,0); ctx.lineTo(-10,0); ctx.moveTo(10,0); ctx.lineTo(L,0); ctx.moveTo(-10,-10); ctx.lineTo(-10,10); ctx.moveTo(10,-14); ctx.lineTo(10,14); ctx.stroke(); };
    const drawConnector=()=>{ ctx.beginPath(); ctx.arc(0,0,6,0,Math.PI*2); ctx.stroke(); ctx.beginPath(); ctx.moveTo(-L,0); ctx.lineTo(-6,0); ctx.moveTo(6,0); ctx.lineTo(L,0); ctx.stroke(); };
    switch(kind){
      case 'capacitor': drawCap(); break;
      case 'inductor': drawInd(); break;
      case 'diode': drawDiode(); break;
      case 'led': drawLED(); break;
      case 'npn': drawNPN(); break;
      case 'pnp': drawPNP(); break;
      case 'ground': drawGnd(); break;
      case 'vcc':
      case '5v':
      case '3v3': drawVcc(); break;
      case 'opamp': drawOpamp(); break;
      case 'switch': drawSwitch(); break;
      case 'battery': drawBattery(); break;
      case 'connector': drawConnector(); break;
      case 'resistor': default: drawRes(); break;
    }
    if(a.props && a.props.label){ ctx.save(); ctx.fillStyle='#e8ecf1'; ctx.font='11px ui-sans-serif'; ctx.textAlign='center'; ctx.fillText(String(a.props.label), 0, H+12); ctx.restore(); }
    if(this.selectedId && a.id===this.selectedId){ ctx.save(); ctx.strokeStyle='#4cc2ff'; ctx.setLineDash([4,3]); ctx.strokeRect(-L-6,-H-6,(L+6)*2,(H+6)*2); ctx.restore(); }
    ctx.restore();
  }
  
  _initEvents(){
    window.addEventListener('resize', ()=>this.resize());
    // Pointer events for pan + tool delegation
    this.overlay.style.pointerEvents='auto';
    this.overlay.addEventListener('contextmenu', e=>e.preventDefault());
    this.overlay.addEventListener('pointerdown', e=>{
      this.overlay.setPointerCapture(e.pointerId);
      const rect=this.overlay.getBoundingClientRect(); const px=e.clientX-rect.left, py=e.clientY-rect.top;
      const world=this.screenToWorld(px,py);
      this.emit('pointerdown', {e, px, py, world});
      const shouldPan = typeof this.shouldPan==='function' ? this.shouldPan() : true;
      // Pan with middle mouse always; left only if tool indicates panning
      if(e.button===1 || (e.button===0 && shouldPan)){
        e.preventDefault();
        this.drag = {startX:px, startY:py, ox:this.state.x, oy:this.state.y};
      }
    });
    this.overlay.addEventListener('pointermove', e=>{
      const rect=this.overlay.getBoundingClientRect(); const px=e.clientX-rect.left, py=e.clientY-rect.top;
      const world=this.screenToWorld(px,py);
      this.emit('pointermove', {e, px, py, world});
      if(this.drag){ this.state.x = this.drag.ox + (px - this.drag.startX); this.state.y = this.drag.oy + (py - this.drag.startY); this.requestRender(); }
    });
    const end=(e)=>{ this.emit('pointerup',{e}); this.drag=null; };
    this.overlay.addEventListener('pointerup', end);
    this.overlay.addEventListener('pointercancel', end);
    // Wheel zoom (Ctrl or two-finger trackpad)
    this.overlay.addEventListener('wheel', e=>{
      e.preventDefault();
      const rect=this.overlay.getBoundingClientRect(); const cx=e.clientX-rect.left, cy=e.clientY-rect.top;
      let factor = 1;
      const delta = (e.deltaY || 0);
      const z = Math.exp(-delta * 0.0015); // smooth zoom
      factor = z;
      if(!e.ctrlKey && Math.abs(delta)<5){ return; }
      this.zoomAt(factor, cx, cy);
    }, { passive:false });
    // Double click to zoom in
    this.overlay.addEventListener('dblclick', e=>{
      const rect=this.overlay.getBoundingClientRect(); const cx=e.clientX-rect.left, cy=e.clientY-rect.top;
      this.zoomAt(1.6, cx, cy);
    });
  }
}

// Enhancement pipeline (runs onto offscreen canvas when params change)
async function applyEnhancements(bitmap, params){
  const {brightness=0, contrast=0, threshold=0, invert=false, grayscale=false, sharpen=0} = params||{};
  const w = bitmap.width, h = bitmap.height;
  // cap processing size to keep responsive; scale down if too large while preserving effective resolution on display
  const maxPixels = 4_000_000; // ~4MP
  const scale = Math.min(1, Math.sqrt(maxPixels/(w*h)));
  const tw = Math.max(1, Math.round(w*scale)), th = Math.max(1, Math.round(h*scale));

  const off = document.createElement('canvas'); off.width = tw; off.height = th; const ctx = off.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bitmap, 0,0,w,h, 0,0,tw,th);
  let img = ctx.getImageData(0,0,tw,th); let d = img.data;

  // Precompute contrast factor
  const c = clamp(contrast, -100, 100); const cf = (259*(c+255))/(255*(259-c));
  const b = clamp(brightness, -100, 100);
  const thr = clamp(threshold, 0, 100);
  for(let i=0;i<d.length;i+=4){
    let r=d[i], g=d[i+1], bgr=d[i+2];
    // grayscale first if requested (luma)
    if(grayscale){ const l = (0.2126*r + 0.7152*g + 0.0722*bgr)|0; r=g=bgr=l }
    // brightness/contrast
    if(contrast||brightness){ r=cf*(r-128)+128 + b; g=cf*(g-128)+128 + b; bgr=cf*(bgr-128)+128 + b; }
    // invert
    if(invert){ r=255-r; g=255-g; bgr=255-bgr; }
    // threshold (binary) if set
    if(thr>0){ const l = (r+g+bgr)/3; const t = (thr/100)*255; const v = l>=t?255:0; r=g=bgr=v }
    d[i] = r<0?0:r>255?255:r; d[i+1] = g<0?0:g>255?255:g; d[i+2] = bgr<0?0:bgr>255?255:bgr;
  }
  ctx.putImageData(img,0,0);
  if(sharpen>0){ convolveSharpen(ctx, tw, th, sharpen) }
  // If scaled, upscale to original size without smoothing so pixels remain crisp
  if(scale!==1){
    const full = document.createElement('canvas'); full.width=w; full.height=h; const fctx=full.getContext('2d', { willReadFrequently: true }); fctx.imageSmoothingEnabled=false;
    fctx.drawImage(off,0,0,tw,th,0,0,w,h); return full;
  }
  return off;
}

function convolveSharpen(ctx, w, h, amount){
  const k = amount; // 0..100
  const a = clamp(k/100, 0, 1);
  // kernel = identity + a*(sharpen)
  const wImg = ctx.getImageData(0,0,w,h); const src=wImg.data; const out=ctx.createImageData(w,h); const dst=out.data;
  const idx=(x,y)=>((y*w+x)<<2);
  for(let y=1;y<h-1;y++){
    for(let x=1;x<w-1;x++){
      const i = idx(x,y); const c = idx(x,y);
      for(let ch=0;ch<3;ch++){
        const v = 5*src[c+ch] - src[idx(x-1,y)+ch] - src[idx(x+1,y)+ch] - src[idx(x,y-1)+ch] - src[idx(x,y+1)+ch];
        const nv = clamp(Math.round(src[c+ch]*(1-a) + v*a), 0, 255);
        dst[i+ch]=nv;
      }
      dst[i+3]=src[c+3];
    }


    if(this.cvAuto){
      this.cvAuto.addEventListener('click', async()=>{
        this._debug('btn:cv-auto:click',{});
        if(!await (async()=>{ if(window.cvWorker && window.cvWorkerReady) return true; try{ await loadOpenCV(this.cvLoad); return true }catch(e){ alert('Failed to load OpenCV'); return false } })()) return;
        const btn=this.cvAuto; const wasDisabled=!!btn.disabled; btn.classList.add('loading','determinate'); btn.disabled=true;
        const setP=(pct,label)=>{ try{ btn.style.setProperty('--progress', String(pct)); }catch(_){ } this._setStatusTask(`${label}�?� ${Math.round(pct)}%`); };
        const req1=uuid(), req2=uuid();
        const stopBatch = this._beginHistoryBatch && this._beginHistoryBatch('cv:auto-clean');
        const onMsg=(ev)=>{
          const d=ev.data||{}; if(d.type==='progress' && (d.reqId===req1||d.reqId===req2)){
            let pct=0, label='Auto Clean';
            if(d.op==='denoise'){ pct = (d.value||0)*0.45; label='Denoising'; }
            if(d.op==='adaptive'){ pct = 45 + (d.value||0)*0.45; label='Adaptive'; }
            setP(Math.max(0,Math.min(100,pct)), label);
          }
        };
        window.cvWorker && window.cvWorker.addEventListener('message', onMsg);
        try{
          await this._cvDenoise(req1);
          await this._cvAdaptive(req2);
          let targetSharp = +this.sharpen.value; if(!targetSharp || targetSharp===0){ targetSharp = 10; this.sharpen.value = targetSharp; this.sharpen.dispatchEvent(new Event('input',{bubbles:true})) }
          setP(92,'Sharpening');
          await this._applyEnhancements(this.state.page);
          try{ await this._cvEnsureGraphBuilt(this.state.page); }catch(_){ }
          this.viewer && this.viewer.requestRender(true);
          setP(100,'Done');
        } finally {
          try{ window.cvWorker && window.cvWorker.removeEventListener('message', onMsg) }catch(_){ }
          btn.classList.remove('determinate'); btn.style.removeProperty('--progress'); btn.classList.remove('loading');
          btn.disabled = wasDisabled;
          this._setStatusTask('Ready');
          this._debug('btn:cv-auto:done',{});
          try{ if(this.cvPreview?.checked) this._buildAndShowVectorOverlay(); }catch(_){ }
        }
      });
    }
  }
  ctx.putImageData(out,0,0);
}

// Simple persistence helpers
function download(filename, dataUrl){
  const a=document.createElement('a'); a.href=dataUrl; a.download=filename; a.click();
}
function toDataURL(blob){ return new Promise(res=>{ const r=new FileReader(); r.onload=()=>res(r.result); r.readAsDataURL(blob); }) }
async function makeZip(files){
  const enc = new TextEncoder();
  const records = [];
  let offset = 0; const chunks = [];
  const crcTable = (function(){
    let c, table = new Uint32Array(256);
    for(let n=0;n<256;n++){ c=n; for(let k=0;k<8;k++){ c = ((c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)); } table[n]=c>>>0; }
    return table;
  })();
  const crc32 = (buf)=>{ let c=0^(-1); for(let i=0;i<buf.length;i++){ c = (c>>>8) ^ crcTable[(c^buf[i]) & 0xff]; } return (c^(-1))>>>0 };
  const dosTime=()=>{ const d=new Date(); const time=((d.getHours()<<11)|(d.getMinutes()<<5)|((d.getSeconds()/2)|0))>>>0; const date=(((d.getFullYear()-1980)<<9)|((d.getMonth()+1)<<5)|d.getDate())>>>0; return {time,date}; };
  for(const f of files){
    const nameBytes = enc.encode(f.name);
    const data = new Uint8Array(await f.blob.arrayBuffer());
    const {time,date}=dosTime();
    const crc = crc32(data); const size = data.length;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0, true);
    lh.setUint16(8, 0, true);
    lh.setUint16(10, time, true); lh.setUint16(12, date, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, size, true); lh.setUint32(22, size, true);
    lh.setUint16(26, nameBytes.length, true); lh.setUint16(28, 0, true);
    chunks.push(new Uint8Array(lh.buffer)); chunks.push(nameBytes); chunks.push(data);
    records.push({nameBytes, crc, size, time, date, offset});
    offset += 30 + nameBytes.length + size;
  }
  const cdStart = offset;
  for(const r of records){
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true); cd.setUint16(6, 20, true);
    cd.setUint16(8, 0, true); cd.setUint16(10, 0, true);
    cd.setUint16(12, r.time, true); cd.setUint16(14, r.date, true);
    cd.setUint32(16, r.crc, true); cd.setUint32(20, r.size, true); cd.setUint32(24, r.size, true);
    cd.setUint16(28, r.nameBytes.length, true); cd.setUint16(30, 0, true); cd.setUint16(32, 0, true);
    cd.setUint16(34, 0, true); cd.setUint16(36, 0, true); cd.setUint32(38, 0, true);
    cd.setUint32(42, r.offset, true);
    chunks.push(new Uint8Array(cd.buffer)); chunks.push(r.nameBytes);
    offset += 46 + r.nameBytes.length;
  }
  const cdSize = offset - cdStart;
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true); eocd.setUint16(4, 0, true); eocd.setUint16(6, 0, true);
  eocd.setUint16(8, records.length, true); eocd.setUint16(10, records.length, true);
  eocd.setUint32(12, cdSize, true); eocd.setUint32(16, cdStart, true); eocd.setUint16(20, 0, true);
  chunks.push(new Uint8Array(eocd.buffer));
  return new Blob(chunks, {type:'application/zip'});
}
async function fileToBitmap(file){
  const lower = (file.name||'').toLowerCase();
  if(lower.endsWith('.tif') || lower.endsWith('.tiff')){
    try{
      await ensureUTIF();
      const buf = await file.arrayBuffer();
      const ifds = UTIF.decode(buf);
      if(!ifds || ifds.length===0) throw new Error('No TIFF frames');
      UTIF.decodeImage(buf, ifds[0]);
      const rgba = UTIF.toRGBA8(ifds[0]);
      const w = ifds[0].width, h = ifds[0].height;
      const c = document.createElement('canvas'); c.width=w; c.height=h; const ctx=c.getContext('2d');
      const imgData = new ImageData(new Uint8ClampedArray(rgba), w, h);
      ctx.putImageData(imgData, 0, 0);
      if('createImageBitmap' in window){ try{ return await createImageBitmap(c) }catch(_e){ return c } }
      return c;
    }catch(e){ console.error('TIFF decode failed', e) }
  }
  try{ return await createImageBitmap(file) }catch(_){
    try{
      const url = URL.createObjectURL(file);
      const img = await new Promise((res,rej)=>{ const im=new Image(); im.onload=()=>res(im); im.onerror=rej; im.src=url });
      const c=document.createElement('canvas'); c.width=img.naturalWidth||img.width; c.height=img.naturalHeight||img.height; c.getContext('2d').drawImage(img,0,0);
      if('createImageBitmap' in window){ try{ return await createImageBitmap(c) }catch(_e){ return c } } else { return c }
    }catch(e){ throw e }
  }
}

function ensureUTIF(){
  return new Promise((resolve, reject)=>{
    if(window.UTIF){ resolve(window.UTIF); return }
    const s=document.createElement('script'); s.src='https://unpkg.com/utif@3.1.0/UTIF.min.js'; s.async=true;
    s.onload=()=>window.UTIF?resolve(window.UTIF):reject(new Error('UTIF not available'));
    s.onerror=()=>reject(new Error('Failed to load UTIF'));
    document.head.appendChild(s);
  });
}

class AppUI {
  constructor(){
    this.root = document.body;
    this.state = new AppState();
    this.viewer = new Viewer($$('.main'));
    // Undo/Redo history
    this._undoStack = [];
    this._redoStack = [];
    this._historyLimit = 100;
    this._bindViewer();
    this._setupToolbar();
    this._setupLeft();
    this._setupRight();
    this._setupRightTabs();
    this._setupSplitters();
    this._setupDnD();
    this._setupStatus();
    this._setupToast();
    this._setupHelp();
    this._setupDebugPanel();
    this._wireState();
    this._setupAutosave();
    if(this._updateUndoRedoButtons) this._updateUndoRedoButtons();
  }
  _bindViewer(){
    this.state.on('current', ()=>{ this.viewer.setImage(this.state.page); this._renderLayers(); this._refreshStatus(); this._refreshThumbs() });
    this.state.on('pages', ()=>{ this._refreshThumbs(); this._refreshStatus(); this.viewer.setImage(this.state.page) });
    window.addEventListener('keydown', e=>this._hotkeys(e));
  }
  _setupToolbar(){
    this.openBtn = $$('#btn-open'); this.saveBtn=$$('#btn-save');
    this.undoBtn = $$('#btn-undo'); this.redoBtn=$$('#btn-redo');
    this.fitBtn = $$('#btn-fit'); this.zoomInBtn=$$('#btn-zoom-in'); this.zoomOutBtn=$$('#btn-zoom-out');
    this.panBtn=$$('#tool-pan'); this.rectBtn=$$('#tool-rect'); this.arrowBtn=$$('#tool-arrow'); this.textBtn=$$('#tool-text'); this.measureBtn=$$('#tool-measure');
    // Normalize toolbar icons (replace any garbled glyphs with inline SVG)
    const svg = {
      open: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h6l2 2h10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/><path d="M3 10h18l-2.5 8H5.5z"/></g></svg>',
      save: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v10"/><path d="M8 9l4 4 4-4"/><path d="M5 21h14"/></g></svg>',
      undo: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 7L4 12l5 5"/><path d="M20 12H5"/></g></svg>',
      redo: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 7l5 5-5 5"/><path d="M4 12h15"/></g></svg>',
      zoomIn: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="6"/><path d="M21 21l-4-4"/><path d="M11 8v6"/><path d="M8 11h6"/></g></svg>',
      zoomOut: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="6"/><path d="M21 21l-4-4"/><path d="M8 11h6"/></g></svg>',
      fit: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5"/><path d="M20 9V4h-5"/><path d="M4 15v5h5"/><path d="M20 15v5h-5"/></g></svg>',
      pan: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20"/><path d="M2 12h20"/></g></svg>',
      rect: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2" ry="2" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
      arrow: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h12"/><path d="M13 8l4 4-4 4"/></g></svg>',
      text: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16"/><path d="M12 6v12"/></g></svg>',
      measure: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 17h16"/><path d="M7 15v4"/><path d="M10 15v4"/><path d="M13 15v4"/><path d="M16 15v4"/><path d="M19 15v4"/></g></svg>',
      help: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.5 9a2.5 2.5 0 1 1 5 0c0 2-2.5 2-2.5 4"/><circle cx="12" cy="17" r="1"/></g></svg>'
    };
    const setIcon = (el, icon, label)=>{ if(!el) return; el.innerHTML = (icon||'') + (label? (' '+label) : ''); };
    setIcon(this.openBtn, svg.open, 'Open');
    setIcon(this.saveBtn, svg.save, 'Save');
    setIcon(this.undoBtn, svg.undo, 'Undo');
    setIcon(this.redoBtn, svg.redo, 'Redo');
    if(this.zoomOutBtn) setIcon(this.zoomOutBtn, svg.zoomOut, '');
    if(this.zoomInBtn) setIcon(this.zoomInBtn, svg.zoomIn, '');
    setIcon(this.fitBtn, svg.fit, 'Fit');
    setIcon(this.panBtn, svg.pan, 'Pan');
    setIcon(this.rectBtn, svg.rect, 'Rect');
    setIcon(this.arrowBtn, svg.arrow, 'Arrow');
    setIcon(this.textBtn, svg.text, 'Text');
    setIcon(this.measureBtn, svg.measure, 'Measure');
    // Ensure highlight tool button exists in DOM (inject if missing)
    this.highlightBtn=$$('#tool-highlight');
    if(!this.highlightBtn){
      const tb=$$('.tool-group.toolbox');
      if(tb){ const b=document.createElement('button'); b.id='tool-highlight'; b.title='Highlight line (6)'; b.innerHTML='<span class="i">==</span> Highlight'; tb.appendChild(b); this.highlightBtn=b; }
    }
    this.fileInput=$$('#file-input');
    const setTool = t=>{ this.tool=t; this.viewer.shouldPan = ()=> this.tool==='pan'; this._syncToolButtons() };
    const v=this.viewer;
    // Open is a <label for="file-input"> for broad browser support; keep a JS fallback too.
    this.openBtn.addEventListener('click', ()=> { try{ this.fileInput.showPicker?.() }catch(_){} });
    this.fileInput.addEventListener('change', async (e)=>{
      const files = [...(e.target.files||[])];
      if(files.length===0) return;
      this._debug('open:files', {count:files.length, names:files.map(f=>f.name)});
      await this._importFiles(files);
      e.target.value='';
    });
    this.saveBtn.addEventListener('click', ()=>this._exportProject());
    if(this.undoBtn){ this.undoBtn.addEventListener('click', ()=>this.undo()) }
    if(this.redoBtn){ this.redoBtn.addEventListener('click', ()=>this.redo()) }
    this.fitBtn.addEventListener('click', ()=>v.fit());
    this.zoomInBtn.addEventListener('click', ()=>v.zoomAt(1.25, v.w/2, v.h/2));
    this.zoomOutBtn.addEventListener('click', ()=>v.zoomAt(1/1.25, v.w/2, v.h/2));
    this.panBtn.addEventListener('click', ()=>setTool('pan'));
    this.rectBtn.addEventListener('click', ()=>setTool('rect'));
    this.arrowBtn.addEventListener('click', ()=>setTool('arrow'));
    this.textBtn.addEventListener('click', ()=>setTool('text'));
    this.measureBtn.addEventListener('click', ()=>setTool('measure'));
    if(this.highlightBtn){ this.highlightBtn.addEventListener('click', ()=>setTool('highlight')) }
    setTool('pan');
    const debugBtn = $$('#btn-debug'); if(debugBtn){ debugBtn.addEventListener('click', ()=>this._toggleDebug()) }
    const helpBtn = $$('#btn-help'); if(helpBtn){ setIcon(helpBtn, svg.help, 'Help'); }

    // Tool interactions bridged through viewer pointer events
    let drawing=null;
    // Selection/drag state for symbol/text
    this._selectedAnnId = this._selectedAnnId || null;
    this._dragSymbol = null;
    this._dragText = null;
    this.viewer.on('pointerdown', ({e, px, py, world})=>{
      if(!this.state.page) return;
      // Pick tests (symbol first, then text)
      const sym = this._pickSymbolAt(world.x, world.y);
      if(sym){
        e.preventDefault();
        this._selectedAnnId = sym.id; this.viewer.selectedId = sym.id;
        // prevent viewer pan for this gesture
        const prev = this.viewer.shouldPan; this.viewer.shouldPan = ()=>false;
        const offx = world.x - (sym.points[0]?.x||0), offy = world.y - (sym.points[0]?.y||0);
        this._dragSymbol = { id:sym.id, offx, offy, restore: prev };
        this.viewer.requestRender();
        this._syncTextControls && this._syncTextControls();
        return;
      }
      const txt = this._pickTextAt(world.x, world.y);
      if(txt){
        e.preventDefault();
        this._selectedAnnId = txt.id; this.viewer.selectedId = txt.id;
        const prev = this.viewer.shouldPan; this.viewer.shouldPan = ()=>false;
        const offx = world.x - (txt.points[0]?.x||0), offy = world.y - (txt.points[0]?.y||0);
        this._dragText = { id:txt.id, offx, offy, restore: prev };
        this.viewer.requestRender();
        this._syncTextControls && this._syncTextControls();
        return;
      }
      // Deselect if clicking empty space
      this._selectedAnnId = null; this.viewer.selectedId = null; this._syncTextControls && this._syncTextControls();
      if(this.tool==='pan') return; // viewer will pan by default
      e.preventDefault();
      if(this.tool==='highlight'){
        this._highlightAt(world).catch(err=>{ this._debug('highlight:error', String(err&&err.message||err)) });
        return;
      }
      if(this.tool==='text'){
        const text = prompt('Enter label text');
        if(text){ this._addAnnotation({type:'text', points:[world], text, props:{color:(this.symColor?.value||'#000000')}}); }
        return false;
      }
      // start two-point shapes
      drawing = { start: world, last: world };
    });
    this.viewer.on('pointermove', ({world})=>{
      if(this._dragSymbol){
        const ann = this._findAnnotationById(this._dragSymbol.id);
        if(ann){ ann.points[0].x = world.x - this._dragSymbol.offx; ann.points[0].y = world.y - this._dragSymbol.offy; this.viewer.requestRender(); }
        return;
      }
      if(this._dragText){
        const ann = this._findAnnotationById(this._dragText.id);
        if(ann){ ann.points[0].x = world.x - this._dragText.offx; ann.points[0].y = world.y - this._dragText.offy; this.viewer.requestRender(); }
        return;
      }
      if(!drawing) return; drawing.last = world; this._previewTwoPoint(drawing.start, drawing.last);
    });
    this.viewer.on('pointerup', ()=>{
      if(this._dragSymbol){
        // Commit move
        this._pushUndo('move-symbol');
        if(typeof this._dragSymbol.restore==='function'){ this.viewer.shouldPan = this._dragSymbol.restore; }
        this._dragSymbol=null; this._updateUndoRedoButtons && this._updateUndoRedoButtons();
        return;
      }
      if(this._dragText){
        this._pushUndo('move-text');
        if(typeof this._dragText.restore==='function'){ this.viewer.shouldPan = this._dragText.restore; }
        this._dragText=null; this._updateUndoRedoButtons && this._updateUndoRedoButtons();
        return;
      }
      if(!drawing) return; const {start,last}=drawing; drawing=null;
      if(this.tool==='rect') this._addAnnotation({type:'rect', points:[start,last], props:{color:'#6df2bf'}});
      if(this.tool==='arrow') this._addAnnotation({type:'arrow', points:[start,last], props:{color:'#4cc2ff'}});
      if(this.tool==='measure') this._addMeasure(start,last);
      this._clearPreview();
    });
  }
  _setupLeft(){
    this.thumbsWrap = $$('.thumbs');
  }
  _setupRight(){
    // Enhancement controls
    this.brightness=$$('#enh-bright'); this.contrast=$$('#enh-contrast'); this.threshold=$$('#enh-threshold'); this.invert=$$('#enh-invert'); this.gray=$$('#enh-gray'); this.sharpen=$$('#enh-sharpen');
    const apply = debounce(()=>this._applyEnhancements(), 100);
    // Begin a debounced history batch for slider drags
    const beginEnhHistory=()=>{ this._enhHistTimer && clearTimeout(this._enhHistTimer); if(!this._enhHistoryActive){ this._pushUndo('enhance'); this._enhHistoryActive=true; } };
    const endEnhHistory=()=>{ this._enhHistTimer && clearTimeout(this._enhHistTimer); this._enhHistTimer = setTimeout(()=>{ this._enhHistoryActive=false; this._updateUndoRedoButtons && this._updateUndoRedoButtons(); }, 700); };
    [this.brightness,this.contrast,this.threshold,this.sharpen].forEach(r=>{
      r.addEventListener('pointerdown', beginEnhHistory);
      r.addEventListener('touchstart', beginEnhHistory, {passive:true});
      r.addEventListener('input', apply);
      r.addEventListener('change', endEnhHistory);
      r.addEventListener('pointerup', endEnhHistory);
      r.addEventListener('touchend', endEnhHistory, {passive:true});
    });
    [this.invert,this.gray].forEach(c=>{
      c.addEventListener('change', ()=>{ this._pushUndo('enhance'); apply(); this._updateUndoRedoButtons && this._updateUndoRedoButtons(); });
    });
    // Scale calibration
    this.unitSel=$$('#unit'); this.ppuInput=$$('#ppu');
    this.unitSel.addEventListener('change', ()=>{ this._pushUndo('scale'); this._updateScale(); this._updateUndoRedoButtons && this._updateUndoRedoButtons(); });
    this.ppuInput.addEventListener('change', ()=>{ this._pushUndo('scale'); this._updateScale(); this._updateUndoRedoButtons && this._updateUndoRedoButtons(); });

    // Highlight tool options
    this.hlWidth=$$('#hl-width');
    this.hlAlpha=$$('#hl-alpha');
    this.hlColor=$$('#hl-color');
    try{ const saved=localStorage.getItem('hlWidth'); if(saved && this.hlWidth){ this.hlWidth.value=saved } }catch(_){ }
    // Hook transparency slider to viewer and persist
    try{ const a=localStorage.getItem('hlAlpha'); if(this.hlAlpha && a!=null){ this.hlAlpha.value = a } }catch(_){ }
    if(this.hlAlpha){
      // Make the control visible to the viewer for live rendering
      this.viewer.hlAlpha = this.hlAlpha;
      this.hlAlpha.addEventListener('input', ()=>{ try{ localStorage.setItem('hlAlpha', this.hlAlpha.value) }catch(_){ } this.viewer.requestRender(); });
    }
    if(this.hlWidth){ this.hlWidth.addEventListener('input', ()=>{ try{ localStorage.setItem('hlWidth', this.hlWidth.value) }catch(_){ } this.viewer.requestRender(); }); }
    this.hlStop=$$('#hl-stop');
    try{ const s=localStorage.getItem('hlStop'); if(this.hlStop && (s==='0'||s==='1')) this.hlStop.checked = (s!=='0') }catch(_){ }
    if(this.hlStop){ this.hlStop.addEventListener('change', ()=>{ try{ localStorage.setItem('hlStop', this.hlStop.checked?'1':'0') }catch(_){ } }); }
    // Persist highlight color for convenience
    try{ const c=localStorage.getItem('hlColor'); if(this.hlColor && c){ this.hlColor.value=c } }catch(_){ }
    if(this.hlColor){ this.hlColor.addEventListener('input', ()=>{ try{ localStorage.setItem('hlColor', this.hlColor.value) }catch(_){ } }); }

    // Layers UI
    this.layersList=$$('#layers-list'); this.layerAdd=$$('#layer-add'); this.layerRename=$$('#layer-rename'); this.layerDelete=$$('#layer-delete'); this.layerActive=$$('#layer-active');
    this.layerAdd.addEventListener('click', ()=>this._addLayer());
    this.layerRename.addEventListener('click', ()=>this._renameActiveLayer());
    this.layerDelete.addEventListener('click', ()=>this._deleteActiveLayer());
    this.layerActive.addEventListener('change', ()=>{ const id=this.layerActive.value; this._setActiveLayer(id) });
    // Symbols palette drag
    try{
      const palette = document.getElementById('symbols-palette');
      // Also wire the standalone Text button in this tab (if present)
      const textBtnStandalone = document.querySelector('[data-kind="text"].item');
      if(textBtnStandalone){
        textBtnStandalone.addEventListener('dragstart', (e)=>{
          try{ e.dataTransfer.effectAllowed = 'copy'; }catch(_){ }
          try{ e.dataTransfer.setData('text/symbol-kind', 'text'); }catch(_){ }
          try{ e.dataTransfer.setData('text/plain', 'text'); }catch(_){ }
        });
        textBtnStandalone.addEventListener('click', ()=>{
          const cx = this.viewer.w/2, cy = this.viewer.h/2; const world = this.viewer.screenToWorld(cx,cy);
          this._addText(world.x, world.y);
        });
      }
      if(palette){
        // Symbol color picker
        this.symColor = $$('#sym-color');
        try{ const saved = localStorage.getItem('symColor'); if(this.symColor && saved){ this.symColor.value = saved } }catch(_){ }
        if(this.symColor){ this.symColor.addEventListener('input', ()=>{ try{ localStorage.setItem('symColor', this.symColor.value) }catch(_){ } }); }
        palette.addEventListener('dragstart', (e)=>{
          const btn = e.target && e.target.closest && e.target.closest('.item');
          if(!btn) return;
          const kind = btn.dataset.kind||'';
          try{ e.dataTransfer.effectAllowed = 'copy'; }catch(_){ }
          try{ e.dataTransfer.setData('text/symbol-kind', kind); }catch(_){ }
          try{ e.dataTransfer.setData('text/plain', 'symbol:'+kind); }catch(_){ }
          try{ this._debug('symbols:dragstart', { kind, types: (e.dataTransfer && e.dataTransfer.types) ? Array.from(e.dataTransfer.types) : [] }); }catch(_){ }
        });
        // Click-to-place fallback (centered)
        palette.addEventListener('click', (e)=>{
          const btn = e.target && e.target.closest && e.target.closest('.item');
          if(!btn) return;
          const kind = btn.dataset.kind||''; if(!kind) return;
          const cx = this.viewer.w/2, cy = this.viewer.h/2; const world = this.viewer.screenToWorld(cx,cy);
          this._debug('symbols:click-place', { kind, center:{x:world.x|0,y:world.y|0} });
          if(kind==='text') this._addText(world.x, world.y); else this._addSymbol(kind, world.x, world.y);
        });
      }
    }catch(_){ }

    // Inject Text Properties panel at bottom of Symbols tab
    try{
      const symTab = document.getElementById('tab-symbols');
      if(symTab && !document.getElementById('sym-text-props')){
        const panel = document.createElement('div'); panel.className='panel'; panel.id='sym-text-props';
        panel.innerHTML = `
          <h3>Text Properties</h3>
          <div class="row key-val"><div class="key">Text</div><div class="value"><input id="sym-text-content" type="text" placeholder="Select a text item" disabled></div></div>
          <div class="row key-val"><div class="key">Size</div><div class="value"><input id="sym-text-size" type="number" min="6" max="120" step="1" value="13" disabled></div></div>
          <div class="row key-val"><div class="key">Color</div><div class="value"><input id="sym-text-color" type="color" value="#000000" disabled></div></div>
          <div class="muted">Select a text item to edit its properties here.</div>
        `;
        const anchor = symTab.querySelector('#symbols-palette') || symTab.querySelector('.panel') || symTab;
        if(anchor && anchor.insertAdjacentElement){ anchor.insertAdjacentElement('afterend', panel); }
        else { symTab.appendChild(panel); }
        try{ this._debug && this._debug('ui:text-props:init', {}); }catch(_){ }
      }
      this.txtContent=$$('#sym-text-content');
      this.txtSize=$$('#sym-text-size');
      this.txtColor=$$('#sym-text-color');
      // Listeners update the currently selected text annotation
      if(this.txtContent){
        this.txtContent.addEventListener('input', ()=>{ const ann=this._findAnnotationById(this._selectedAnnId); if(ann && ann.type==='text'){ ann.text=this.txtContent.value; this.viewer.requestRender(); }});
        this.txtContent.addEventListener('change', ()=>{ const ann=this._findAnnotationById(this._selectedAnnId); if(ann && ann.type==='text'){ this._pushUndo('edit-text'); this._updateUndoRedoButtons&&this._updateUndoRedoButtons(); }});
      }
      if(this.txtSize){
        this.txtSize.addEventListener('input', ()=>{ const ann=this._findAnnotationById(this._selectedAnnId); if(ann && ann.type==='text'){ ann.props=ann.props||{}; ann.props.size=Math.max(6, +(this.txtSize.value||13)); this.viewer.requestRender(); }});
        this.txtSize.addEventListener('change', ()=>{ const ann=this._findAnnotationById(this._selectedAnnId); if(ann && ann.type==='text'){ this._pushUndo('text-size'); this._updateUndoRedoButtons&&this._updateUndoRedoButtons(); }});
      }
      if(this.txtColor){
        this.txtColor.addEventListener('input', ()=>{ const ann=this._findAnnotationById(this._selectedAnnId); if(ann && ann.type==='text'){ ann.props=ann.props||{}; ann.props.color=this.txtColor.value; this.viewer.requestRender(); }});
        this.txtColor.addEventListener('change', ()=>{ const ann=this._findAnnotationById(this._selectedAnnId); if(ann && ann.type==='text'){ this._pushUndo('text-color'); this._updateUndoRedoButtons&&this._updateUndoRedoButtons(); }});
      }
      this._syncTextControls && this._syncTextControls();
    }catch(_){ }

    // OpenCV controls + export
    this.cvLoad=$$('#cv-load'); this.cvDeskew=$$('#cv-deskew'); this.cvDenoise=$$('#cv-denoise'); this.cvAdapt=$$('#cv-adapt'); this.cvReset=$$('#cv-reset');
    this.cvText=$$('#cv-text');
    this.cvText2=$$('#cv-text2');
    this.cvTextStrength=$$('#cv-text-strength');
    this.cvTextThin=$$('#cv-text-thin');
    this.cvTextThicken=$$('#cv-text-thicken');
    this.cvTextUpscale=$$('#cv-text-upscale');
    this.cvBgEq=$$('#cv-bg-eq');
    this.cvBgNorm=$$('#cv-bgnorm');
    this.cvDespeckle=$$('#cv-despeckle');
    this.cvReload=$$('#cv-reload');
    this.cvSpeckSize=$$('#cv-speck-size');
    this.cvAutoClean=$$('#cv-autoclean');
    this.cvAuto=$$('#cv-auto');
    this.cvExport=$$('#cv-export-svg');
    this.cvPreview=$$('#cv-preview');
    this.cvSimplify=$$('#cv-simplify');
    this.cvSnap=$$('#cv-snap');
    this.cvStroke=$$('#cv-stroke');
    this.cvColor=$$('#cv-color');
    this.cvBridge=$$('#cv-bridge');
    this.cvIgnoreText=$$('#cv-ignore-text');
    this.exportPng=$$('#btn-export-png');
    this.exportZip=$$('#btn-export-zip');
    this.exportMerge=$$('#export-merge');
    const need=async()=>{ if(window.cvWorker && window.cvWorkerReady) return true; try{ await loadOpenCV(this.cvLoad) ; return true }catch(e){ alert('Failed to load OpenCV'); return false } };
    this.cvLoad.addEventListener('click', async()=>{ this._debug('btn:cv-load:click',{}); await this._withBusy(this.cvLoad, async()=>{ await need(); this._debug('btn:cv-load:done',{ready:!!(window.cvWorker&&window.cvWorkerReady)}); }) });
    this.cvDeskew.addEventListener('click', async()=>{ this._debug('btn:cv-deskew:click',{}); await this._withCvProgress(this.cvDeskew, 'deskew', async(reqId)=>{ if(await need()){ await this._cvDeskew(reqId); this._debug('btn:cv-deskew:done',{reqId}); } }) });
    this.cvDenoise.addEventListener('click', async()=>{ this._debug('btn:cv-denoise:click',{}); await this._withCvProgress(this.cvDenoise, 'denoise', async(reqId)=>{ if(await need()){ await this._cvDenoise(reqId); this._debug('btn:cv-denoise:done',{reqId}); } }) });
    this.cvAdapt.addEventListener('click', async()=>{ this._debug('btn:cv-adaptive:click',{}); await this._withCvProgress(this.cvAdapt, 'adaptive', async(reqId)=>{ if(await need()){ await this._cvAdaptive(reqId); this._debug('btn:cv-adaptive:done',{reqId}); } }) });
    if(this.cvBgNorm){ this.cvBgNorm.addEventListener('click', async()=>{ this._debug('btn:cv-bgnorm:click',{}); await this._withCvProgress(this.cvBgNorm, 'bgnorm', async(reqId)=>{ if(await need()){ await this._cvBgNormalize(reqId); this._debug('btn:cv-bgnorm:done',{reqId}); } }) }); }
    if(this.cvDespeckle){ this.cvDespeckle.addEventListener('click', async()=>{ this._debug('btn:cv-despeckle:click',{}); await this._withCvProgress(this.cvDespeckle, 'despeckle', async(reqId)=>{ if(await need()){ await this._cvDespeckle(reqId); this._debug('btn:cv-despeckle:done',{reqId}); } }) }); }
    this.cvReset.addEventListener('click', async()=>{ this._debug('btn:cv-reset:click',{}); await this._withBusy(this.cvReset, async()=>{ const p=this.state.page; if(!p){ this._debug('btn:cv-reset:skip',{reason:'no page'}); return; } this._pushUndo('cv:reset'); p.cvCanvas=null; await this._applyEnhancements(p); this._updateUndoRedoButtons && this._updateUndoRedoButtons(); this._debug('btn:cv-reset:done',{}); }) });
    if(this.cvReload){
      this.cvReload.addEventListener('click', async()=>{
        try{ this._debug('btn:cv-reload:click',{}); }catch(_){ }
        const ok = typeof confirm==='function' ? confirm('Clear cached data (SW, caches, autosave) and reload?') : true;
        if(!ok) return;
        // Attempt to unregister service workers
        try{ if('serviceWorker' in navigator){ const regs = await navigator.serviceWorker.getRegistrations(); await Promise.all(regs.map(r=>r.unregister().catch(()=>{}))); this._debug('cv-reload:sw:unregistered', regs.length); } }catch(_){ }
        // Clear CacheStorage
        try{ if(window.caches && caches.keys){ const keys = await caches.keys(); for(const k of keys){ try{ await caches.delete(k) }catch(_){ } } this._debug('cv-reload:caches:cleared',{}); } }catch(_){ }
        // Clear IndexedDB autosave database
        try{ if(window.indexedDB && indexedDB.deleteDatabase){ const req = indexedDB.deleteDatabase('schematic-studio'); await new Promise(res=>{ req.onsuccess=req.onerror=req.onblocked=()=>res(); }); this._debug('cv-reload:idb:deleted',{}); } }catch(_){ }
        // Clear local/session storage
        try{ window.localStorage && localStorage.clear && localStorage.clear(); }catch(_){ }
        try{ window.sessionStorage && sessionStorage.clear && sessionStorage.clear(); }catch(_){ }
        // Reload with #clean to skip resume
        try{ location.hash = '#clean'; }catch(_){ }
        try{ location.reload(); }catch(_){ }
      });
    }
    // Auto Text Cleanup: BG Normalize -> Despeckle -> Text Enhance
    this.cvTextAuto=$$('#cv-text-auto');
    this.cvOcrReplace=$$('#cv-ocr-replace');
    this.cvOcrErase=$$('#cv-ocr-erase');
    this.cvOcrConf=$$('#cv-ocr-conf');
    if(this.cvTextAuto){
      this.cvTextAuto.addEventListener('click', async()=>{
        this._debug('btn:cv-text-auto:click',{});
        if(!await need()) return;
        const btn=this.cvTextAuto; const wasDisabled=!!btn.disabled; btn.classList.add('loading','determinate'); btn.disabled=true;
        const setP=(pct,label)=>{ try{ btn.style.setProperty('--progress', String(pct)); }catch(_){ } this._setStatusTask(`${label}�?� ${Math.round(pct)}%`); };
        const reqA=uuid(), reqB=uuid(), reqC=uuid();
        const stopBatch = this._beginHistoryBatch && this._beginHistoryBatch('cv:text-auto');
        const onMsg=(ev)=>{
          const d=ev.data||{}; if(d.type==='progress' && (d.reqId===reqA||d.reqId===reqB||d.reqId===reqC)){
            let pct=0, label='Text Cleanup';
            if(d.reqId===reqA){ pct = (d.value||0)*0.33; label='BG Equalize'; }
            else if(d.reqId===reqB){ pct = 33 + (d.value||0)*0.33; label='Despeckle'; }
            else if(d.reqId===reqC){ pct = 66 + (d.value||0)*0.34; label='Text Enhance'; }
            setP(Math.max(0,Math.min(100,pct)), label);
          }
        };
        window.cvWorker && window.cvWorker.addEventListener('message', onMsg);
        try{
          await this._cvBgNormalize(reqA);
          await this._cvDespeckle(reqB);
          const prevBgEq = this.cvBgEq ? !!this.cvBgEq.checked : false; if(this.cvBgEq) this.cvBgEq.checked = false;
          try{ await this._cvTextEnhance(reqC); } finally { if(this.cvBgEq) this.cvBgEq.checked = prevBgEq; }
          setP(100,'Done');
        } finally {
          try{ window.cvWorker && window.cvWorker.removeEventListener('message', onMsg) }catch(_){ }
          btn.classList.remove('determinate'); btn.style.removeProperty('--progress'); btn.classList.remove('loading');
          btn.disabled = wasDisabled;
          this._setStatusTask('Ready');
          this._debug('btn:cv-text-auto:done',{});
          try{ stopBatch && stopBatch(); }catch(_){ }
        }
      });
    }

    if(this.cvOcrReplace){
      this.cvOcrReplace.addEventListener('click', async()=>{
        this._debug('btn:cv-ocr:click',{});
        await this._withBusy(this.cvOcrReplace, async()=>{
          await this._runOcrReplace();
        });
      });
    }
    if(this.cvAutoClean){
      this.cvAutoClean.addEventListener('click', async()=>{
        this._debug('btn:cv-autoclean:click',{});
        if(!await need()) return;
        const btn=this.cvAutoClean; const wasDisabled=!!btn.disabled; btn.classList.add('loading','determinate'); btn.disabled=true;
        const setP=(pct,label)=>{ try{ btn.style.setProperty('--progress', String(pct)); }catch(_){ } this._setStatusTask(`${label}… ${Math.round(pct)}%`); };
        const req1=uuid(), req2=uuid();
        const onMsg=(ev)=>{
          const d=ev.data||{}; if(d.type==='progress' && (d.reqId===req1||d.reqId===req2)){
            let pct=0, label='Auto Clean';
            if(d.op==='denoise'){ pct = (d.value||0)*0.45; label='Denoising'; }
            if(d.op==='adaptive'){ pct = 45 + (d.value||0)*0.45/1; label='Adaptive'; }
            setP(Math.max(0,Math.min(100,pct)), label);
          }
        };
        window.cvWorker && window.cvWorker.addEventListener('message', onMsg);
        try{
          // Denoise -> Adaptive -> Sharpen (if sharpen==0, set to 10)
          await this._cvDenoise(req1);
          await this._cvAdaptive(req2);
          // Sharpen stage
          let targetSharp = +this.sharpen.value; if(!targetSharp || targetSharp===0){ targetSharp = 10; this.sharpen.value = targetSharp; this.sharpen.dispatchEvent(new Event('input',{bubbles:true})) }
          setP(92,'Sharpening');
          await this._applyEnhancements(this.state.page);
          setP(100,'Done');
        } finally {
          try{ window.cvWorker && window.cvWorker.removeEventListener('message', onMsg) }catch(_){ }
          btn.classList.remove('determinate'); btn.style.removeProperty('--progress'); btn.classList.remove('loading');
          btn.disabled = wasDisabled;
          this._setStatusTask('Ready');
          this._debug('btn:cv-autoclean:done',{});
          try{ stopBatch && stopBatch(); }catch(_){ }
          try{ if(this.cvPreview?.checked) this._buildAndShowVectorOverlay(); }catch(_){ }
        }
      });
    }

    if(this.cvExport){
      this.cvExport.addEventListener('click', async()=>{
        this._debug('btn:cv-export-svg:click',{});
        const p=this.state.page; if(!p){ this._toast('No page to export','error'); return }
        // Ensure graph exists based on current processed/cv canvas
        try{ await this._cvEnsureGraphBuilt(p); }catch(_){ /* try to load and retry */ try{ await need(); await this._cvEnsureGraphBuilt(p); }catch(e){ this._toast('Failed to prepare graph for export','error'); return } }
        const btn=this.cvExport; const wasDisabled=!!btn.disabled; btn.classList.add('loading'); btn.disabled=true;
        const w=window.cvWorker; if(!(w&&window.cvWorkerReady)){ this._toast('OpenCV worker not ready','error'); btn.classList.remove('loading'); btn.disabled=wasDisabled; return }
        const onMsg=(ev)=>{
          const d=ev.data||{}; if(d.type==='exportSVG:result' && d.id===p.id){
            try{ w.removeEventListener('message', onMsg) }catch(_){ }
            try{
              const blob = new Blob([d.svg||''], {type:'image/svg+xml'});
              const url = URL.createObjectURL(blob);
              const name = (p.name||'page')+'.svg';
              const a=document.createElement('a'); a.href=url; a.download=name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url), 5000);
              this._debug('export:svg:done',{bytes:(d.svg||'').length});
            }finally{ btn.classList.remove('loading'); btn.disabled=wasDisabled; }
          }
        };
        w.addEventListener('message', onMsg);
        const stroke = this.cvColor?.value || '#000';
        const strokeWidth = parseFloat(this.cvStroke?.value||'2')||2;
        const simplify = parseFloat(this.cvSimplify?.value||'1')||1;
        const snap = this.cvSnap?.checked ? 1 : 0;
        w.postMessage({ type:'exportSVG', id:p.id, options:{ simplify, snap, stroke, strokeWidth } });
      });
    }

    if(this.cvText){
      this.cvText.addEventListener('click', async()=>{
        this._debug('btn:cv-text:click',{});
        await this._withCvProgress(this.cvText, 'text', async(reqId)=>{ if(await need()){ await this._cvTextEnhance(reqId); this._debug('btn:cv-text:done',{reqId}); } });
      });
    }
    if(this.cvText2){
      this.cvText2.addEventListener('click', async()=>{
        this._debug('btn:cv-text2:click',{});
        await this._withCvProgress(this.cvText2, 'text2', async(reqId)=>{ if(await need()){ await this._cvTextEnhance2(reqId); this._debug('btn:cv-text2:done',{reqId}); } });
      });
    }

    if(this.exportPng){
      this.exportPng.addEventListener('click', async()=>{
        try{
          await this._exportPNG();
        }catch(e){ this._toast('PNG export failed','error'); this._debug('export:png:error', String(e&&e.message||e)); }
      });
    }
    if(this.exportZip){
      this.exportZip.addEventListener('click', async()=>{
        try{ await this._exportZIP(); }catch(e){ this._toast('ZIP export failed','error'); this._debug('export:zip:error', String(e&&e.message||e)); }
      });
    }

    // Vector preview overlay controls
    const regenOverlay = async()=>{ if(!this.cvPreview?.checked) { this._setVectorOverlay(null); return; } await this._buildAndShowVectorOverlay(); };
    this.cvPreview && this.cvPreview.addEventListener('change', regenOverlay);
    this.cvSimplify && this.cvSimplify.addEventListener('input', ()=>{ if(this.cvPreview?.checked) { this._buildAndShowVectorOverlay(); } });
    this.cvSnap && this.cvSnap.addEventListener('change', ()=>{ if(this.cvPreview?.checked) { this._buildAndShowVectorOverlay(); } });
    this.cvStroke && this.cvStroke.addEventListener('input', ()=>{ if(this.cvPreview?.checked) { this._buildAndShowVectorOverlay(); } });
    this.cvColor && this.cvColor.addEventListener('input', ()=>{ if(this.cvPreview?.checked) { this._buildAndShowVectorOverlay(); } });
    this.cvBridge && this.cvBridge.addEventListener('input', ()=>{ if(this.cvPreview?.checked) { this._buildAndShowVectorOverlay(); } });
    this.cvIgnoreText && this.cvIgnoreText.addEventListener('change', async()=>{ try{ if(this.cvPreview?.checked){ await this._cvEnsureGraphBuilt(this.state.page); await this._buildAndShowVectorOverlay(); } }catch(_){ } });
  }
  _renderLayers(){
    const p=this.state.page; const list=this.layersList; const activeSel=this.layerActive; list.innerHTML=''; activeSel.innerHTML='';
    if(!p){ return }
    p.layers.forEach(l=>{
      const row=document.createElement('div'); row.className='layer-row'+(l.id===p.activeLayerId?' active':''); row.dataset.id=l.id;
      row.innerHTML = `
        <input class="vis" type="checkbox" ${l.visible?'checked':''} title="Toggle visibility"/>
        <div class="name" contenteditable="false" spellcheck="false" title="Double-click to rename">${l.name}</div>
      `;
      const vis=row.querySelector('.vis'); vis.addEventListener('change',()=>{ this._pushUndo('layer-visibility'); l.visible=vis.checked; this.viewer.requestRender(); this._queueAutosave(); this._updateUndoRedoButtons && this._updateUndoRedoButtons(); });
      row.addEventListener('click', (e)=>{ if(e.target.classList.contains('vis')) return; this._setActiveLayer(l.id) });
      row.addEventListener('dblclick', ()=>{ this._renameLayerInline(row, l) });
      list.appendChild(row);
      const opt=document.createElement('option'); opt.value=l.id; opt.textContent=l.name; if(l.id===p.activeLayerId) opt.selected=true; activeSel.appendChild(opt);
    });
  }
  _renameLayerInline(row, layer){
    const nameEl=row.querySelector('.name'); nameEl.contentEditable='true'; nameEl.focus();
    const sel=window.getSelection(); const range=document.createRange(); range.selectNodeContents(nameEl); sel.removeAllRanges(); sel.addRange(range);
    const done=()=>{ nameEl.contentEditable='false'; const v=nameEl.textContent.trim()||'Layer'; this._pushUndo('rename-layer'); layer.name=v; this._renderLayers(); this._queueAutosave(); this._updateUndoRedoButtons && this._updateUndoRedoButtons(); };
    const onKey=(e)=>{ if(e.key==='Enter'){ e.preventDefault(); nameEl.blur() } if(e.key==='Escape'){ e.preventDefault(); nameEl.textContent=layer.name; nameEl.blur() } };
    nameEl.addEventListener('blur', done, {once:true});
    nameEl.addEventListener('keydown', onKey);
  }
  _syncTextControls(){
    const ann = this._findAnnotationById(this._selectedAnnId);
    const isText = !!(ann && ann.type==='text');
    const setDis = (el, dis)=>{ if(el){ el.disabled = !!dis; } };
    setDis(this.txtContent, !isText);
    setDis(this.txtSize, !isText);
    setDis(this.txtColor, !isText);
    if(isText){
      try{ this.txtContent && (this.txtContent.value = ann.text||''); }catch(_){ }
      const size = Math.max(6, +(ann.props?.size||13));
      try{ this.txtSize && (this.txtSize.value = String(size)); }catch(_){ }
      const color = ann.props?.color || '#000000';
      try{ this.txtColor && (this.txtColor.value = color); }catch(_){ }
    } else {
      if(this.txtContent){ this.txtContent.value=''; }
      if(this.txtSize){ this.txtSize.value='13'; }
      if(this.txtColor){ this.txtColor.value = '#000000'; }
    }
  }
  _renderProps(){
    const wrap=this.propsPanel; if(!wrap) return;
    const ann = this._findAnnotationById(this._selectedAnnId);
    if(!ann){ wrap.classList.add('muted'); wrap.innerHTML = 'Select an item to edit properties.'; return }
    wrap.classList.remove('muted');
    if(ann.type==='text'){
      const size = Math.max(6, +(ann.props?.size||13));
      const color = ann.props?.color || '#000000';
      const content = ann.text || '';
      const esc=(s)=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      wrap.innerHTML = `
        <div class="row key-val"><div class="key">Text</div><div class="value"><input id="prop-text-content" type="text" value="${esc(content)}" /></div></div>
        <div class="row key-val"><div class="key">Size</div><div class="value"><input id="prop-text-size" type="number" min="6" max="120" step="1" value="${size}" /></div></div>
        <div class="row key-val"><div class="key">Color</div><div class="value"><input id="prop-text-color" type="color" value="${color}" /></div></div>
      `;
      const txt=$$('#prop-text-content'); const sz=$$('#prop-text-size'); const col=$$('#prop-text-color');
      if(txt){ txt.addEventListener('input', ()=>{ ann.text = txt.value; this.viewer.requestRender(); }); txt.addEventListener('change', ()=>{ this._pushUndo('edit-text'); this._updateUndoRedoButtons&&this._updateUndoRedoButtons(); }); }
      if(sz){ sz.addEventListener('input', ()=>{ ann.props=ann.props||{}; ann.props.size = Math.max(6, +(sz.value||13)); this.viewer.requestRender(); }); sz.addEventListener('change', ()=>{ this._pushUndo('text-size'); this._updateUndoRedoButtons&&this._updateUndoRedoButtons(); }); }
      if(col){ col.addEventListener('input', ()=>{ ann.props=ann.props||{}; ann.props.color = col.value; this.viewer.requestRender(); }); col.addEventListener('change', ()=>{ this._pushUndo('text-color'); this._updateUndoRedoButtons&&this._updateUndoRedoButtons(); }); }
      return;
    }
    // Default
    wrap.innerHTML = '<div class="muted">No editable properties for this item.</div>';
  }
  _setupRightTabs(){
    const tabsWrap = document.getElementById('right-tabs'); if(!tabsWrap) return;
    // Hide any old loose panels (we moved content into tab panels)
    try{ [...document.querySelectorAll('aside.right > .panel')].forEach(p=>{ if(!p.closest('.tab-panel')) p.classList.add('hidden'); }); }catch(_){ }
    const btns = [...tabsWrap.querySelectorAll('button[data-tab]')];
    const setTab = (name)=>{
      btns.forEach(b=>b.classList.toggle('active', b.dataset.tab===name));
      [...document.querySelectorAll('.tab-panel')].forEach(p=>p.classList.toggle('active', p.dataset.tab===name));
      try{ localStorage.setItem('rightTab', name); }catch(_){ }
    };
    btns.forEach(b=>b.addEventListener('click', ()=>setTab(b.dataset.tab)));
    const saved = (localStorage.getItem('rightTab')||'lines'); setTab(saved);
  }
  _setupSplitters(){
    const root = document.documentElement;
    const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
    const left = document.getElementById('split-left');
    const right = document.getElementById('split-right');
    const bottom = document.getElementById('split-debug');
    if(left){
      left.addEventListener('pointerdown', (e)=>{
        e.preventDefault(); left.setPointerCapture(e.pointerId);
        const onMove=(ev)=>{ const x=ev.clientX; const min=180; const max=window.innerWidth - 300 - 200; const w=clamp(x,min,max); root.style.setProperty('--left-w', w+'px'); this.viewer && this.viewer.resize && this.viewer.resize(); };
        const onUp=(ev)=>{ try{ left.releasePointerCapture(e.pointerId); }catch(_){ } left.removeEventListener('pointermove', onMove); left.removeEventListener('pointerup', onUp); };
        left.addEventListener('pointermove', onMove); left.addEventListener('pointerup', onUp);
      });
    }
    if(right){
      right.addEventListener('pointerdown', (e)=>{
        e.preventDefault(); right.setPointerCapture(e.pointerId);
        const onMove=(ev)=>{ const x=ev.clientX; const min=240; const max=600; const w=clamp(window.innerWidth - x, min, max); root.style.setProperty('--right-w', w+'px'); this.viewer && this.viewer.resize && this.viewer.resize(); };
        const onUp=(ev)=>{ try{ right.releasePointerCapture(e.pointerId); }catch(_){ } right.removeEventListener('pointermove', onMove); right.removeEventListener('pointerup', onUp); };
        right.addEventListener('pointermove', onMove); right.addEventListener('pointerup', onUp);
      });
    }
    if(bottom){
      bottom.addEventListener('pointerdown', (e)=>{
        e.preventDefault(); bottom.setPointerCapture(e.pointerId);
        const onMove=(ev)=>{ const y=ev.clientY; const fromBottom = window.innerHeight - y; const min=100; const max=Math.round(window.innerHeight*0.8); const h=clamp(fromBottom, min, max); root.style.setProperty('--debug-h', h+'px'); };
        const onUp=(ev)=>{ try{ bottom.releasePointerCapture(e.pointerId); }catch(_){ } bottom.removeEventListener('pointermove', onMove); bottom.removeEventListener('pointerup', onUp); };
        bottom.addEventListener('pointermove', onMove); bottom.addEventListener('pointerup', onUp);
      });
    }
  }
  _setActiveLayer(id){ const p=this.state.page; if(!p) return; p.activeLayerId=id; this._renderLayers(); }
  _addLayer(){
    const p=this.state.page; if(!p) return; const name=prompt('New layer name','Layer '+(p.layers.length+1)); if(!name) return;
    this._pushUndo('add-layer');
    const id=uuid(); p.layers.push({id,name,visible:true}); p.activeLayerId=id; this._renderLayers(); this._queueAutosave(); this._updateUndoRedoButtons && this._updateUndoRedoButtons();
  }
  // Utility: show a spinner on a button while awaiting task()
  async _withBusy(button, task){
    if(!button){ return await task(); }
    const prevDisabled = !!button.disabled;
    try{
      button.classList.add('loading'); button.disabled = true;
      return await task();
    } finally {
      button.classList.remove('loading'); button.disabled = prevDisabled;
    }
  }
  // Status task helper
  _setStatusTask(text){ try{ if(this.statusTask) this.statusTask.textContent = text }catch(_){ }
  }
  // Utility: show determinate CV progress ring by listening to worker 'progress'
  async _withCvProgress(button, opName, runWithReq){
    const reqId = uuid();
    const onMsg = (ev)=>{
      const d = ev.data||{}; if(d.type==='progress' && d.op===opName && d.reqId===reqId){
        const v = Math.max(0, Math.min(100, d.value||0));
        try{ button.classList.add('determinate'); button.style.setProperty('--progress', String(v)); }catch(_){ }
        this._setStatusTask(opName.charAt(0).toUpperCase()+opName.slice(1) + `… ${v}%`);
      }
    };
    window.cvWorker && window.cvWorker.addEventListener('message', onMsg);
    try{
      await this._withBusy(button, async()=>{ await runWithReq(reqId) });
    } finally {
      try{ window.cvWorker && window.cvWorker.removeEventListener('message', onMsg); }catch(_){ }
      try{ button.classList.remove('determinate'); button.style.removeProperty('--progress'); }catch(_){ }
      this._setStatusTask('Ready');
    }
  }
  _renameActiveLayer(){ const p=this.state.page; if(!p) return; const l=p.layers.find(x=>x.id===p.activeLayerId); if(!l) return; const name=prompt('Rename layer', l.name); if(!name) return; this._pushUndo('rename-layer'); l.name=name; this._renderLayers(); this._queueAutosave(); this._updateUndoRedoButtons && this._updateUndoRedoButtons(); }
  _deleteActiveLayer(){
    const p=this.state.page; if(!p) return; if(p.layers.length<=1){ alert('Cannot delete the last layer.'); return }
    const id=p.activeLayerId; const idx=p.layers.findIndex(l=>l.id===id); if(idx<0) return;
    if(!confirm('Delete current layer and move its annotations to the first layer?')) return;
    this._pushUndo('delete-layer');
    const target = p.layers.find((l,i)=>i!==idx) || p.layers[0];
    p.annotations.forEach(a=>{ if(a.layerId===id) a.layerId=target.id });
    p.layers.splice(idx,1); p.activeLayerId=target.id; this._renderLayers(); this.viewer.requestRender(); this._queueAutosave(); this._updateUndoRedoButtons && this._updateUndoRedoButtons();
  }
  // Begin/End a manual history batch, returning a function to end
  _beginHistoryBatch(label){
    this._historyBatchDepth = (this._historyBatchDepth||0) + 1;
    if(this._historyBatchDepth === 1){ this._pushUndo(label); this._redoStack = []; }
    return ()=>{ this._historyBatchDepth = Math.max(0, (this._historyBatchDepth||1)-1); this._updateUndoRedoButtons && this._updateUndoRedoButtons(); };
  }
  _setupStatus(){
    this.statusZoom=$$('#status-zoom'); this.statusPos=$$('#status-pos'); this.statusPage=$$('#status-page'); this.statusTask=$$('#status-task');
    this._setStatusTask('Ready');
    this.viewer.on('pointermove', ({px,py})=>{ this.statusPos.textContent = `x:${px|0} y:${py|0}` });
  }
  _setupDnD(){
    const drop=$$('.drop-overlay'); const main=$$('.main');
    const on=()=>drop.classList.add('show'); const off=()=>drop.classList.remove('show');
    // Accept drops on main, the overlay canvas, and the visual drop overlay
    const targets = [main, this.viewer?.overlay, drop].filter(Boolean);
    targets.forEach(el=>{
      ['dragenter','dragover'].forEach(ev=>el.addEventListener(ev, e=>{ e.preventDefault(); e.stopPropagation(); try{ e.dataTransfer.dropEffect='copy' }catch(_){ } on() }));
      ['dragleave','drop'].forEach(ev=>el.addEventListener(ev, e=>{ e.preventDefault(); e.stopPropagation(); off() }));
      el.addEventListener('drop', async e=>{ e.preventDefault(); e.stopPropagation();
      // Symbols/Text via DnD
      let kind = '';
      try{ kind = e.dataTransfer.getData('text/symbol-kind') || ''; if(!kind){ const t=e.dataTransfer.getData('text/plain')||''; if(t.startsWith('symbol:')) kind=t.slice(7); else if(t==='text') kind='text'; } }catch(_){ }
      try{ this._debug('symbols:drop', { kind, types: (e.dataTransfer && e.dataTransfer.types) ? Array.from(e.dataTransfer.types) : [] }); }catch(_){ }
      if(kind){
        // Use the rect of the element handling the drop for accurate coords
        const rect = (e.currentTarget && e.currentTarget.getBoundingClientRect) ? e.currentTarget.getBoundingClientRect() : main.getBoundingClientRect();
        const px=e.clientX-rect.left, py=e.clientY-rect.top;
        const world = this.viewer.screenToWorld(px,py);
        this._debug('symbols:place', { kind, screen:{x:px|0,y:py|0}, world:{x:world.x|0,y:world.y|0} });
        if(kind==='text') this._addText(world.x, world.y); else this._addSymbol(kind, world.x, world.y);
        return;
      }
      const files=[...e.dataTransfer.files]; if(!files.length){ return }
      this._debug('drop:files', {count:files.length, names:files.map(f=>f.name)});
      await this._importFiles(files)
      });
    });
  }
  _setupHelp(){
    this.help=$$('.help'); $$('#btn-help').addEventListener('click',()=>this.help.classList.toggle('show'));
  }

  async _exportPNG(){
    const p=this.state.page; if(!p){ this._toast('No page to export','error'); return }
    // Base image: processed (with enhancements) or cv canvas or original bitmap
    let base = p.processedCanvas || p.cvCanvas || null;
    if(!base){
      const c=document.createElement('canvas'); c.width=p.bitmap.width; c.height=p.bitmap.height; c.getContext('2d').drawImage(p.bitmap,0,0); base=c;
    }
    const out=document.createElement('canvas'); out.width=base.width; out.height=base.height; const ctx=out.getContext('2d');
    ctx.imageSmoothingEnabled=false; ctx.drawImage(base,0,0);
    const includeOverlay = this.exportMerge ? !!this.exportMerge.checked : false;
    if(includeOverlay){
      // Optionally include vector overlay if preview is enabled; ensure it's ready
      try{
        if(this.cvPreview?.checked){ await this._buildAndShowVectorOverlay(); }
      }catch(_){ }
      // Draw vector overlay if available
      try{
        const url = (this.state.page && this.state.page.vectorOverlayUrl) || null;
        if(url){ await new Promise((resolve,reject)=>{ const img=new Image(); img.onload=()=>{ try{ ctx.drawImage(img,0,0); }catch(_){} resolve(); }; img.onerror=()=>resolve(); img.src=url; }); }
      }catch(_){ }
      // Draw annotations (rect/arrow/text/measure/highlight)
      this._drawAnnotationsToCanvas(ctx, p);
    }
    const dataUrl = out.toDataURL('image/png');
    const name = (p.name||'page').replace(/\.[a-z0-9]+$/i,'');
    download(`${name}-export.png`, dataUrl);
    this._debug('export:png:done', { w:out.width, h:out.height, overlay:includeOverlay });
  }

  async _exportPNGBlob(){
    const p=this.state.page; if(!p) throw new Error('No page');
    const includeOverlay = !!(this.exportMerge && this.exportMerge.checked);
    const base = p.processedCanvas || p.cvCanvas || this._sourceCanvas(); if(!base) throw new Error('No canvas');
    const out=document.createElement('canvas'); out.width=base.width; out.height=base.height; const ctx=out.getContext('2d'); ctx.drawImage(base,0,0);
    if(includeOverlay){
      try{ if(this.cvPreview?.checked){ await this._buildAndShowVectorOverlay(); } }catch(_){ }
      try{ const url=(this.state.page && this.state.page.vectorOverlayUrl)||null; if(url){ await new Promise((resolve)=>{ const img=new Image(); img.onload=()=>{ try{ ctx.drawImage(img,0,0); }catch(_){} resolve(); }; img.onerror=()=>resolve(); img.src=url; }); } }catch(_){ }
      this._drawAnnotationsToCanvas(ctx, p);
    }
    const blob = await new Promise(res=> out.toBlob(res, 'image/png'));
    return { blob, name:(p.name||'page').replace(/\.[a-z0-9]+$/i,'')+"-export.png" };
  }

  async _exportProjectBlob(){
    const proj = await this._projectSnapshot();
    const json = new Blob([JSON.stringify(proj,null,2)], {type:'application/json'});
    return { blob: json, name: 'project.json' };
  }

  async _exportSVGBlob(){
    const p=this.state.page; if(!p) throw new Error('No page');
    try{ await this._cvEnsureGraphBuilt(p); }catch(_){ }
    return await new Promise((resolve)=>{
      const w=window.cvWorker; if(!(w&&window.cvWorkerReady)) return resolve(null);
      const onMsg=(ev)=>{ const d=ev.data||{}; if(d.type==='exportSVG:result' && d.id===p.id){ try{ w.removeEventListener('message', onMsg) }catch(_){ } const svgStr=d.svg||''; const blob=new Blob([svgStr], {type:'image/svg+xml'}); resolve({ blob, name:(p.name||'page').replace(/\.[a-z0-9]+$/i,'')+'.svg' }); } };
      w.addEventListener('message', onMsg);
      const stroke = this.cvColor?.value || '#000';
      const strokeWidth = parseFloat(this.cvStroke?.value||'2')||2; const simplify=parseFloat(this.cvSimplify?.value||'1')||1; const snap=this.cvSnap?.checked?1:0;
      w.postMessage({ type:'exportSVG', id:p.id, options:{ simplify, snap, stroke, strokeWidth } });
      setTimeout(()=>{ try{ w.removeEventListener('message', onMsg) }catch(_){ } resolve(null); }, 5000);
    });
  }

  async _exportZIP(){
    const files = [];
    try{ const png = await this._exportPNGBlob(); files.push(png); }catch(_){ }
    try{ const svg = await this._exportSVGBlob(); if(svg) files.push(svg); }catch(_){ }
    try{ const proj = await this._exportProjectBlob(); files.push(proj); }catch(_){ }
    const zipBlob = await makeZip(files);
    const url = await toDataURL(zipBlob);
    const base=(this.state.page?.name||'schematic').replace(/\.[a-z0-9]+$/i,'');
    download(`${base}-export.zip`, url);
  }

  _drawAnnotationsToCanvas(ctx, page){
    if(!page) return;
    ctx.save();
    for(const a of page.annotations||[]){
      const layer = page.layers.find(l=>l.id===a.layerId); if(layer && !layer.visible) continue;
      switch(a.type){
        case 'rect': {
          ctx.save(); ctx.strokeStyle=a.props?.color||'#6df2bf'; ctx.setLineDash(a.props?.dash?[4,4]:[]);
          const p1=a.points[0], p2=a.points[1]; const x=Math.min(p1.x,p2.x), y=Math.min(p1.y,p2.y), w=Math.abs(p1.x-p2.x), h=Math.abs(p1.y-p2.y);
          ctx.strokeRect(x,y,w,h); ctx.restore();
          break;
        }
        case 'arrow': {
          ctx.save(); const color=a.props?.color||'#4cc2ff'; ctx.strokeStyle=color; ctx.fillStyle=color; ctx.lineWidth=1.5;
          const p1=a.points[0], p2=a.points[1]; ctx.beginPath(); ctx.moveTo(p1.x,p1.y); ctx.lineTo(p2.x,p2.y); ctx.stroke();
          const ang=Math.atan2(p2.y-p1.y,p2.x-p1.x); const size=8; ctx.beginPath(); ctx.moveTo(p2.x,p2.y);
          ctx.lineTo(p2.x-size*Math.cos(ang-0.4), p2.y-size*Math.sin(ang-0.4)); ctx.lineTo(p2.x-size*Math.cos(ang+0.4), p2.y-size*Math.sin(ang+0.4)); ctx.closePath(); ctx.fill();
          ctx.restore();
          break;
        }
        case 'text': {
          ctx.save(); ctx.fillStyle=a.props?.color||'#ffd166'; ctx.strokeStyle='#0009'; ctx.lineWidth=3; ctx.font='13px ui-sans-serif';
          const p0=a.points[0]; const text=a.text||''; ctx.strokeText(text, p0.x+1, p0.y+1); ctx.fillText(text, p0.x, p0.y); ctx.restore();
          break;
        }
        case 'measure': {
          ctx.save(); ctx.strokeStyle='#e8ecf1'; ctx.fillStyle='#e8ecf1'; ctx.setLineDash([6,4]);
          const p1=a.points[0], p2=a.points[1]; ctx.beginPath(); ctx.moveTo(p1.x,p1.y); ctx.lineTo(p2.x,p2.y); ctx.stroke(); ctx.setLineDash([]);
          const text=a.props?.label||''; if(text){ const midx=(p1.x+p2.x)/2, midy=(p1.y+p2.y)/2; ctx.font='12px ui-sans-serif'; ctx.fillStyle='#0b0e17'; ctx.strokeStyle='#e8ecf1'; const pad=4; const w=ctx.measureText(text).width+pad*2; const h=18; if(ctx.roundRect){ ctx.beginPath(); ctx.roundRect(midx-w/2, midy-20, w, h, 6); ctx.fill(); ctx.stroke(); } else { ctx.fillRect(midx-w/2, midy-20, w, h); ctx.strokeRect(midx-w/2, midy-20, w, h); } ctx.fillStyle='#e8ecf1'; ctx.fillText(text, midx-w/2+pad, midy-6); }
          ctx.restore();
          break;
        }
        case 'highlight': {
          ctx.save(); const color=a.props?.color||'#ffd166';
          const alphaCtl = (this.hlAlpha && +this.hlAlpha.value) || 0; const alpha = Math.max(0, Math.min(1, 1 - (alphaCtl/100)));
          ctx.globalAlpha = alpha; ctx.strokeStyle=color; ctx.lineWidth=a.props?.width||4; ctx.lineCap='round'; ctx.shadowColor=color; ctx.shadowBlur=8;
          const pts=a.points||[]; if(pts.length>=2){ ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); for(let i=1;i<pts.length;i++){ ctx.lineTo(pts[i].x, pts[i].y) } ctx.stroke(); }
          ctx.restore();
          break;
        }
        case 'symbol': {
          ctx.save(); const p0=a.points[0]||{x:0,y:0}; const angle=(a.props&&a.props.angle)||0; const scale=(a.props&&a.props.scale)||1; ctx.translate(p0.x, p0.y); ctx.rotate(angle*Math.PI/180); ctx.scale(scale, scale); ctx.lineWidth=2; ctx.strokeStyle='#e8ecf1';
          const L=36, H=18; const kind=(a.props&&a.props.kind)||'resistor';
          const drawRes=()=>{ ctx.beginPath(); ctx.moveTo(-L,0); ctx.lineTo(-12,0); ctx.moveTo(12,0); ctx.lineTo(L,0); ctx.moveTo(-12,0); ctx.lineTo(-6,-8); ctx.lineTo(0,8); ctx.lineTo(6,-8); ctx.lineTo(12,0); ctx.stroke(); };
          const drawCap=()=>{ ctx.beginPath(); ctx.moveTo(-L,0); ctx.lineTo(-8,0); ctx.moveTo(8,0); ctx.lineTo(L,0); ctx.moveTo(-8,-H/2); ctx.lineTo(-8,H/2); ctx.moveTo(8,-H/2); ctx.lineTo(8,H/2); ctx.stroke(); };
          const drawInd=()=>{ ctx.beginPath(); ctx.moveTo(-L,0); ctx.lineTo(-12,0); for(let i=0;i<4;i++){ const x=-12+i*8; ctx.moveTo(x,0); ctx.arc(x+4,0,4,Math.PI,0,false); } ctx.moveTo(20,0); ctx.lineTo(L,0); ctx.stroke(); };
          const drawDiode=()=>{ ctx.beginPath(); ctx.moveTo(-L,0); ctx.lineTo(-10,0); ctx.moveTo(10,0); ctx.lineTo(L,0); ctx.moveTo(-10,-10); ctx.lineTo(10,0); ctx.lineTo(-10,10); ctx.closePath(); ctx.stroke(); ctx.beginPath(); ctx.moveTo(10,-10); ctx.lineTo(10,10); ctx.stroke(); };
          const drawLED=()=>{ drawDiode(); ctx.beginPath(); ctx.moveTo(14,-2); ctx.lineTo(22,-10); ctx.moveTo(10,2); ctx.lineTo(18,-6); ctx.stroke(); };
          const drawNPN=()=>{ ctx.beginPath(); ctx.moveTo(-L,0); ctx.lineTo(-8,0); ctx.moveTo(20,0); ctx.lineTo(L,0); ctx.beginPath(); ctx.arc(6,0,12,0,Math.PI*2); ctx.stroke(); ctx.beginPath(); ctx.moveTo(-8,0); ctx.lineTo(0,0); ctx.stroke(); ctx.beginPath(); ctx.moveTo(12,6); ctx.lineTo(18,10); ctx.moveTo(12,6); ctx.lineTo(14,12); ctx.stroke(); };
          const drawPNP=()=>{ ctx.beginPath(); ctx.moveTo(-L,0); ctx.lineTo(-8,0); ctx.moveTo(20,0); ctx.lineTo(L,0); ctx.beginPath(); ctx.arc(6,0,12,0,Math.PI*2); ctx.stroke(); ctx.beginPath(); ctx.moveTo(-8,0); ctx.lineTo(0,0); ctx.stroke(); ctx.beginPath(); ctx.moveTo(14,12); ctx.lineTo(12,6); ctx.moveTo(12,6); ctx.lineTo(18,10); ctx.stroke(); };
          const drawGnd=()=>{ ctx.beginPath(); ctx.moveTo(0,-10); ctx.lineTo(0,0); ctx.moveTo(-12,0); ctx.lineTo(12,0); ctx.moveTo(-8,4); ctx.lineTo(8,4); ctx.moveTo(-4,8); ctx.lineTo(4,8); ctx.stroke(); };
          const drawVcc=()=>{ ctx.beginPath(); ctx.moveTo(0,10); ctx.lineTo(0,0); ctx.moveTo(0,0); ctx.lineTo(-6,6); ctx.moveTo(0,0); ctx.lineTo(6,6); ctx.stroke(); };
          const drawOpamp=()=>{ ctx.beginPath(); ctx.moveTo(-20,-12); ctx.lineTo(-20,12); ctx.lineTo(20,0); ctx.closePath(); ctx.stroke(); ctx.beginPath(); ctx.moveTo(-30,-6); ctx.lineTo(-20,-6); ctx.moveTo(-30,6); ctx.lineTo(-20,6); ctx.moveTo(20,0); ctx.lineTo(34,0); ctx.stroke(); };
          const drawSwitch=()=>{ ctx.beginPath(); ctx.moveTo(-L,8); ctx.lineTo(-10,8); ctx.moveTo(-10,8); ctx.lineTo(10,-4); ctx.moveTo(10,-4); ctx.lineTo(L,-4); ctx.stroke(); };
          const drawBattery=()=>{ ctx.beginPath(); ctx.moveTo(-L,0); ctx.lineTo(-10,0); ctx.moveTo(10,0); ctx.lineTo(L,0); ctx.moveTo(-10,-10); ctx.lineTo(-10,10); ctx.moveTo(10,-14); ctx.lineTo(10,14); ctx.stroke(); };
          const drawConnector=()=>{ ctx.beginPath(); ctx.arc(0,0,6,0,Math.PI*2); ctx.stroke(); ctx.beginPath(); ctx.moveTo(-L,0); ctx.lineTo(-6,0); ctx.moveTo(6,0); ctx.lineTo(L,0); ctx.stroke(); };
          switch(kind){ case 'capacitor': drawCap(); break; case 'inductor': drawInd(); break; case 'diode': drawDiode(); break; case 'led': drawLED(); break; case 'npn': drawNPN(); break; case 'pnp': drawPNP(); break; case 'ground': drawGnd(); break; case 'vcc': case '5v': case '3v3': drawVcc(); break; case 'opamp': drawOpamp(); break; case 'switch': drawSwitch(); break; case 'battery': drawBattery(); break; case 'connector': drawConnector(); break; default: drawRes(); }
          if(a.props && a.props.label){ ctx.save(); ctx.fillStyle='#e8ecf1'; ctx.font='11px ui-sans-serif'; ctx.textAlign='center'; ctx.fillText(String(a.props.label), 0, H+12); ctx.restore(); }
          ctx.restore();
          break;
        }
      }
    }
    ctx.restore();
  }
  
  _setVectorOverlay(url){
    const p=this.state.page; if(!p) return;
    // Revoke previous
    try{ if(p.vectorOverlayUrl && p.vectorOverlayUrl!==url) URL.revokeObjectURL(p.vectorOverlayUrl) }catch(_){ }
    p.vectorOverlayUrl = url||null;
    if(url){ this.viewer.svgLayer.src = url; this.viewer.svgLayer.style.display='block'; this.viewer.requestRender(); }
    else { this.viewer.svgLayer.removeAttribute('src'); this.viewer.svgLayer.style.display='none'; this.viewer.requestRender(); }
  }
  async _buildAndShowVectorOverlay(){
    const p=this.state.page; if(!p) return; const w=window.cvWorker;
    if(!(w&&window.cvWorkerReady)){ try{ await loadOpenCV(this.cvLoad) }catch(e){ this._toast('OpenCV not ready','error'); return } }
    await this._cvEnsureGraphBuilt(p);
    const simplify = parseFloat(this.cvSimplify?.value||'1')||1;
    const snap = this.cvSnap?.checked ? 1 : 0;
    return new Promise((resolve)=>{
      const onMsg=(ev)=>{
        const d=ev.data||{}; if(d.type==='exportSVG:result' && d.id===p.id){
          try{ w.removeEventListener('message', onMsg) }catch(_){ }
          try{
            const blob = new Blob([d.svg||''], {type:'image/svg+xml'});
            const url = URL.createObjectURL(blob);
            this._setVectorOverlay(url);
            this._debug('preview:vector:ready', { bytes:(d.svg||'').length, simplify, snap });
          }catch(_){ }
          resolve();
        }
      };
      w.addEventListener('message', onMsg);
      const stroke = this.cvColor?.value || '#00aaff';
      const strokeWidth = parseFloat(this.cvStroke?.value||'2')||2;
      w.postMessage({ type:'exportSVG', id:p.id, options:{ simplify, snap, stroke, strokeWidth } });
    });
  }
  _setupDebugPanel(){
    this.debugPanel = $$('#debug-panel'); this.debugMemo = $$('#debug-memo'); this.debugCopy=$$('#debug-copy'); this.debugClear=$$('#debug-clear');
    if(this.debugCopy) this.debugCopy.addEventListener('click', ()=>{ try{ this.debugMemo.select(); document.execCommand('copy'); this._toast('Copied debug memo','ok') }catch(_){ navigator.clipboard?.writeText(this.debugMemo.value).then(()=>this._toast('Copied debug memo','ok')) } });
    if(this.debugClear) this.debugClear.addEventListener('click', ()=>{ this.debugMemo.value=''; this._toast('Cleared debug memo','ok') });
    // Auto-show if hash or previous state requested it
    try{
      const want = (location.hash||'').includes('debug') || localStorage.getItem('debugPanel')==='1';
      if(want && this.debugPanel){ this.debugPanel.classList.remove('hidden') }
    }catch(_){ }
    this._debug('boot', { ua:navigator.userAgent, protocol:location.protocol, sw:'serviceWorker' in navigator, features:{ createImageBitmap: !!window.createImageBitmap } });
    window.DEBUG_MEMO_LOG = (tag,data)=>this._debug(tag,data);
    // Global error hooks to capture issues in the debug panel
    window.addEventListener('error', (e)=>{
      try{
        this._debug('window:error', { message: e.message, src: e.filename, line: e.lineno, col: e.colno, stack: e.error?.stack });
      }catch(_){ /* noop */ }
    });
    window.addEventListener('unhandledrejection', (e)=>{
      try{
        const reason = e.reason; const msg = (reason && reason.message) || String(reason);
        this._debug('unhandledrejection', { message: msg, stack: reason?.stack });
      }catch(_){ /* noop */ }
    });
    // Button click tracer for debugging sticky buttons
    document.addEventListener('click', (ev)=>{
      try{
        const el = ev.target && ev.target.closest && ev.target.closest('button');
        if(!el) return;
        const id = el.id || '';
        if(!(id.startsWith('cv-') || id.startsWith('btn-'))) return;
        this._debug('click:button', { id, disabled: !!el.disabled, class: el.className||'', text: (el.textContent||'').trim() });
      }catch(_){ /* noop */ }
    });
  }
  _toggleDebug(){ if(!this.debugPanel) return; this.debugPanel.classList.toggle('hidden'); try{ localStorage.setItem('debugPanel', this.debugPanel.classList.contains('hidden')?'0':'1') }catch(_){ } }
  _debug(tag, data){ try{ const ts=new Date().toISOString(); const payload=(typeof data==='string')?data:JSON.stringify(data); if(this.debugMemo){ this.debugMemo.value += `[${ts}] ${tag}: ${payload}\n`; this.debugMemo.scrollTop=this.debugMemo.scrollHeight } console.log(`[${ts}] ${tag}`, data); }catch(e){ try{ console.log(tag, data) }catch(_){} } }
  _wireState(){
    // reflect zoom
    const refresh=()=>{ const z = (this.viewer.state.scale*100)|0; this.statusZoom.textContent=`${z}%`; this.statusPage.textContent = this.state.page?`${this.state.current+1}/${this.state.pages.length}`:'0/0' };
    const renderRefresh = ()=>{ refresh(); this.viewer.requestRender() };
    // tick on transform changes via wheel
    this.viewer.requestRender = this.viewer.requestRender.bind(this.viewer);
    const origZoomAt = this.viewer.zoomAt.bind(this.viewer);
    this.viewer.zoomAt = (...args)=>{ origZoomAt(...args); refresh() };
    // When current page changes, update image and vector overlay
    this.state.on('current', ()=>{ this.viewer.setImage(this.state.page); if(this.cvPreview?.checked){ this._buildAndShowVectorOverlay(); } else { this._setVectorOverlay(null); } refresh(); this._refreshThumbs() });
  }
  _refreshStatus(){ const v=this.viewer; this.statusZoom.textContent = `${(v.state.scale*100)|0}%`; this.statusPage.textContent=this.state.page?`${this.state.current+1}/${this.state.pages.length}`:'0/0' }
  _refreshRight(){ this._renderLayers(); }
  _syncToolButtons(){
    const map = {pan:this.panBtn, rect:this.rectBtn, arrow:this.arrowBtn, text:this.textBtn, measure:this.measureBtn, highlight:this.highlightBtn};
    Object.entries(map).forEach(([k,btn])=>btn.setAttribute('aria-pressed', String(this.tool===k)));
  }
  async _importFiles(files){
    let ok=0;
    if(files && files.length){ this._pushUndo('import'); }
    for(const f of files){
      try{
        this._debug('import:start', {name:f.name, type:f.type});
        const lowerName = (f.name||'').toLowerCase();
        if(f.type==='application/json' || lowerName.endsWith('.json')){
          const txt = await f.text(); const proj = JSON.parse(txt); await this._loadProject(proj); continue;
        }
        // PDF import path
        if(f.type==='application/pdf' || lowerName.endsWith('.pdf')){
          await this._importPDF(f); ok++; continue;
        }
        const lower = lowerName;
        const allowExt = ['.png','.jpg','.jpeg','.bmp','.gif','.webp','.tif','.tiff'];
        const isAllowedByExt = allowExt.some(x=>lower.endsWith(x));
        if(!(f.type && f.type.startsWith('image/')) && !isAllowedByExt){ this._debug('import:skip', {name:f.name, reason:'not image type or extension'}); continue }
        const bmp = await fileToBitmap(f);
        this._debug('import:decoded', {name:f.name, width:bmp.width, height:bmp.height, ctor:bmp.constructor?.name});
        const page = this.state.addPage(f.name, bmp);
        this._debug('import:page-added', {index:this.state.current, total:this.state.pages.length});
        // Generate thumb
        page.thumbDataUrl = await this._bitmapToThumb(bmp);
        await this._applyEnhancements(page); ok++;
        this._debug('import:enhanced', {page:this.state.current, enhance:page.enhance});
      }catch(err){ console.error('Failed to import', f, err); this._debug('import:error', {name:f.name, message: String(err&&err.message||err)}); this._toast(`Failed to import ${f.name}: ${err?.message||err}`, 'error') }
    }
    this._queueAutosave();
    if(ok>0){ this._toast(`Imported ${ok} file${ok>1?'s':''}`, 'ok') }
    this._updateUndoRedoButtons && this._updateUndoRedoButtons();
  }
  async _importPDF(file){
    if(!(window.pdfjsLib && pdfjsLib.getDocument)){
      this._toast('PDF import requires Internet (PDF.js)', 'error');
      return;
    }
    const buf = await file.arrayBuffer();
    const loading = pdfjsLib.getDocument({ data: buf });
    const pdf = await loading.promise;
    let pageNum = 1;
    const overlay = document.createElement('div');
    Object.assign(overlay.style, { position:'fixed', inset:'0', background:'#0b0e1788', zIndex:10000, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'flex-start', padding:'16px', backdropFilter:'blur(2px)' });
    overlay.innerHTML = ''+
      '<div style="position:sticky;top:0;z-index:10;display:flex;gap:8px;align-items:center;margin-bottom:8px;background:#0b0e17cc;padding:8px;border-bottom:1px solid #333">'+
       `<button id="pdf-prev" class="btn">Prev</button>`+
       `<div id="pdf-title" style="min-width:200px">Page 1 / ${pdf.numPages} — Double‑click an image to import</div>`+
       `<button id="pdf-next" class="btn">Next</button>`+
       '<div style="flex:1"></div>'+
       '<label style="display:flex;align-items:center;gap:6px"><input id="pdf-fast" type="checkbox" checked> Fast preview</label>'+
       '<button id="pdf-import-page" class="btn">Import Page</button>'+
       '<button id="pdf-close" class="btn warn">Close</button>'+
       '</div>'+
      '<div id="pdf-content" style="position:relative; z-index:1; overflow:auto; width:96vw; height:86vh; background:#111; border:1px solid #333; display:flex; align-items:center; justify-content:center"></div>';
    document.body.appendChild(overlay);
    const titleEl = overlay.querySelector('#pdf-title');
    const content = overlay.querySelector('#pdf-content');
    const close = ()=>{ try{ overlay.remove(); }catch(_){ } };
    overlay.querySelector('#pdf-close').addEventListener('click', close);
    overlay.addEventListener('keydown', (e)=>{ if(e.key==='Escape') close(); });
    const cache = new Map();
    const renderPage = async ()=>{
      titleEl.textContent = `Page ${pageNum} / ${pdf.numPages} — Double‑click an image to import`;
      content.innerHTML = '<div style="color:#e8ecf1;padding:16px">Loading…</div>';
      try{
        const page = await pdf.getPage(pageNum);
        const useFast = !!overlay.querySelector('#pdf-fast')?.checked;
        const vp = page.getViewport({ scale: useFast ? 1.2 : 1.0 });
        let showed = false;
        // Fast path: canvas preview first unless user disables it
        if(useFast){
          const key = `p${pageNum}@${vp.width}x${vp.height}`;
          if(cache.has(key)){
            content.innerHTML=''; content.appendChild(cache.get(key).cloneNode(true)); showed=true;
          } else {
            const canvas = document.createElement('canvas');
            canvas.width = vp.width|0; canvas.height = vp.height|0; canvas.style.maxWidth='95%';
            const ctx = canvas.getContext('2d');
            await page.render({ canvasContext: ctx, viewport: vp, annotationMode: 0, textLayerMode: 0 }).promise;
            cache.set(key, canvas);
            content.innerHTML=''; content.appendChild(canvas);
            showed=true;
            // Pre-render neighbor page in idle time
            try{ (window.requestIdleCallback||setTimeout)(async()=>{ const p2n=pageNum+1; if(p2n<=pdf.numPages && !cache.has(`p${p2n}@${vp.width}x${vp.height}`)){ const p2=await pdf.getPage(p2n); const c2=document.createElement('canvas'); c2.width=vp.width|0; c2.height=vp.height|0; await p2.render({ canvasContext:c2.getContext('2d'), viewport: p2.getViewport({scale:useFast?1.2:1.0}), annotationMode:0, textLayerMode:0 }).promise; cache.set(`p${p2n}@${c2.width}x${c2.height}`, c2); } }, 50); }catch(_){ }
          }
        }
        // SVG route (for clickable images)
        if(!showed && pdfjsLib && pdfjsLib.SVGGraphics){
          try{
            const opList = await page.getOperatorList();
            const svgGfx = new pdfjsLib.SVGGraphics(page.commonObjs, page.objs);
            svgGfx.embedFonts = true;
            const svg = await svgGfx.getSVG(opList, vp);
            svg.style.maxWidth = '95%'; svg.style.height='auto'; svg.style.background='#fff';
            const NS_XLINK = 'http://www.w3.org/1999/xlink';
            const dataUrlToBlob = (dataUrl)=>{ const [head, b64] = dataUrl.split(','); const mime = (head.match(/data:([^;]+)/)||[])[1]||'image/png'; const bin = atob(b64); const u8 = new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) u8[i]=bin.charCodeAt(i); return new Blob([u8], {type:mime}); };
            svg.querySelectorAll('image').forEach((im, idx)=>{
              im.style.outline = '2px solid transparent';
              im.style.cursor = 'pointer';
              im.addEventListener('mouseenter', ()=>{ im.style.outline='2px solid #4cc2ff' });
              im.addEventListener('mouseleave', ()=>{ im.style.outline='2px solid transparent' });
              im.addEventListener('dblclick', async ()=>{
                try{
                  const href = (im.getAttribute('href')||im.getAttributeNS(NS_XLINK,'href')||im.href?.baseVal||'');
                  if(!href || !href.startsWith('data:')){ alert('Cannot extract this image (not embedded as bitmap). Try Import Page.'); return; }
                  const blob = dataUrlToBlob(href);
                  const name = `${file.name.replace(/\.[a-z0-9]+$/i,'')}-p${pageNum}-img${idx+1}.png`;
                  const f = new File([blob], name, { type: blob.type||'image/png' });
                  const bmp = await fileToBitmap(f);
                  const pageObj = this.state.addPage(name, bmp);
                  pageObj.thumbDataUrl = await this._bitmapToThumb(bmp);
                  await this._applyEnhancements(pageObj);
                  this._toast('Image imported from PDF', 'ok');
                  close();
                }catch(err){ console.error(err); alert('Failed to import image: '+(err?.message||err)); }
              });
            });
            content.innerHTML = ''; content.appendChild(svg);
            showed = true;
          }catch(svgErr){ console.warn('PDF SVG render failed, falling back to canvas', svgErr); }
        }
        if(!showed){
          // Fallback: render to canvas
          const scale = 1.5; const viewport = page.getViewport({ scale });
          const canvas = document.createElement('canvas');
          canvas.width = viewport.width|0; canvas.height = viewport.height|0; canvas.style.maxWidth='95%';
          const ctx = canvas.getContext('2d');
          await page.render({ canvasContext: ctx, viewport }).promise;
          content.innerHTML = '';
          const note = document.createElement('div'); note.style.color='#e8ecf1'; note.style.margin='8px 0'; note.textContent='SVG preview unavailable; use "Import Page" to bring this page in.'; content.appendChild(note);
          content.appendChild(canvas);
        }
      }catch(err){
        console.error('PDF render error', err);
        content.innerHTML = `<div style="color:#ff8080;padding:16px">Failed to render PDF page: ${String(err&&err.message||err)}</div>`;
      }
    };
    overlay.querySelector('#pdf-fast').addEventListener('change', ()=>renderPage());
    overlay.querySelector('#pdf-prev').addEventListener('click', ()=>{ if(pageNum>1){ pageNum--; renderPage(); } });
    overlay.querySelector('#pdf-next').addEventListener('click', ()=>{ if(pageNum<pdf.numPages){ pageNum++; renderPage(); } });
    overlay.querySelector('#pdf-import-page').addEventListener('click', async ()=>{
      try{
        const page = await pdf.getPage(pageNum);
        const scale = 2.0; // higher DPI for clarity
        const vp = page.getViewport({ scale });
        const canvas = document.createElement('canvas'); canvas.width=vp.width|0; canvas.height=vp.height|0;
        const ctx = canvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        const blob = await new Promise(res=> canvas.toBlob(res, 'image/png'));
        const f = new File([blob], `${file.name.replace(/\.[a-z0-9]+$/i,'')}-p${pageNum}.png`, { type:'image/png' });
        const bmp = await fileToBitmap(f);
        const pageObj = this.state.addPage(f.name, bmp);
        pageObj.thumbDataUrl = await this._bitmapToThumb(bmp);
        await this._applyEnhancements(pageObj);
        this._toast('Page imported from PDF', 'ok');
        close();
      }catch(err){ console.error(err); alert('Failed to import page: '+(err?.message||err)); }
    });
    renderPage();
  }
  async _bitmapToThumb(bitmap){
    const max=160; const r = Math.max(bitmap.width, bitmap.height); const s = max/r; const w=(bitmap.width*s)|0, h=(bitmap.height*s)|0;
    const c=document.createElement('canvas'); c.width=w; c.height=h; const ctx=c.getContext('2d'); ctx.imageSmoothingEnabled=false; ctx.drawImage(bitmap,0,0,bitmap.width,bitmap.height,0,0,w,h); return c.toDataURL('image/png');
  }
  _refreshThumbs(){
    const wrap=this.thumbsWrap; wrap.innerHTML='';
    this.state.pages.forEach((p,idx)=>{
      const el=document.createElement('div'); el.className='thumb'+(idx===this.state.current?' active':'');
      el.innerHTML = `<img alt="${p.name}">${''}<div class="meta"><span>${idx+1}</span><span>${p.bitmap.width}×${p.bitmap.height}</span></div>`;
      const img=el.querySelector('img'); img.src = p.thumbDataUrl || '';
      const delBtn=document.createElement('button'); delBtn.className='del'; delBtn.title='Delete'; delBtn.textContent='×'; el.appendChild(delBtn);
      delBtn.addEventListener('click', (e)=>{ e.stopPropagation(); const ok=confirm('Delete this page?'); if(!ok) return; this._pushUndo('delete-page'); this.state.removePage(p.id); this._updateUndoRedoButtons && this._updateUndoRedoButtons(); });
      el.addEventListener('click', ()=>this.state.setCurrent(idx));
      wrap.appendChild(el);
    });
  }
  async _applyEnhancements(pageOverride){
    const p = pageOverride || this.state.page; if(!p) return;
    this._debug('enhance:start', {pageIndex:this.state.current});
    p.enhance = {
      brightness: +this.brightness.value,
      contrast: +this.contrast.value,
      threshold: +this.threshold.value,
      invert: this.invert.checked,
      grayscale: this.gray.checked,
      sharpen: +this.sharpen.value,
    };
    const base = p.cvCanvas || p.bitmap;
    // If in an enhancement session, we already pushed undo at start; otherwise, push once here
    if(!this._enhHistoryActive){ this._pushUndoIfNeeded && this._pushUndoIfNeeded('enhance'); }
    p.processedCanvas = await applyEnhancements(base, p.enhance);
    this._debug('enhance:done', {canvas:{w:p.processedCanvas.width,h:p.processedCanvas.height}});
    // Invalidate wire graph when visuals change
    p._graphReady=false; p._graphStamp='';
    if(p===this.state.page) this.viewer.requestRender(true);
    // Refresh vector preview if enabled
    try{ if(this.cvPreview?.checked) { await this._cvEnsureGraphBuilt(p); await this._buildAndShowVectorOverlay(); } }catch(_){ }
  }
  _updateScale(){
    const p=this.state.page; if(!p) return;
    p.scale.unit = this.unitSel.value; p.scale.pixelsPerUnit = parseFloat(this.ppuInput.value)||p.scale.pixelsPerUnit;
    this.viewer.requestRender();
  }
  _addAnnotation(a){
    const p=this.state.page; if(!p) return; const layerId = p.activeLayerId || (p.layers[0]&&p.layers[0].id) || 'default';
    const ann={ id:uuid(), layerId, ...a };
    this._pushUndoIfNeeded('add-annotation');
    p.annotations.push(ann); this.viewer.requestRender();
    this._queueAutosave();
    this._updateUndoRedoButtons && this._updateUndoRedoButtons();
  }
  _addMeasure(start,last){
    const p=this.state.page; if(!p) return; const dx=last.x-start.x, dy=last.y-start.y; const pix=Math.hypot(dx,dy);
    const real = (pix / p.scale.pixelsPerUnit).toFixed(2) + ' ' + p.scale.unit;
    this._addAnnotation({type:'measure', points:[start,last], props:{label: real}});
  }
  async _highlightAt(world){
    const p=this.state.page; if(!p) return;
    return this._withHistory('highlight', async()=>{
    try{
      // Prefer graph-based tracing if worker available
      try{
        if(!(window.cvWorker && window.cvWorkerReady)){
          await loadOpenCV(this.cvLoad);
        }
        const built = await this._cvEnsureGraphBuilt(p);
        if(built){
          const stopAt = this.hlStop ? !!this.hlStop.checked : true;
          if(!stopAt){
            const paths = await this._cvTraceComponent(p, world.x|0, world.y|0);
            if(paths && paths.length){
              const w = +(this.hlWidth?.value||6);
              let count=0;
              for(const pts of paths){ if(pts && pts.length>=2){ this._addAnnotation({type:'highlight', points:pts.map(pt=>({x:pt.x,y:pt.y})), props:{color:(this.hlColor?.value||'#ffd166'), width:w}}); count++; } }
              this._debug('highlight:graph-component', {paths: paths.length, drawn: count});
              return;
            }
          }
          const path = await this._cvTracePath(p, world.x|0, world.y|0);
          if(path && path.length>=2){
            const w = +(this.hlWidth?.value||6);
            this._addAnnotation({type:'highlight', points:path.map(pt=>({x:pt.x,y:pt.y})), props:{color:(this.hlColor?.value||'#ffd166'), width:w}});
            this._debug('highlight:graph', {len:path.length});
            return;
          }
        }
      }catch(e){ this._debug('highlight:graph:error', String(e&&e.message||e)); }
      // First try a quick, local scan-based detector (no OpenCV needed)
      const seg = this._scanForLineSegment(world.x|0, world.y|0);
      if(seg){
        const out = this._extendFromClick(world) || seg; const w = +(this.hlWidth?.value||6);
        this._addAnnotation({type:'highlight', points:[{x:out.x1,y:out.y1},{x:out.x2,y:out.y2}], props:{color:(this.hlColor?.value||'#ffd166'), width:w}});
        this._debug('highlight:scan', out);
        return;
      }
    }catch(_){ }
    // If scan fails, try OpenCV-based detection. If worker not loaded, attempt to load it (non-blocking to UI).
    try{
      if(!(window.cvWorker && window.cvWorkerReady)){
        this._debug('highlight:load-cv', {x:world.x,y:world.y});
        try{ await loadOpenCV(this.cvLoad); }catch(e){ this._debug('highlight:load-cv:error', String(e&&e.message||e)); this._toast('OpenCV load failed', 'error'); return }
      }
      const seg = await this._cvFindNearestLine(world.x, world.y);
      if(seg){
        const axis = (Math.abs(seg.x2-seg.x1)>=Math.abs(seg.y2-seg.y1))?'h':'v';
        const out = this._extendFromClick(world, axis) || seg; const w = +(this.hlWidth?.value||6);
        this._addAnnotation({type:'highlight', points:[{x:out.x1,y:out.y1},{x:out.x2,y:out.y2}], props:{color:(this.hlColor?.value||'#ffd166'), width:w}});
        this._debug('highlight:cv', out);
      } else {
        this._debug('highlight:none', { x:world.x, y:world.y });
      }
    }catch(e){ this._debug('highlight:cv:error', String(e&&e.message||e)); }
    });
  }
  _scanForLineSegment(cx, cy){
    const p=this.state.page; if(!p) return null;
    const src = p.processedCanvas || p.cvCanvas || this._sourceCanvas();
    if(!src) return null; const w=src.width, h=src.height; if(cx<0||cy<0||cx>=w||cy>=h) return null;
    const ctx = src.getContext('2d');
    const clampXY=(v,lo,hi)=>v<lo?lo:v>hi?hi:v;
    const thickness = 3; const stripe = thickness*2+1; const gapTol=3; const minLen=12; // stricter gaps and min length
    // Use a local window to avoid false positives far away
    const win = Math.max(40, Math.min(140, (Math.max(w,h)*0.05)|0));
    const xL = clampXY(cx-win, 0, w-1), xR = clampXY(cx+win, 0, w-1);
    const yT = clampXY(cy-win, 0, h-1), yB = clampXY(cy+win, 0, h-1);
    // Estimate background brightness near click
    const patch = ctx.getImageData(xL, yT, xR-xL+1, yB-yT+1).data;
    let sum=0, count=0; for(let i=0;i<patch.length;i+=4){ const r=patch[i],g=patch[i+1],b=patch[i+2]; sum += (0.2126*r+0.7152*g+0.0722*b); count++; }
    const bg = sum/Math.max(1,count);
    const darkThr = Math.max(0, Math.min(255, bg - 40));
    const brightThr = Math.max(0, Math.min(255, bg + 40));
    const preferDark = bg > 140; // white-ish background => lines are dark
    const isLinePix = (l)=> preferDark ? (l <= darkThr) : (l >= brightThr);
    // Seed check: ensure there are line-like pixels very near the click
    {
      const seedRad=2; const sx = clampXY(cx-seedRad,0,w-1), sy=clampXY(cy-seedRad,0,h-1);
      const sw = Math.min(w-1, cx+seedRad) - sx + 1; const sh = Math.min(h-1, cy+seedRad) - sy + 1;
      const seed = ctx.getImageData(sx, sy, sw, sh).data; let hits=0; for(let i=0;i<seed.length;i+=4){ const r=seed[i],g=seed[i+1],b=seed[i+2]; const l=(0.2126*r+0.7152*g+0.0722*b)|0; if(isLinePix(l)) hits++; }
      if(hits < 6) return null; // not close enough to any stroke, bail out early
    }
    // Horizontal stripe within local window
    const y0 = clampXY(cy-thickness,0,h-1); const yH = clampXY(cy+thickness,0,h-1);
    const imgH = ctx.getImageData(xL, y0, xR-xL+1, yH-y0+1); const dH=imgH.data; const rows=yH-y0+1; const colsH=(xR-xL+1);
    const colHits = new Uint16Array(colsH);
    for(let y=0;y<rows;y++){
      for(let x=0;x<colsH;x++){
        const i=((y*colsH+x)<<2); const r=dH[i],g=dH[i+1],b=dH[i+2]; const l=(0.2126*r+0.7152*g+0.0722*b)|0; if(isLinePix(l)) colHits[x]++;
      }
    }
    const isH=(x)=>colHits[x] >= Math.max(1, stripe-1);
    let L=cx, R=cx, miss=0; while(L>xL){ if(isH(L-1-xL)) { L--; miss=0 } else { miss++; if(miss>gapTol) break } }
    miss=0; while(R<xR){ if(isH(R+1-xL)) { R++; miss=0 } else { miss++; if(miss>gapTol) break } }
    const lenH = R-L;
    // Vertical stripe within local window
    const x0 = clampXY(cx-thickness,0,w-1); const xV = clampXY(cx+thickness,0,w-1);
    const imgV = ctx.getImageData(x0, yT, xV-x0+1, yB-yT+1); const dV=imgV.data; const colsV=(xV-x0+1); const rowsV=(yB-yT+1);
    const rowHits = new Uint16Array(rowsV);
    for(let y=0;y<rowsV;y++){
      for(let x=0;x<colsV;x++){
        const i=((y*colsV+x)<<2); const r=dV[i],g=dV[i+1],b=dV[i+2]; const l=(0.2126*r+0.7152*g+0.0722*b)|0; if(isLinePix(l)) rowHits[y]++;
      }
    }
    const isV=(y)=>rowHits[y] >= Math.max(1, stripe-1);
    let T=cy, B=cy; miss=0; while(T>yT){ if(isV(T-1-yT)) { T--; miss=0 } else { miss++; if(miss>gapTol) break } }
    miss=0; while(B<yB){ if(isV(B+1-yT)) { B++; miss=0 } else { miss++; if(miss>gapTol) break } }
    const lenV = B-T;
    const bestLen = Math.max(lenH, lenV);
    if(bestLen < minLen) return null;
    if(lenH>=lenV){ return { x1:L, y1:cy, x2:R, y2:cy, kind:'h'} } else { return { x1:cx, y1:T, x2:cx, y2:B, kind:'v'} }
  }
  async _cvFindNearestLine(px, py){
    const p=this.state.page; if(!p) return null;
    if(!(window.cvWorker && window.cvWorkerReady)) return null;
    const s = this._sourceCanvas(); if(!s) return null; const w=s.width, h=s.height;
    // Build a small ROI around the click and send to worker
    const pad = Math.max(30, Math.min(120, (Math.max(w,h)*0.05)|0));
    const rx = Math.max(0, Math.min(w-1, Math.round(px-pad)));
    const ry = Math.max(0, Math.min(h-1, Math.round(py-pad)));
    const rw = Math.max(1, Math.min(w-rx, Math.round(2*pad)));
    const rh = Math.max(1, Math.min(h-ry, Math.round(2*pad)));
    const ctx = s.getContext('2d'); const imgData = ctx.getImageData(rx, ry, rw, rh);
    return new Promise((resolve)=>{
      const onMsg = (ev)=>{
        const d=ev.data||{}; if(d.type==='detectLine:result'){ window.cvWorker.removeEventListener('message', onMsg); resolve(d.seg||null) }
      };
      window.cvWorker.addEventListener('message', onMsg);
      window.cvWorker.postMessage({ type:'detectLine', roi:{ data:imgData.data.buffer, width:rw, height:rh, rx, ry }, click:{x:px,y:py} });
    });
  }

  // Robust axis-aligned extension from click: tries horizontal and vertical, picks longer
  _extendFromClick(world, prefer){
    const p=this.state.page; if(!p) return null; const src = p.processedCanvas || p.cvCanvas || this._sourceCanvas(); if(!src) return null;
    const w=src.width, h=src.height; const ctx=src.getContext('2d');
    const clamp=(v,a,b)=>v<a?a:v>b?b:v; const cx=clamp(Math.round(world.x),0,w-1), cy=clamp(Math.round(world.y),0,h-1);
    const localStats=()=>{ const win=80; const xL=clamp(cx-win,0,w-1), xR=clamp(cx+win,0,w-1), yT=clamp(cy-win,0,h-1), yB=clamp(cy+win,0,h-1); const patch=ctx.getImageData(xL,yT,xR-xL+1,yB-yT+1).data; let sum=0,c=0; for(let i=0;i<patch.length;i+=4){ const r=patch[i],g=patch[i+1],b=patch[i+2]; sum+=0.2126*r+0.7152*g+0.0722*b; c++; } const bg=sum/Math.max(1,c); return {bg, preferDark:bg>140, darkThr:Math.max(0,Math.min(255,bg-40)), brightThr:Math.max(0,Math.min(255,bg+40))} };
    const {preferDark,darkThr,brightThr} = localStats();
    const isLinePix=(l)=> preferDark ? (l<=darkThr):(l>=brightThr);
    const getLum=(x,y)=>{ const u=ctx.getImageData(x,y,1,1).data; return (0.2126*u[0]+0.7152*u[1]+0.0722*u[2])|0 };
    const stopAt = this.hlStop ? !!this.hlStop.checked : true;
    function extend(orient){
      const maxC=16; const maxStep=Math.max(w,h); let posX=cx, posY=cy;
      const crossWidthAt=(x,y)=>{ let run=0,best=0,center=0,cur=0,curStart=-1; for(let k=-maxC;k<=maxC;k++){ const xx=orient==='h'?clamp(x+k,0,w-1):x; const yy=orient==='h'?y:clamp(y+k,0,h-1); const l=getLum(xx,yy); const on=isLinePix(l); if(on){ if(cur===0){curStart=k} cur++; if(cur>best){best=cur; center=Math.round((curStart+k)/2)} } else { cur=0 } } return {width:best, centerOffset:center}; };
      let cw = crossWidthAt(posX,posY); if(orient==='h') posY=clamp(posY+cw.centerOffset,0,h-1); else posX=clamp(posX+cw.centerOffset,0,w-1);
      const baseWidth=Math.max(1,cw.width); const widenStop = stopAt ? Math.max(Math.round(baseWidth*1.8), baseWidth+3) : Number.POSITIVE_INFINITY; const shrinkStop=Math.max(1,Math.round(baseWidth*0.5)); const minStopSteps=Math.max(4,Math.round(baseWidth*1.5));
      const hasPerpBranch=(x,y)=>{
        if(!stopAt) return false; const reach=12, near=2; let best=0; if(orient==='h'){ for(let dx=-near; dx<=near; dx++){ const xx=clamp(x+dx,0,w-1); let run=0; for(let dy=-reach; dy<=reach; dy++){ const yy=clamp(y+dy,0,h-1); const l=getLum(xx,yy); if(isLinePix(l)){ run++; best=Math.max(best,run) } else { run=0 } } } } else { for(let dy=-near; dy<=near; dy++){ const yy=clamp(y+dy,0,h-1); let run=0; for(let dx=-reach; dx<=reach; dx++){ const xx=clamp(x+dx,0,w-1); const l=getLum(xx,yy); if(isLinePix(l)){ run++; best=Math.max(best,run) } else { run=0 } } } } return best>=8; };
      function walk(dir){
        let x=posX, y=posY, miss=0, steps=0, lastX=x, lastY=y;
        // Allow bigger gap-bridging for thicker strokes
        const missLimit = Math.max(6, Math.round(baseWidth * 2.5));
        while(steps++<maxStep){
          if(orient==='h'){
            x+=dir; if(x<0||x>=w) break; const m=crossWidthAt(x,y);
            if(m.width>=shrinkStop){
              lastX=x; lastY=y;
              if(steps>minStopSteps && (m.width>=widenStop || hasPerpBranch(x,y))){ break }
              miss=0;
            } else {
              if(++miss>missLimit) break;
            }
          } else {
            y+=dir; if(y<0||y>=h) break; const m=crossWidthAt(x,y);
            if(m.width>=shrinkStop){
              lastX=x; lastY=y;
              if(steps>minStopSteps && (m.width>=widenStop || hasPerpBranch(x,y))){ break }
              miss=0;
            } else {
              if(++miss>missLimit) break;
            }
          }
        }
        return {x:lastX,y:lastY,width:baseWidth};
      }
      const a=walk(-1), b=walk(1); const len = orient==='h'? Math.abs(b.x-a.x) : Math.abs(b.y-a.y); return { seg: orient==='h'?{x1:a.x,y1:a.y,x2:b.x,y2:b.y,kind:'h'}:{x1:a.x,y1:a.y,x2:b.x,y2:b.y,kind:'v'}, len, width:Math.max(4, Math.round(baseWidth*2.2)) };
    }
    const H=extend('h'), V=extend('v');
    // Prefer explicit axis if provided
    let pick = prefer==='h'?H : prefer==='v'?V : (H.len>=V.len?H:V);
    // Require a reasonable minimum length
    const minLen = Math.max(24, Math.round(Math.max(H.width,V.width)*6));
    if(pick.len < minLen && (Math.max(H.len,V.len) < minLen)){
      // both short -> reject (caller may fall back to CV or ignore)
      return null;
    }
    // If lengths are close but one is clearly axis-aligned longer, keep it
    if(!prefer && Math.abs(H.len - V.len) < 12){ pick = (H.len>=V.len?H:V) }
    return {...pick.seg, width:pick.width};
  }

  // Extend a detected segment along its axis until a junction dot/symbol or gap is detected.
  _extendLineFromSeed(seg, world){
    const p=this.state.page; if(!p) return null; const src = p.processedCanvas || p.cvCanvas || this._sourceCanvas(); if(!src) return null;
    const w=src.width, h=src.height; const ctx=src.getContext('2d');
    // Determine orientation from seg
    const dx=Math.abs(seg.x2-seg.x1), dy=Math.abs(seg.y2-seg.y1);
    const orient = (dx>=dy)?'h':'v';
    const clamp=(v,a,b)=>v<a?a:v>b?b:v;
    const cx = clamp(Math.round(world.x), 0, w-1); const cy = clamp(Math.round(world.y), 0, h-1);
    // Compute local brightness profile and thresholds
    const win = 80; const xL = clamp(cx-win,0,w-1), xR=clamp(cx+win,0,w-1); const yT=clamp(cy-win,0,h-1), yB=clamp(cy+win,0,h-1);
    const patch = ctx.getImageData(xL, yT, xR-xL+1, yB-yT+1).data; let sum=0,cnt=0; for(let i=0;i<patch.length;i+=4){ const r=patch[i],g=patch[i+1],b=patch[i+2]; sum+=0.2126*r+0.7152*g+0.0722*b; cnt++; }
    const bg=sum/Math.max(1,cnt); const preferDark = bg>140; const darkThr=Math.max(0,Math.min(255,bg-40)); const brightThr=Math.max(0,Math.min(255,bg+40));
    const isLinePix=(l)=> preferDark ? (l<=darkThr):(l>=brightThr);
    const getLum=(x,y)=>{ const id=ctx.getImageData(x,y,1,1).data; return (0.2126*id[0]+0.7152*id[1]+0.0722*id[2])|0 };
    // Detect a perpendicular branch (junction) near the current axis point
    const hasPerpBranch=(x,y)=>{
      if(!stopAt) return false;
      const reach = 12; const near=2; let bestRun=0;
      if(orient==='h'){
        for(let dx=-near; dx<=near; dx++){
          const xx = clamp(x+dx,0,w-1);
          // scan vertical up/down from y, looking for a contiguous run
          let run=0; for(let dy=-reach; dy<=reach; dy++){
            const yy = clamp(y+dy,0,h-1); const l=getLum(xx,yy); if(isLinePix(l)){ run++; bestRun=Math.max(bestRun,run) } else { run=0 }
          }
        }
      }else{
        for(let dy=-near; dy<=near; dy++){
          const yy = clamp(y+dy,0,h-1);
          let run=0; for(let dx=-reach; dx<=reach; dx++){
            const xx = clamp(x+dx,0,w-1); const l=getLum(xx,yy); if(isLinePix(l)){ run++; bestRun=Math.max(bestRun,run) } else { run=0 }
          }
        }
      }
      return bestRun>=8; // tuned length to qualify as a branch
    };
    const crossWidthAt=(x,y)=>{
      const maxC=16; let run=0,best=0,centerPos=0; let cur=0,curStart=-1;
      for(let k=-maxC;k<=maxC;k++){
        const xx = orient==='h'? clamp(x+k,0,w-1): x;
        const yy = orient==='h'? y: clamp(y+k,0,h-1);
        const l = getLum(xx,yy);
        const on = isLinePix(l);
        if(on){ if(cur===0){curStart=k;} cur++; if(cur>best){best=cur; centerPos=Math.round((curStart + k)/2)} }
        else { cur=0 }
      }
      return { width:best, centerOffset:centerPos };
    };
    // Align to center of stroke locally
    let posX=cx, posY=cy; const cw = crossWidthAt(posX,posY); if(orient==='h'){ posY = clamp(posY+cw.centerOffset,0,h-1) } else { posX = clamp(posX+cw.centerOffset,0,w-1) }
    const baseWidth = Math.max(1, cw.width);
    const stopAt = this.hlStop ? !!this.hlStop.checked : true;
    let widenStop = Math.max( Math.round(baseWidth*1.8), baseWidth+3 );
    if(!stopAt){ widenStop = Number.POSITIVE_INFINITY }
    const minStopSteps = Math.max(4, Math.round(baseWidth*1.5));
    const shrinkStop = Math.max(1, Math.round(baseWidth*0.5));
    const stepLimit = Math.max(w,h);
      function walk(dir){
        let x=posX, y=posY; let misses=0; let steps=0; let lastGoodX=x, lastGoodY=y;
        while(steps++<stepLimit){
        if(orient==='h'){
          x += dir; if(x<0||x>=w) break; const m=crossWidthAt(x,y);
          if(m.width>=shrinkStop){ lastGoodX=x; lastGoodY=y; if(steps>minStopSteps && (m.width>=widenStop || hasPerpBranch(x,y))){ break } misses=0 } else { if(++misses>6) break }
        } else {
          y += dir; if(y<0||y>=h) break; const m=crossWidthAt(x,y);
          if(m.width>=shrinkStop){ lastGoodX=x; lastGoodY=y; if(steps>minStopSteps && (m.width>=widenStop || hasPerpBranch(x,y))){ break } misses=0 } else { if(++misses>6) break }
        }
        }
        return {x:lastGoodX, y:lastGoodY};
      }
    const a = walk(-1), b = walk(1);
    const drawW = Math.max(4, Math.round(baseWidth*2.2));
    if(orient==='h'){ return { x1:a.x, y1:a.y, x2:b.x, y2:b.y, kind:'h', width:drawW } } else { return { x1:a.x, y1:a.y, x2:b.x, y2:b.y, kind:'v', width:drawW } }
  }
  _previewTwoPoint(a,b){
    const o=this.viewer.octx; this._clearPreview(); o.save(); o.strokeStyle='#ffffff88'; o.setLineDash([4,4]);
    const p1=this.viewer.worldToScreen(a.x,a.y), p2=this.viewer.worldToScreen(b.x,b.y);
    if(this.tool==='rect'){ const x=Math.min(p1.x,p2.x), y=Math.min(p1.y,p2.y), w=Math.abs(p1.x-p2.x), h=Math.abs(p1.y-p2.y); o.strokeRect(x,y,w,h) }
    if(this.tool==='arrow'||this.tool==='measure'){ o.beginPath(); o.moveTo(p1.x,p1.y); o.lineTo(p2.x,p2.y); o.stroke() }
    o.restore();
  }
  _clearPreview(){ /* redraw full overlay */ this.viewer.requestRender(); }
  _hotkeys(e){
    if(e.target.matches('input, textarea')) return;
    const v=this.viewer;
    if(e.key===' '){ e.preventDefault(); this.tool='pan'; this._syncToolButtons(); return }
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='o'){ e.preventDefault(); this.fileInput.click(); return }
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){ e.preventDefault(); this._exportProject(); return }
    if((e.ctrlKey||e.metaKey)&&!e.shiftKey&&e.key.toLowerCase()==='z'){ e.preventDefault(); this.undo(); return }
    if(((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='y') || ((e.ctrlKey||e.metaKey)&&e.shiftKey&&e.key.toLowerCase()==='z')){ e.preventDefault(); this.redo(); return }
    if(e.key==='+'){ v.zoomAt(1.2, v.w/2, v.h/2); return }
    if(e.key==='-'){ v.zoomAt(1/1.2, v.w/2, v.h/2); return }
    if(e.key==='0'){ v.fit(); return }
    if(e.key==='1'){ this.tool='pan'; this._syncToolButtons(); return }
    if(e.key==='2'){ this.tool='rect'; this._syncToolButtons(); return }
    if(e.key==='3'){ this.tool='arrow'; this._syncToolButtons(); return }
    if(e.key==='4'){ this.tool='text'; this._syncToolButtons(); return }
    if(e.key==='5'){ this.tool='measure'; this._syncToolButtons(); return }
    if(e.key==='6'){ this.tool='highlight'; this._syncToolButtons(); return }
    // Symbol rotation + delete when a symbol is selected
    if(this._selectedAnnId){
      const ann = this._findAnnotationById(this._selectedAnnId);
      if(ann && ann.type==='symbol'){
        if(e.key.toLowerCase()==='q'){ e.preventDefault(); ann.props = ann.props||{}; ann.props.angle = ((ann.props.angle||0) - 15) % 360; this.viewer.requestRender(); return }
        if(e.key.toLowerCase()==='e'){ e.preventDefault(); ann.props = ann.props||{}; ann.props.angle = ((ann.props.angle||0) + 15) % 360; this.viewer.requestRender(); return }
        if(e.key==='Delete' || e.key==='Backspace'){ e.preventDefault(); const p=this.state.page; if(p){ const i=p.annotations.findIndex(a=>a.id===ann.id); if(i>=0){ this._pushUndo('delete-symbol'); p.annotations.splice(i,1); this._selectedAnnId=null; this.viewer.selectedId=null; this.viewer.requestRender(); this._updateUndoRedoButtons && this._updateUndoRedoButtons(); } } return }
      }
      if(ann && ann.type==='text'){
        if(e.key==='Delete' || e.key==='Backspace'){ e.preventDefault(); const p=this.state.page; if(p){ const i=p.annotations.findIndex(a=>a.id===ann.id); if(i>=0){ this._pushUndo('delete-text'); p.annotations.splice(i,1); this._selectedAnnId=null; this.viewer.selectedId=null; this.viewer.requestRender(); this._updateUndoRedoButtons && this._updateUndoRedoButtons(); this._syncTextControls && this._syncTextControls(); } } return }
      }
    }
  }
  _findAnnotationById(id){ const p=this.state.page; if(!p) return null; return (p.annotations||[]).find(a=>a.id===id) || null }
  _pickSymbolAt(wx, wy){
    const p=this.state.page; if(!p) return null; const anns=p.annotations||[];
    for(let i=anns.length-1;i>=0;i--){ const a=anns[i]; if(a.type!=='symbol') continue; const pt=a.points&&a.points[0]; if(!pt) continue; const dx=wx-pt.x, dy=wy-pt.y; const dist=Math.hypot(dx,dy); if(dist < 30/ (this.viewer.state.scale||1)){ return a; } }
    return null;
  }
  _pickTextAt(wx, wy){
    const p=this.state.page; if(!p) return null; const anns=p.annotations||[];
    for(let i=anns.length-1;i>=0;i--){ const a=anns[i]; if(a.type!=='text') continue; const pt=a.points&&a.points[0]; if(!pt) continue; const dx=wx-pt.x, dy=wy-pt.y; const dist=Math.hypot(dx,dy); if(dist < 24/ (this.viewer.state.scale||1)){ return a; } }
    return null;
  }
  async _addSymbol(kind, x, y){
    this._debug && this._debug('symbols:add:begin', { kind, at:{x:x|0,y:y|0} });
    let p=this.state.page;
    if(!p){
      try{
        // Create a blank page matching current viewer size (fallback to 2000x1400)
        const vw = Math.max(800, this.viewer?.w || 2000);
        const vh = Math.max(600, this.viewer?.h || 1400);
        const c=document.createElement('canvas'); c.width=vw; c.height=vh; const ctx=c.getContext('2d'); ctx.fillStyle='#ffffff'; ctx.fillRect(0,0,vw,vh);
        const bmp = await createImageBitmap(c);
        p = this.state.addPage('Blank', bmp);
        this.viewer.fit();
      }catch(_){ this._toast('Could not create page','error'); return }
    }
    const color = this.symColor?.value || '#000000';
    const props = { kind, angle:0, scale:1, color };
    if(kind==='5v'){ props.label='5V'; props.kind='5v'; }
    if(kind==='3v3'){ props.label='3.3V'; props.kind='3v3'; }
    const ann = { id:uuid(), type:'symbol', layerId:p.activeLayerId, points:[{x,y}], props };
    this._pushUndo('add-symbol');
    p.annotations.push(ann); this._selectedAnnId = ann.id; this.viewer.selectedId = ann.id; this.viewer.requestRender(); this._updateUndoRedoButtons && this._updateUndoRedoButtons();
    this._toast && this._toast(`Placed ${props.kind}`);
    this._debug && this._debug('symbols:add:done', { id:ann.id, layer:ann.layerId });
  }
  async _addText(x, y){
    let p=this.state.page;
    if(!p){
      try{
        const vw = Math.max(800, this.viewer?.w || 2000);
        const vh = Math.max(600, this.viewer?.h || 1400);
        const c=document.createElement('canvas'); c.width=vw; c.height=vh; const ctx=c.getContext('2d'); ctx.fillStyle='#ffffff'; ctx.fillRect(0,0,vw,vh);
        const bmp = await createImageBitmap(c);
        p = this.state.addPage('Blank', bmp);
        this.viewer.fit();
      }catch(_){ this._toast('Could not create page','error'); return }
    }
    const text = prompt('Enter text');
    if(!text) return;
    const color = this.symColor?.value || '#000000';
    const ann = { id:uuid(), type:'text', layerId:p.activeLayerId, points:[{x,y}], text, props:{ color } };
    this._pushUndo('add-text');
    p.annotations.push(ann); this._selectedAnnId = ann.id; this.viewer.selectedId = ann.id; this.viewer.requestRender(); this._updateUndoRedoButtons && this._updateUndoRedoButtons(); this._syncTextControls && this._syncTextControls();
  }
  async _exportProject(){
    const proj = { version:2, pages:[] };
    for(const p of this.state.pages){
      // original image
      const c = document.createElement('canvas'); c.width=p.bitmap.width; c.height=p.bitmap.height; const ctx=c.getContext('2d'); ctx.drawImage(p.bitmap,0,0);
      const dataUrl = c.toDataURL('image/png');
      // opencv base if any
      let cvUrl = null; if(p.cvCanvas){ cvUrl = p.cvCanvas.toDataURL('image/png') }
      proj.pages.push({ name:p.name, image:dataUrl, imageCv:cvUrl, enhance:p.enhance, layers:p.layers, activeLayerId:p.activeLayerId, annotations:p.annotations, scale:p.scale });
    }
    const blob = new Blob([JSON.stringify(proj)], {type:'application/json'});
    const url = await toDataURL(blob); download(`schematic-project.json`, url);
    this._saveLastSession(proj).catch(console.warn);
  }
  async _loadProject(proj){
    if(proj?.version!==2 || !Array.isArray(proj.pages)) throw new Error('Invalid project file');
    // Reset state
    this.state.pages = []; this.state.current = -1;
    for(const pg of proj.pages){
      const resp = await fetch(pg.image); const blob = await resp.blob(); const bmp = await createImageBitmap(blob);
      const p = this.state.addPage(pg.name||'Page', bmp);
      p.enhance = pg.enhance||p.enhance; p.layers=pg.layers||p.layers; p.annotations=pg.annotations||[]; p.scale=pg.scale||p.scale; p.activeLayerId = pg.activeLayerId || (p.layers[0]&&p.layers[0].id) || 'default';
      // map orphan annotations to first layer
      const ids = new Set(p.layers.map(l=>l.id)); p.annotations.forEach(a=>{ if(!ids.has(a.layerId)) a.layerId=p.activeLayerId });
      p.thumbDataUrl = await this._bitmapToThumb(bmp);
      if(pg.imageCv){ const cvResp = await fetch(pg.imageCv); const cvBlob = await cvResp.blob(); const cvBmp = await createImageBitmap(cvBlob); const c = document.createElement('canvas'); c.width=cvBmp.width; c.height=cvBmp.height; c.getContext('2d').drawImage(cvBmp,0,0); p.cvCanvas=c; }
      await this._applyEnhancements(p);
    }
    this.state.setCurrent(0);
    this._queueAutosave();
    this._toast('Project loaded', 'ok');
  }
  _setupAutosave(){
    this._autosaveTimer=null; this._autosaveDebounce=()=>{ clearTimeout(this._autosaveTimer); this._autosaveTimer=setTimeout(()=>this._doAutosave(), 800) };
    this._queueAutosave=()=>this._autosaveDebounce();
    window.addEventListener('beforeunload', ()=>this._doAutosave());
    // Try load last session
    try{
      const hash = (location.hash||'');
      if(hash.includes('clean') || hash.includes('noresume')){
        this._debug('resume:skipped', { reason: 'hash' });
      } else {
        this._loadLastSession().catch(()=>{});
      }
    }catch(_){ }
  }
  async _doAutosave(){
    const proj = await this._projectSnapshot();
    await this._saveLastSession(proj);
  }
  async _projectSnapshot(){
    const proj = { version:2, pages:[] };
    for(const p of this.state.pages){
      const c = document.createElement('canvas'); c.width=p.bitmap.width; c.height=p.bitmap.height; const ctx=c.getContext('2d'); ctx.drawImage(p.bitmap,0,0);
      const dataUrl = c.toDataURL('image/png');
      proj.pages.push({ name:p.name, image:dataUrl, enhance:p.enhance, layers:p.layers, annotations:p.annotations, scale:p.scale });
    }
    return proj;
  }
  async _saveLastSession(obj){
    const db = await openDB('schematic-studio', 1, (db)=>{ if(!db.objectStoreNames.contains('kv')) db.createObjectStore('kv') });
    const tx = db.transaction('kv','readwrite'); tx.objectStore('kv').put(obj,'last'); await tx.done;
  }
  async _loadLastSession(){
    const db = await openDB('schematic-studio', 1, (db)=>{ if(!db.objectStoreNames.contains('kv')) db.createObjectStore('kv') });
    const tx = db.transaction('kv'); const os = tx.objectStore('kv'); const obj = await idbReq(os.get('last')); await tx.done;
    if(obj && obj.pages?.length){ await this._loadProject(obj) }
  }
}

// History (Undo/Redo)
AppUI.prototype._clonePageForHistory = function(p){
  return {
    id: p.id,
    name: p.name,
    bitmap: p.bitmap,
    processedCanvas: p.processedCanvas,
    thumbDataUrl: p.thumbDataUrl,
    enhance: { ...p.enhance },
    layers: (p.layers||[]).map(l=>({ ...l })),
    activeLayerId: p.activeLayerId,
    annotations: (p.annotations||[]).map(a=>({
      id: a.id,
      type: a.type,
      layerId: a.layerId,
      text: a.text,
      props: a.props?{...a.props}:undefined,
      points: (a.points||[]).map(pt=>({x:pt.x, y:pt.y}))
    })),
    scale: { ...p.scale },
    vectorOverlayUrl: p.vectorOverlayUrl,
    vectorOverlayOpts: p.vectorOverlayOpts,
    cvCanvas: p.cvCanvas,
  };
};

AppUI.prototype._snapshotState = function(){
  return {
    current: this.state.current,
    pages: this.state.pages.map(p=>this._clonePageForHistory(p))
  };
};

AppUI.prototype._restoreState = function(snap){
  if(!snap) return;
  this.state.pages = snap.pages.map(p=>({
    ...p,
    layers: (p.layers||[]).map(l=>({ ...l })),
    annotations: (p.annotations||[]).map(a=>({ ...a, points: (a.points||[]).map(pt=>({x:pt.x,y:pt.y})) }))
  }));
  this.state.current = Math.max(0, Math.min(this.state.pages.length-1, snap.current|0));
  try{ this.state.emit('pages'); }catch(_){ }
  try{ this.state.emit('current'); }catch(_){ }
  this.viewer.requestRender(true);
  this._queueAutosave && this._queueAutosave();
};

AppUI.prototype._pushUndo = function(label){
  try{
    const snap = this._snapshotState();
    this._undoStack.push({ label, snap });
    if(this._undoStack.length > this._historyLimit){ this._undoStack.shift(); }
    this._redoStack = [];
  }catch(e){ this._debug && this._debug('history:push:error', String(e&&e.message||e)); }
};

// History helpers: batching so multi-add highlight is one step
AppUI.prototype._withHistory = async function(label, fn){
  this._historyBatchDepth = (this._historyBatchDepth||0) + 1;
  if(this._historyBatchDepth === 1){ this._historyDeferPush = true; this._historyDeferredLabel = label; }
  try{
    return await fn();
  } finally {
    this._historyBatchDepth -= 1;
    if(this._historyBatchDepth <= 0){ this._historyBatchDepth = 0; this._historyDeferPush = false; this._historyDeferredLabel = ''; this._updateUndoRedoButtons && this._updateUndoRedoButtons(); }
  }
};

AppUI.prototype._pushUndoIfNeeded = function(label){
  if(this._historyBatchDepth && this._historyDeferPush){ this._pushUndo(this._historyDeferredLabel || label); this._historyDeferPush = false; return; }
  if(!this._historyBatchDepth){ this._pushUndo(label); }
};

AppUI.prototype.undo = function(){
  if(!this._undoStack.length){ this._toast && this._toast('Nothing to undo'); return; }
  try{
    const curr = this._snapshotState();
    const { label, snap } = this._undoStack.pop();
    this._redoStack.push({ label, snap: curr });
    this._restoreState(snap);
    this._toast && this._toast('Undid: '+(label||'action'));
  }catch(e){ this._debug && this._debug('history:undo:error', String(e&&e.message||e)); }
  this._updateUndoRedoButtons && this._updateUndoRedoButtons();
};

AppUI.prototype.redo = function(){
  if(!this._redoStack.length){ this._toast && this._toast('Nothing to redo'); return; }
  try{
    const curr = this._snapshotState();
    const { label, snap } = this._redoStack.pop();
    this._undoStack.push({ label, snap: curr });
    this._restoreState(snap);
    this._toast && this._toast('Redid: '+(label||'action'));
  }catch(e){ this._debug && this._debug('history:redo:error', String(e&&e.message||e)); }
  this._updateUndoRedoButtons && this._updateUndoRedoButtons();
};

AppUI.prototype._updateUndoRedoButtons = function(){
  try{ if(this.undoBtn) this.undoBtn.disabled = this._undoStack.length===0; }catch(_){ }
  try{ if(this.redoBtn) this.redoBtn.disabled = this._redoStack.length===0; }catch(_){ }
};


// OCR + text region helpers
AppUI.prototype._cvDetectTextRegions = async function(options){
  const p=this.state.page; if(!p) return [];
  if(!(window.cvWorker && window.cvWorkerReady)){ try{ await loadOpenCV(this.cvLoad) }catch(_){ return [] } }
  const c = this._sourceCanvas(); if(!c) return [];
  const ctx=c.getContext('2d', { willReadFrequently: true }); const img=ctx.getImageData(0,0,c.width,c.height);
  return await new Promise((resolve)=>{
    const w=window.cvWorker; const onMsg=(ev)=>{ const d=ev.data||{}; if(d.type==="textRegions:result"){ try{ w.removeEventListener("message", onMsg) }catch(_){ } resolve(d.rects||[]) } };
    w.addEventListener("message", onMsg);
    w.postMessage({ type:"textRegions", image:{ data:new Uint8ClampedArray(img.data), width:c.width, height:c.height }, options: options||{} });
    setTimeout(()=>{ try{ w.removeEventListener("message", onMsg) }catch(_){ } resolve([]); }, 5000);
  });
};

AppUI.prototype._runOcrReplace = async function(){
  const p=this.state.page; if(!p) return;
  const ok = await loadOCR(); if(!ok){ this._toast("OCR could not start","error"); return }
  const rects = await this._cvDetectTextRegions({ strength:2 });
  if(!rects || rects.length===0){ this._toast("No text regions found"); return }
  const c = this._sourceCanvas(); if(!c) return; const ctx=c.getContext('2d', { willReadFrequently: true });
  const minConf = parseInt(this.cvOcrConf?.value||"65")|0; const erase = this.cvOcrErase ? !!this.cvOcrErase.checked : true;
  let ocrLayer = (p.layers||[]).find(l=>/\bOCR\b/i.test(l.name||"")); if(!ocrLayer){ const id=uuid(); ocrLayer={id,name:"OCR",visible:true}; p.layers.push(ocrLayer); }
  const prevActive = p.activeLayerId; p.activeLayerId = ocrLayer.id;
  const stopBatch = this._beginHistoryBatch && this._beginHistoryBatch("ocr-replace");
  if(erase && !p.cvCanvas){ const clone=document.createElement("canvas"); clone.width=c.width; clone.height=c.height; clone.getContext('2d').drawImage(c,0,0); p.cvCanvas=clone; }
  const ectx = p.cvCanvas ? p.cvCanvas.getContext('2d') : null;
  let placed=0;
  const w=window.ocrWorker;
  const recognize = (image)=> new Promise((resolve)=>{
    const id=uuid(); const onMsg=(ev)=>{ const d=ev.data||{}; if(d.type==="recognize:result" && d.id===id){ try{ w.removeEventListener("message", onMsg) }catch(_){ } resolve({ text:d.text||"", conf:+(d.confidence||0) }); } };
    w.addEventListener("message", onMsg);
    w.postMessage({ type:"recognize", id, image });
    setTimeout(()=>{ try{ w.removeEventListener("message", onMsg) }catch(_){ } resolve({text:"",conf:0}); }, 8000);
  });
  const maxRects = Math.min(rects.length, 300); rects.sort((a,b)=> (a.w*a.h)-(b.w*b.h));
  for(let i=0;i<maxRects;i++){
    const r=rects[i]; if(r.w<6||r.h<6) continue;
    const roi = ctx.getImageData(r.x, r.y, r.w, r.h);
    const { text, conf } = await recognize({ data:new Uint8ClampedArray(roi.data), width:r.w, height:r.h });
    const norm = (text||"").replace(/\s+/g," ").trim(); if(!norm || conf < minConf) continue;
    const cx = r.x + r.w/2, cy = r.y + r.h/2;
    this._addAnnotation({ type:"text", points:[{x:cx,y:cy}], text: norm, props:{color:"#e8ecf1"} });
    if(erase && ectx){ ectx.save(); ectx.fillStyle="#ffffff"; const pad=2; ectx.fillRect(Math.max(0,r.x-pad), Math.max(0,r.y-pad), Math.min(p.cvCanvas.width, r.w+pad*2), Math.min(p.cvCanvas.height, r.h+pad*2)); ectx.restore(); }
    placed++;
  }
  p.activeLayerId = prevActive; await this._applyEnhancements(p); try{ stopBatch && stopBatch(); }catch(_){ }
  this._toast(`OCR placed ${placed} labels`);
};
// Boot once DOM is ready
document.addEventListener('DOMContentLoaded', ()=>{
  const app = new AppUI();
});

// Tiny IndexedDB helper (no external deps)
function openDB(name, version, upgrade){
  return new Promise((resolve, reject)=>{
    const req = indexedDB.open(name, version);
    req.onupgradeneeded = (e)=>upgrade && upgrade(req.result, e.oldVersion, e.newVersion);
    req.onerror = ()=>reject(req.error);
    req.onsuccess = ()=>{
      const idb = req.result;
      const nativeTx = idb.transaction.bind(idb);
      resolve({
        transaction(store,mode='readonly'){
          const tx = nativeTx(store, mode);
          return {
            objectStore(name){ return tx.objectStore(name||store) },
            get done(){ return new Promise((res,rej)=>{ tx.oncomplete=()=>res(); tx.onerror=()=>rej(tx.error) }) }
          }
        },
        close(){ try{idb.close()}catch(_){} }
      });
    }
  });
}

function idbReq(req){ return new Promise((res,rej)=>{ req.onsuccess=()=>res(req.result); req.onerror=()=>rej(req.error) }) }

// Toast helper
AppUI.prototype._setupToast = function(){ this.toast = document.getElementById('toast') }
AppUI.prototype._toast = function(msg, kind='ok'){ if(!this.toast) return; this.toast.className = `toast show ${kind==='error'?'error':'ok'}`; this.toast.textContent = msg; clearTimeout(this._toastTimer); this._toastTimer = setTimeout(()=>{ this.toast.classList.remove('show') }, 2500) }


// OCR loader
async function loadOCR(){
  if(window.ocrWorker && window.ocrWorkerReady) return true;
  try{
    const w = new Worker('ocr-worker.js');
    window.ocrWorker = w; window.ocrWorkerReady = false;
    return await new Promise((resolve)=>{
      const onMsg=(ev)=>{ const d=ev.data||{}; if(d.type==='ready'){ try{ w.removeEventListener('message', onMsg) }catch(_){ } window.ocrWorkerReady=true; resolve(true); } };
      w.addEventListener('message', onMsg);
      w.postMessage({type:'init'});
      setTimeout(()=>{ try{ w.removeEventListener('message', onMsg) }catch(_){ } resolve(true); }, 3000);
    });
  }catch(e){ console.warn('OCR worker failed', e); return false; }
}
// OpenCV loader
function loadOpenCV(button){
  // Spawn a worker that loads OpenCV off the main thread. Resolves when ready.
  return new Promise((resolve, reject)=>{
    // File protocol caveat: loading opencv.js from HTTPS inside a worker
    // is blocked in some browsers when the page is served via file://.
    // In that case, guide the user to run from http(s).
    try{
      if(location.protocol==='file:'){
        console.warn('OpenCV load blocked under file: protocol. Serve over http(s).');
        const err = new Error('OpenCV requires http(s) context');
        // Friendly toast if available
        try{ (window.__appUIInstance?._toast||(()=>{}))('OpenCV requires http(s). Open docs/ via http://localhost', 'error') }catch(_){ }
        reject(err); return;
      }
    }catch(_){ }
    if(window.cvWorker && window.cvWorkerReady){ resolve('worker'); return }
    const prevTxt = button?button.textContent:''; if(button){ button.disabled=true; button.textContent='Loading…' }
    try{
      const w = new Worker('cv-worker.js');
      w.onmessage = (ev)=>{
        const d=ev.data||{};
        if(d.type==='ready'){
          window.cvWorker = w; window.cvWorkerReady = true;
          if(button){ button.disabled=false; button.textContent=prevTxt }
          resolve('worker');
        } else if(d.type==='error'){
          if(button){ button.disabled=false; button.textContent=prevTxt }
          reject(new Error(d.error||'Worker error'));
        }
      };
      w.onerror = (e)=>{ if(button){ button.disabled=false; button.textContent=prevTxt } reject(new Error(e.message||'Worker failed')) };
      w.postMessage({type:'init'});
    }catch(e){ if(button){ button.disabled=false; button.textContent=prevTxt } reject(e) }
  });
}

// OpenCV operations
  AppUI.prototype._sourceCanvas = function(){ const p=this.state.page; if(!p) return null; if(p.cvCanvas) return p.cvCanvas; const c=document.createElement('canvas'); c.width=p.bitmap.width; c.height=p.bitmap.height; c.getContext('2d', { willReadFrequently: true }).drawImage(p.bitmap,0,0); return c };

// Graph build/trace helpers (run in worker)
  AppUI.prototype._cvEnsureGraphBuilt = async function(page){
  const p = page||this.state.page; if(!p) return false;
  if(!(window.cvWorker && window.cvWorkerReady)) return false;
  const src = p.processedCanvas || p.cvCanvas || this._sourceCanvas();
  const c = src; if(!c) return false; const ctx=c.getContext('2d'); const img=ctx.getImageData(0,0,c.width,c.height);
  const bridge = parseInt(this.cvBridge?.value||'1')|0;
  const ignoreText = this.cvIgnoreText && this.cvIgnoreText.checked ? 1 : 0;
  const stamp = `${c.width}x${c.height}:${(p.processedCanvas?1:0)}:${(p.cvCanvas?1:0)}:${p.enhance.brightness},${p.enhance.contrast},${p.enhance.threshold},${p.enhance.sharpen},${p.enhance.invert?1:0},${p.enhance.grayscale?1:0}:bridge=${bridge}:ignoreText=${ignoreText}`;
  if(p._graphStamp === stamp && p._graphReady){ return true }
  return new Promise((resolve)=>{
    const w=window.cvWorker; const onMsg=(ev)=>{ const d=ev.data||{}; if(d.type==='buildGraph:result' && d.id===p.id){ w.removeEventListener('message', onMsg); p._graphReady=true; p._graphStamp=stamp; resolve(true) } };
    this._pushUndoIfNeeded && this._pushUndoIfNeeded('cv:deskew');
    w.addEventListener('message', onMsg);
    w.postMessage({ type:'buildGraph', id:p.id, options:{ bridge, ignoreText }, image:{ data:new Uint8ClampedArray(img.data), width:c.width, height:c.height } });
  });
}

AppUI.prototype._cvTracePath = async function(page, x, y){
  const p=page||this.state.page; if(!p) return null; if(!(window.cvWorker && window.cvWorkerReady)) return null;
  return new Promise((resolve)=>{
    const w=window.cvWorker; const onMsg=(ev)=>{ const d=ev.data||{}; if(d.type==='tracePath:result' && d.id===p.id){ w.removeEventListener('message', onMsg); resolve(d.path||null) } };
    this._pushUndoIfNeeded && this._pushUndoIfNeeded('cv:denoise');
    w.addEventListener('message', onMsg);
    w.postMessage({ type:'tracePath', id:p.id, click:{x,y} });
  });
}

AppUI.prototype._cvTraceComponent = async function(page, x, y){
  const p=page||this.state.page; if(!p) return null; if(!(window.cvWorker && window.cvWorkerReady)) return null;
  return new Promise((resolve)=>{
    const w=window.cvWorker; const onMsg=(ev)=>{ const d=ev.data||{}; if(d.type==='traceComponent:result' && d.id===p.id){ w.removeEventListener('message', onMsg); resolve(d.paths||null) } };
    this._pushUndoIfNeeded && this._pushUndoIfNeeded('cv:adaptive');
    w.addEventListener('message', onMsg);
    w.postMessage({ type:'traceComponent', id:p.id, click:{x,y} });
  });
}

  AppUI.prototype._cvDeskew = function(reqId){
  const p=this.state.page; if(!p) return; const c=this._sourceCanvas(); if(!c) return;
  const ctx=c.getContext('2d', { willReadFrequently: true }); const img=ctx.getImageData(0,0,c.width,c.height);
  if(!(window.cvWorker && window.cvWorkerReady)){ this._toast('Load OpenCV first', 'error'); return }
  return new Promise((resolve)=>{
    const w=window.cvWorker; const onMsg=(ev)=>{
      const d=ev.data||{}; if(d.type==='deskew:result' && (!reqId || d.reqId===reqId)){
        w.removeEventListener('message', onMsg);
        const out=d.image; const outCanvas=document.createElement('canvas'); outCanvas.width=out.width; outCanvas.height=out.height; outCanvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(out.data), out.width, out.height),0,0);
        p.cvCanvas=outCanvas; const ret=this._applyEnhancements(p); if(ret&&typeof ret.then==='function'){ ret.then(()=>resolve()); } else { resolve(); }
      } else if(d.type==='error'){
        try{ this._debug('cv:error', {op:'deskew', message:d.error}); }catch(_){ }
        try{ this._toast('OpenCV error: '+(d.error||'deskew'), 'error') }catch(_){ }
        try{ w.removeEventListener('message', onMsg) }catch(_){ }
        resolve();
      }
    };
    this._pushUndoIfNeeded && this._pushUndoIfNeeded('cv:text');
    w.addEventListener('message', onMsg);
    w.postMessage({ type:'deskew', reqId, image:{ data:new Uint8ClampedArray(img.data), width:c.width, height:c.height } });
  });
}

  AppUI.prototype._cvDenoise = function(reqId){
  const p=this.state.page; if(!p) return; const c=this._sourceCanvas(); if(!c) return;
  const ctx=c.getContext('2d', { willReadFrequently: true }); const img=ctx.getImageData(0,0,c.width,c.height);
  if(!(window.cvWorker && window.cvWorkerReady)){ this._toast('Load OpenCV first', 'error'); return }
  return new Promise((resolve)=>{
    const w=window.cvWorker; const onMsg=(ev)=>{
      const d=ev.data||{}; if(d.type==='denoise:result' && (!reqId || d.reqId===reqId)){
        w.removeEventListener('message', onMsg);
        const out=d.image; const outCanvas=document.createElement('canvas'); outCanvas.width=out.width; outCanvas.height=out.height; {
          const ctx2=outCanvas.getContext('2d'); const data=new Uint8ClampedArray(out.data); for(let i=3;i<data.length;i+=4){ data[i]=255; }
          ctx2.fillStyle = '#ffffff'; ctx2.fillRect(0,0,out.width,out.height);
          ctx2.putImageData(new ImageData(data, out.width, out.height),0,0);
        }
        p.cvCanvas=outCanvas; const ret=this._applyEnhancements(p); if(ret&&typeof ret.then==='function'){ ret.then(()=>resolve()); } else { resolve(); }
      } else if(d.type==='error'){
        try{ this._debug('cv:error', {op:'denoise', message:d.error}); }catch(_){ }
        try{ this._toast('OpenCV error: '+(d.error||'denoise'), 'error') }catch(_){ }
        try{ w.removeEventListener('message', onMsg) }catch(_){ }
        resolve();
      }
    };
    this._pushUndoIfNeeded && this._pushUndoIfNeeded('cv:bgnorm');
    w.addEventListener('message', onMsg);
    w.postMessage({ type:'denoise', reqId, image:{ data:new Uint8ClampedArray(img.data), width:c.width, height:c.height } });
  });
}

  AppUI.prototype._cvAdaptive = function(reqId){
  const p=this.state.page; if(!p) return; const c=this._sourceCanvas(); if(!c) return;
  const ctx=c.getContext('2d', { willReadFrequently: true }); const img=ctx.getImageData(0,0,c.width,c.height);
  if(!(window.cvWorker && window.cvWorkerReady)){ this._toast('Load OpenCV first', 'error'); return }
  return new Promise((resolve)=>{
    const w=window.cvWorker; const onMsg=(ev)=>{
      const d=ev.data||{}; if(d.type==='adaptive:result' && (!reqId || d.reqId===reqId)){
        w.removeEventListener('message', onMsg);
        const out=d.image; const outCanvas=document.createElement('canvas'); outCanvas.width=out.width; outCanvas.height=out.height; {
          const ctx2=outCanvas.getContext('2d'); const data=new Uint8ClampedArray(out.data); for(let i=3;i<data.length;i+=4){ data[i]=255; }
          ctx2.fillStyle = '#ffffff'; ctx2.fillRect(0,0,out.width,out.height);
          ctx2.putImageData(new ImageData(data, out.width, out.height),0,0);
        }
        p.cvCanvas=outCanvas; const ret=this._applyEnhancements(p); if(ret&&typeof ret.then==='function'){ ret.then(()=>resolve()); } else { resolve(); }
      } else if(d.type==='error'){
        try{ this._debug('cv:error', {op:'adaptive', message:d.error}); }catch(_){ }
        try{ this._toast('OpenCV error: '+(d.error||'adaptive'), 'error') }catch(_){ }
        try{ w.removeEventListener('message', onMsg) }catch(_){ }
        resolve();
      }
    };
    this._pushUndoIfNeeded && this._pushUndoIfNeeded('cv:despeckle');
    w.addEventListener('message', onMsg);
    w.postMessage({ type:'adaptive', reqId, image:{ data:new Uint8ClampedArray(img.data), width:c.width, height:c.height } });
  });
}

  AppUI.prototype._cvTextEnhance = function(reqId){
  const p=this.state.page; if(!p) return; const c=this._sourceCanvas(); if(!c) return;
  const ctx=c.getContext('2d', { willReadFrequently: true }); const img=ctx.getImageData(0,0,c.width,c.height);
  if(!(window.cvWorker && window.cvWorkerReady)){ this._toast('Load OpenCV first', 'error'); return }
  return new Promise((resolve)=>{
    const w=window.cvWorker; const onMsg=(ev)=>{
      const d=ev.data||{}; if(d.type==='text:result' && (!reqId || d.reqId===reqId)){
        w.removeEventListener('message', onMsg);
        const out=d.image; const outCanvas=document.createElement('canvas'); outCanvas.width=out.width; outCanvas.height=out.height; {
          const ctx2=outCanvas.getContext('2d'); const data=new Uint8ClampedArray(out.data); for(let i=3;i<data.length;i+=4){ data[i]=255; }
          ctx2.fillStyle = '#ffffff'; ctx2.fillRect(0,0,out.width,out.height);
          ctx2.putImageData(new ImageData(data, out.width, out.height),0,0);
        }
        p.cvCanvas=outCanvas; const ret=this._applyEnhancements(p); if(ret&&typeof ret.then==='function'){ ret.then(()=>resolve()); } else { resolve(); }
      } else if(d.type==='error'){
        try{ this._debug('cv:error', {op:'text', message:d.error}); }catch(_){ }
        try{ this._toast('OpenCV error: '+(d.error||'text'), 'error') }catch(_){ }
        try{ w.removeEventListener('message', onMsg) }catch(_){ }
        resolve();
      }
    };
    w.addEventListener('message', onMsg);
    const strength = parseInt(this.cvTextStrength?.value||'2')|0;
    const thin = parseInt(this.cvTextThin?.value||'0')|0;
    const thicken = parseInt(this.cvTextThicken?.value||'1')|0;
    const upscale = this.cvTextUpscale ? !!this.cvTextUpscale.checked : true;
    const bgEq = this.cvBgEq ? !!this.cvBgEq.checked : false;
    w.postMessage({ type:'textEnhance', reqId, options:{ strength, thin, thicken, upscale, bgEq }, image:{ data:new Uint8ClampedArray(img.data), width:c.width, height:c.height } });
  });
}

  AppUI.prototype._cvTextEnhance2 = function(reqId){
  const p=this.state.page; if(!p) return; const c=this._sourceCanvas(); if(!c) return;
  const ctx=c.getContext('2d', { willReadFrequently: true }); const img=ctx.getImageData(0,0,c.width,c.height);
  if(!(window.cvWorker && window.cvWorkerReady)){ this._toast('Load OpenCV first', 'error'); return }
  return new Promise((resolve)=>{
    const w=window.cvWorker; const onMsg=(ev)=>{
      const d=ev.data||{}; if(d.type==='text2:result' && (!reqId || d.reqId===reqId)){
        w.removeEventListener('message', onMsg);
        const out=d.image; const outCanvas=document.createElement('canvas'); outCanvas.width=out.width; outCanvas.height=out.height; {
          const ctx2=outCanvas.getContext('2d'); const data=new Uint8ClampedArray(out.data); for(let i=3;i<data.length;i+=4){ data[i]=255; }
          ctx2.fillStyle = '#ffffff'; ctx2.fillRect(0,0,out.width,out.height);
          ctx2.putImageData(new ImageData(data, out.width, out.height),0,0);
        }
        p.cvCanvas=outCanvas; const ret=this._applyEnhancements(p); if(ret&&typeof ret.then==='function'){ ret.then(()=>resolve()); } else { resolve(); }
      } else if(d.type==='error'){
        try{ this._debug('cv:error', {op:'text2', message:d.error}); }catch(_){ }
        try{ this._toast('OpenCV error: '+(d.error||'text2'), 'error') }catch(_){ }
        try{ w.removeEventListener('message', onMsg) }catch(_){ }
        resolve();
      }
    };
    w.addEventListener('message', onMsg);
    const strength = parseInt(this.cvTextStrength?.value||'2')|0;
    const thin = parseInt(this.cvTextThin?.value||'0')|0;
    const thicken = parseInt(this.cvTextThicken?.value||'1')|0;
    const upscale = this.cvTextUpscale ? !!this.cvTextUpscale.checked : true;
    const bgEq = this.cvBgEq ? !!this.cvBgEq.checked : false;
    // Reuse "Max speck" slider to suppress tiny dots after Sauvola
    const maxSpeck = parseInt(this.cvSpeckSize?.value||'0')|0;
    w.postMessage({ type:'textEnhance2', reqId, options:{ strength, thin, thicken, upscale, bgEq, maxSpeck }, image:{ data:new Uint8ClampedArray(img.data), width:c.width, height:c.height } });
  });
}

  AppUI.prototype._cvBgNormalize = function(reqId){
  const p=this.state.page; if(!p) return; const c=this._sourceCanvas(); if(!c) return;
  const ctx=c.getContext('2d', { willReadFrequently: true }); const img=ctx.getImageData(0,0,c.width,c.height);
  if(!(window.cvWorker && window.cvWorkerReady)){ this._toast('Load OpenCV first', 'error'); return }
  return new Promise((resolve)=>{
    const w=window.cvWorker; const onMsg=(ev)=>{
      const d=ev.data||{}; if(d.type==='bgnorm:result' && (!reqId || d.reqId===reqId)){
        w.removeEventListener('message', onMsg);
        const out=d.image; const outCanvas=document.createElement('canvas'); outCanvas.width=out.width; outCanvas.height=out.height; {
          const ctx2=outCanvas.getContext('2d'); const data=new Uint8ClampedArray(out.data); for(let i=3;i<data.length;i+=4){ data[i]=255; }
          ctx2.fillStyle = '#ffffff'; ctx2.fillRect(0,0,out.width,out.height);
          ctx2.putImageData(new ImageData(data, out.width, out.height),0,0);
        }
        p.cvCanvas=outCanvas; const ret=this._applyEnhancements(p); if(ret&&typeof ret.then==='function'){ ret.then(()=>resolve()); } else { resolve(); }
      } else if(d.type==='error'){
        try{ this._debug('cv:error', {op:'bgnorm', message:d.error}); }catch(_){ }
        try{ this._toast('OpenCV error: '+(d.error||'bgnorm'), 'error') }catch(_){ }
        try{ w.removeEventListener('message', onMsg) }catch(_){ }
        resolve();
      }
    };
    w.addEventListener('message', onMsg);
    w.postMessage({ type:'bgNormalize', reqId, image:{ data:new Uint8ClampedArray(img.data), width:c.width, height:c.height } });
  });
}

  AppUI.prototype._cvDespeckle = function(reqId){
  const p=this.state.page; if(!p) return; const c=this._sourceCanvas(); if(!c) return;
  const ctx=c.getContext('2d', { willReadFrequently: true }); const img=ctx.getImageData(0,0,c.width,c.height);
  if(!(window.cvWorker && window.cvWorkerReady)){ this._toast('Load OpenCV first', 'error'); return }
  return new Promise((resolve)=>{
    const w=window.cvWorker; const onMsg=(ev)=>{
      const d=ev.data||{}; if(d.type==='despeckle:result' && (!reqId || d.reqId===reqId)){
        w.removeEventListener('message', onMsg);
        const out=d.image; const outCanvas=document.createElement('canvas'); outCanvas.width=out.width; outCanvas.height=out.height; {
          const ctx2=outCanvas.getContext('2d'); const data=new Uint8ClampedArray(out.data); for(let i=3;i<data.length;i+=4){ data[i]=255; }
          ctx2.putImageData(new ImageData(data, out.width, out.height),0,0);
        }
        p.cvCanvas=outCanvas; const ret=this._applyEnhancements(p); if(ret&&typeof ret.then==='function'){ ret.then(()=>resolve()); } else { resolve(); }
      } else if(d.type==='error'){
        try{ this._debug('cv:error', {op:'despeckle', message:d.error}); }catch(_){ }
        try{ this._toast('OpenCV error: '+(d.error||'despeckle'), 'error') }catch(_){ }
        try{ w.removeEventListener('message', onMsg) }catch(_){ }
        resolve();
      }
    };
    w.addEventListener('message', onMsg);
    const maxSize = parseInt(this.cvSpeckSize?.value||'40')|0;
    w.postMessage({ type:'despeckle', reqId, options:{ maxSize }, image:{ data:new Uint8ClampedArray(img.data), width:c.width, height:c.height } });
  });
}
