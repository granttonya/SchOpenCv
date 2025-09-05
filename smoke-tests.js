
    async function makeSamplePNGBlob(){
      // generate a 256x256 synthetic image with gradient + noise so CV ops change pixels
      const c = document.createElement('canvas'); c.width=256; c.height=256;
      const ctx = c.getContext('2d');
      const g = ctx.createLinearGradient(0,0,256,256);
      g.addColorStop(0,'#ffffff'); g.addColorStop(1,'#000000');
      ctx.fillStyle = g; ctx.fillRect(0,0,256,256);
      // add some thin lines and noise
      ctx.strokeStyle = '#808080';
      ctx.lineWidth = 1;
      for(let y=16;y<256;y+=32){ ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(256,y); ctx.stroke(); }
      for(let x=24;x<256;x+=48){ ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,256); ctx.stroke(); }
      const imgData = ctx.getImageData(0,0,256,256);
      const d = imgData.data;
      for(let i=0;i<d.length;i+=4){
        d[i] = Math.min(255, d[i] + ((Math.random()*10)|0) );
        d[i+1] = Math.max(0, d[i+1] - ((Math.random()*10)|0) );
      }
      ctx.putImageData(imgData,0,0);
      return await new Promise(res=>c.toBlob(res,'image/png'));
    }
(function(){
  const $ = (sel, root=document) => root.querySelector(sel);
  const sleep = (ms)=> new Promise(r=>setTimeout(r,ms));
  const waitFor = async (cond, timeout=8000, step=50) => {
    const st = performance.now();
    while(performance.now()-st < timeout){
      try{ if(await cond()) return true }catch(_){}
      await sleep(step);
    }
    return false;
  };

  async function makeTestImageBlob(){
    // Draw simple schematic, then rotate slightly so deskew has effect
    const src = document.createElement('canvas'); src.width=512; src.height=384; const sg=src.getContext('2d');
    sg.fillStyle = '#fff'; sg.fillRect(0,0,src.width,src.height);
    sg.strokeStyle = '#000'; sg.lineWidth = 3;
    sg.strokeRect(10,10,src.width-20,src.height-20);
    sg.beginPath(); sg.moveTo(30, src.height/2); sg.lineTo(src.width-30, src.height/2); sg.stroke();
    sg.beginPath(); sg.moveTo(src.width/2, 30); sg.lineTo(src.width/2, src.height-30); sg.stroke();
    sg.beginPath(); let x=80, y=src.height/2; for(let i=0;i<12;i++){ sg.lineTo(x+=15, y-10); sg.lineTo(x+=15, y+10); } sg.stroke();
    // Rotate by ~5 degrees
    const c = document.createElement('canvas'); c.width=src.width; c.height=src.height; const g=c.getContext('2d');
    g.fillStyle='#fff'; g.fillRect(0,0,c.width,c.height);
    g.translate(c.width/2, c.height/2); g.rotate(5*Math.PI/180); g.translate(-src.width/2, -src.height/2);
    g.drawImage(src,0,0);
    return new Promise(res=> c.toBlob(b=>res(b), 'image/png', 0.92));
  }

  async function setFileInputFiles(input, files){
    // Override the read-only files property for this element instance
    const dt = new DataTransfer();
    files.forEach(f=>dt.items.add(f));
    Object.defineProperty(input, 'files', { configurable:true, value: dt.files });
    input.dispatchEvent(new Event('change', {bubbles:true}));
  }

  function pixelDiff(a, b){
    if(!a || !b || a.width !== b.width || a.height !== b.height) return 1e9;
    let diff = 0;
    const d1 = a.data, d2 = b.data; const len = Math.min(d1.length, d2.length);
    for(let i=0;i<len;i+=4){
      diff += Math.abs(d1[i]-d2[i]) + Math.abs(d1[i+1]-d2[i+1]) + Math.abs(d1[i+2]-d2[i+2]);
    }
    return diff / (a.width*a.height);
  }

  async function run(){
    const btnRun = $('#btn-run');
    const btnRe = $('#btn-rerun');
    const tableBody = $('#results tbody');
    function addRow(idx, name, ok, detail){
      const tr = document.createElement('tr');
      const td = (t)=>{ const e=document.createElement('td'); e.textContent=t; return e; };
      tr.appendChild(td(String(idx)));
      tr.appendChild(td(name));
      const status = document.createElement('td');
      status.innerHTML = ok ? '<span class="badge ok">PASS</span>' : '<span class="badge err">FAIL</span>';
      tr.appendChild(status);
      tr.appendChild(td(detail||''));
      tableBody.appendChild(tr);
    }
    function clearRows(){ tableBody.innerHTML=''; }

    btnRun.disabled = true; btnRe.disabled = true; clearRows();

    const iframe = $('#app');
    // Force reload to get a clean app
    iframe.src = 'index.html?nosw&ts=' + Date.now();

    // Wait the iframe to be ready
    await new Promise(res => iframe.addEventListener('load', res, {once:true}));
    const idoc = iframe.contentDocument;
    const iwin = iframe.contentWindow;
    let step = 1;

    // 0) Sanity: critical elements exist
    const okToolbar = !!idoc.querySelector('#btn-open,#file-input,#cv-load');
    addRow(step++, 'App boot and toolbar present', okToolbar, okToolbar?'':'Missing critical controls');
    if(!okToolbar){ btnRe.disabled=false; return; }

    // 1) Import synthetic image
    const fileInput = idoc.getElementById('file-input');
    const blob = await makeTestImageBlob();
    const file = new File([blob], 'smoketest.png', {type:'image/png'});
    await setFileInputFiles(fileInput, [file]);

    const imported = await waitFor(()=>{
      const s = idoc.getElementById('status-page');
      return s && /1\/\d+|1\/1/.test(s.textContent.trim());
    }, 6000);
    addRow(step++, 'Import image via file input', imported, imported?'':'Status did not update to 1/x');

    // 2) Load OpenCV
    const loadCvBtn = idoc.getElementById('cv-load');
    loadCvBtn && loadCvBtn.click();
    const cvReady = await waitFor(()=> iwin.cvWorkerReady === true, 8000);
    addRow(step++, 'Load OpenCV worker', cvReady, cvReady?'':'cvWorkerReady never became true');

    // 3) Enhancement threshold slider should change the canvas
    const viewCanvas = idoc.querySelector('.canvas-wrap canvas');
    const vctx = viewCanvas.getContext('2d');
    const beforeEnh = vctx.getImageData(0,0,viewCanvas.width, viewCanvas.height);
    const thr = idoc.getElementById('enh-threshold');
    let thrOk=false;
    if(thr){
      thr.value = 60; thr.dispatchEvent(new Event('input',{bubbles:true}));
      thrOk = await waitFor(()=>{
        const after = vctx.getImageData(0,0,viewCanvas.width, viewCanvas.height);
        const d = pixelDiff(beforeEnh, after);
        return d > 0.5;
      }, 7000);
    }
    addRow(step++, 'Threshold slider modifies image', thrOk, thrOk?'':'Canvas change not detected');

    // 4) CV Adaptive should change pixels further
    const beforeAdapt = vctx.getImageData(0,0,viewCanvas.width, viewCanvas.height);
    const adaptBtn = idoc.getElementById('cv-adapt');
    adaptBtn && adaptBtn.click();
    const adapted = await waitFor(()=>{
      const after = vctx.getImageData(0,0,viewCanvas.width, viewCanvas.height);
      const d = pixelDiff(beforeAdapt, after);
      return d > 0.5;
    }, 7000);
    addRow(step++, 'CV Adaptive modifies image', adapted, adapted?'':'Canvas did not change enough');

    // 5) CV Denoise should change pixels (reduce noise)
    const beforeDenoise = vctx.getImageData(0,0,viewCanvas.width, viewCanvas.height);
    const denoiseBtn = idoc.getElementById('cv-denoise');
    denoiseBtn && denoiseBtn.click();
    const denoised = await waitFor(()=>{
      const after = vctx.getImageData(0,0,viewCanvas.width, viewCanvas.height);
      const d = pixelDiff(beforeDenoise, after);
      return d > 0.2;
    }, 7000);
    addRow(step++, 'CV Denoise modifies image', denoised, denoised?'':'Canvas did not change enough');

    // 6) CV Deskew should change pixels (rotation)
    const beforeDeskew = vctx.getImageData(0,0,viewCanvas.width, viewCanvas.height);
    const deskewBtn = idoc.getElementById('cv-deskew');
    deskewBtn && deskewBtn.click();
    const deskewed = await waitFor(()=>{
      const after = vctx.getImageData(0,0,viewCanvas.width, viewCanvas.height);
      const d = pixelDiff(beforeDeskew, after);
      return d > 0.2;
    }, 7000);
    addRow(step++, 'CV Deskew modifies image', deskewed, deskewed?'':'Canvas did not change enough');

    // All done
    const allPass = [...tableBody.querySelectorAll('.badge.ok')].length === (step-1);
    btnRe.disabled = false;
    btnRun.disabled = true;
  }

  window.addEventListener('DOMContentLoaded', ()=>{
    const runBtn = document.getElementById('btn-run');
    const reBtn = document.getElementById('btn-rerun');
    runBtn.addEventListener('click', run);
    reBtn.addEventListener('click', run);
    if(location.search.includes('auto')){ run(); }
  });
})();
