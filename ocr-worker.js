// OCR worker using Tesseract.js
let ocrReady = false;

async function loadTesseract(){
  if(ocrReady) return;
  importScripts('https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js');
  // Warm-up by creating a worker internally
  try{
    // No explicit init needed for simple recognize() path
    ocrReady = true;
  }catch(_){ ocrReady = true; }
}

self.onmessage = async (e)=>{
  const msg = e.data||{};
  try{
    if(msg.type==='init'){ await loadTesseract(); self.postMessage({type:'ready'}); return }
    if(!ocrReady){ await loadTesseract(); }
    if(msg.type==='recognize'){
      const { id, image } = msg; // image: {data,width,height}
      // Build an ImageData, then draw to OffscreenCanvas for Tesseract
      const imgData = new ImageData(new Uint8ClampedArray(image.data), image.width|0, image.height|0);
      const canvas = new OffscreenCanvas(imgData.width, imgData.height);
      const ctx = canvas.getContext('2d');
      ctx.putImageData(imgData, 0, 0);
      const res = await Tesseract.recognize(canvas, 'eng', { logger:()=>{} });
      const text = (res && res.data && res.data.text) ? String(res.data.text||'').trim() : '';
      const conf = (res && res.data && res.data.confidence) ? +res.data.confidence : 0;
      self.postMessage({ type:'recognize:result', id, text, confidence: conf });
      return;
    }
  }catch(err){ self.postMessage({ type:'error', error: String(err&&err.message||err) }); }
};

