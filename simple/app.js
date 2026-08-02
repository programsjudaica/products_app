/* ===================== state ===================== */

let fontLibrary = [];          // [{id, name, dataUrl}]
let activeFontId = null;
let refImageDataUrl = null;
let viewImages = { top:null, bottom:null, front:null, back:null, side:null };
let dimAnnotations = { top:[], bottom:[], front:[], back:[], side:[] }; // {x1,y1,x2,y2,label} in % coords
let pendingPoint = null; // {view, x, y} - first click of a dimension-line pair
let engravedPos = { xPct: 50, yPct: 78 }; // Front-view text overlay position, in % of the box

/* ===================== font library (localStorage) ===================== */

function loadFontLibrary(){
  try { fontLibrary = JSON.parse(localStorage.getItem('specapp_fontLibrary') || '[]'); }
  catch(e){ fontLibrary = []; }
}
function saveFontLibrary(){
  localStorage.setItem('specapp_fontLibrary', JSON.stringify(fontLibrary));
}
function injectFontFaces(){
  let styleEl = document.getElementById('dynamicFontFaces');
  if(!styleEl){
    styleEl = document.createElement('style');
    styleEl.id = 'dynamicFontFaces';
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = fontLibrary.map(f =>
    `@font-face { font-family: "custom-${f.id}"; src: url("${f.dataUrl}"); }`
  ).join('\n');
}
function renderFontLibraryList(){
  const box = document.getElementById('fontLibraryList');
  if(fontLibrary.length === 0){ box.innerHTML = '<span class="hint">אין פונטים שמורים עדיין</span>'; return; }
  box.innerHTML = fontLibrary.map(f => `
    <span class="chip ${f.id===activeFontId?'active':''}" data-font-id="${f.id}">
      ${f.name}<button type="button" data-remove-font="${f.id}">✕</button>
    </span>
  `).join('');
  box.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', (e) => {
      if(e.target.matches('[data-remove-font]')) return;
      activeFontId = chip.getAttribute('data-font-id');
      renderFontLibraryList();
      render();
    });
  });
  box.querySelectorAll('[data-remove-font]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-remove-font');
      fontLibrary = fontLibrary.filter(f => f.id !== id);
      if(activeFontId === id) activeFontId = null;
      saveFontLibrary();
      injectFontFaces();
      renderFontLibraryList();
      render();
    });
  });
}

/* ===================== helpers ===================== */

function num(id){
  const v = document.getElementById(id).value;
  return v === '' || v === null ? null : parseFloat(v);
}
function txt(id){ return document.getElementById(id).value; }
function fileToDataUrl(file){
  return new Promise((resolve,reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/* splits the single AI-generated 2x3 grid image into 6 named sub-images.
   Grid order requested in the prompt: row1 = Top, Front, Right Side; row2 = Bottom, Back, Left Side.
   Only "Right Side" is kept for the template's single SIDE box (matches the original
   spec-sheet convention of one Side view, not separate left/right). */
function splitGridImage(gridDataUrl){
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const cw = img.width/3, ch = img.height/2;
      const order = [ ['top','front','side'], ['bottom','back','__left_unused'] ];
      const result = {};
      for(let r=0;r<2;r++){
        for(let c=0;c<3;c++){
          const key = order[r][c];
          if(key === '__left_unused') continue;
          const canvas = document.createElement('canvas');
          canvas.width = cw; canvas.height = ch;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, c*cw, r*ch, cw, ch, 0, 0, cw, ch);
          result[key] = canvas.toDataURL('image/png');
        }
      }
      resolve(result);
    };
    img.onerror = () => resolve(null);
    img.src = gridDataUrl;
  });
}

function buildGenerationPrompt(){
  return `Using the attached photo as reference, generate ONE image containing 6 separate sub-images of this exact same physical product, arranged in a clean 2x3 grid with thin dividing lines and small text labels above each cell.

Grid layout (left to right, top to bottom):
Row 1: Top, Front, Right Side
Row 2: Bottom, Back, Left Side

Requirements for all 6 sub-images:
- Flat, clean technical/catalog illustration style - no dramatic lighting, no shadows, no reflections, no isometric/3D angle under any circumstances - strictly straight-on orthographic views only
- Plain solid white background for every cell
- Same exact scale, framing and margins across all 6 cells
- Preserve the actual materials, colors and textures visible in the reference photo
- Do NOT add any decorative element, icon, symbol or detail that is not visible in the reference photo - if unsure, leave that area plain rather than inventing something
- Do NOT render any text, lettering, or engraving anywhere in any image - leave any text/engraving area completely plain and blank (real text will be added separately as a precise overlay)
- If the reference photo shows more than one physical unit (e.g. a matching pair or set), depict only ONE single unit, not both together
- Back: not visible in the reference photo - do not invent any decorative detail for it. Render only the correct overall silhouette/proportions matching the other views, with the same material/texture, but no engraving.
- Top, Bottom, Left Side, Right Side: infer the correct silhouette and proportions from the reference photo, consistent with the front view.

Output: a single image, exactly a 2x3 grid as specified, each cell clearly labeled.`;
}

async function generateViews(){
  const status = document.getElementById('genStatus');
  if(!refImageDataUrl){
    status.textContent = 'קודם צריך להעלות תמונת רפרנס.';
    return;
  }
  status.textContent = '🎨 יוצר 6 תצוגות עם AI... זה יכול לקחת כ-20-40 שניות.';
  try {
    const resp = await fetch('/api/generate-views', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ image: refImageDataUrl, prompt: buildGenerationPrompt() })
    });
    if(!resp.ok){
      let errMsg = resp.status;
      try { const err = await resp.json(); if(err.error) errMsg = err.error; } catch(e){}
      status.textContent = `יצירת התמונות נכשלה (${errMsg}).`;
      return;
    }
    const data = await resp.json();
    const split = await splitGridImage(data.image);
    if(!split){ status.textContent = 'לא הצלחתי לפצל את התמונה שהתקבלה.'; return; }
    viewImages = split;
    status.textContent = '✅ 6 התצוגות נוצרו. אפשר ללחוץ על כל תצוגה כדי להוסיף קווי מידה (שתי נקודות + מספר אמיתי).';
    render();
  } catch(e){
    status.textContent = 'יצירת התמונות נכשלה (השרת עדיין לא מחובר / אין מפתח API).';
  }
}

/* ===================== dimension-line annotation tool ===================== */
/* simple click-two-points-type-a-number tool - no vector shape editing, just
   static annotation lines drawn on top of whatever image is already there */

function dimLineSvg(ann){
  const {x1,y1,x2,y2,label} = ann;
  const mx = (x1+x2)/2, my=(y1+y2)/2;
  return `<g>
    <line class="dim-line-overlay" x1="${x1}%" y1="${y1}%" x2="${x2}%" y2="${y2}%"/>
    <circle class="dim-point" cx="${x1}%" cy="${y1}%" r="2.5"/>
    <circle class="dim-point" cx="${x2}%" cy="${y2}%" r="2.5"/>
    <rect class="dim-text-bg" x="${mx-8}%" y="${my-2.2}%" width="16%" height="4.4%"/>
    <text class="dim-text-overlay" x="${mx}%" y="${my+1.2}%">${label}</text>
  </g>`;
}

function handleCanvasClick(viewKey, canvasEl, e){
  const rect = canvasEl.getBoundingClientRect();
  const xPct = ((e.clientX - rect.left) / rect.width) * 100;
  const yPct = ((e.clientY - rect.top) / rect.height) * 100;

  if(!pendingPoint || pendingPoint.view !== viewKey){
    pendingPoint = { view: viewKey, x: xPct, y: yPct };
    render();
    return;
  }
  const value = prompt('מרחק אמיתי בין שתי הנקודות (מ"מ):');
  if(value && parseFloat(value) > 0){
    dimAnnotations[viewKey].push({ x1: pendingPoint.x, y1: pendingPoint.y, x2: xPct, y2: yPct, label: parseFloat(value) + 'מ"מ' });
  }
  pendingPoint = null;
  render();
}

/* ===================== render ===================== */

function buildSkeleton(){
  document.getElementById('specSheet').innerHTML = `
    <div class="sheet-header">
      <div><div class="code"></div><div class="title"></div></div>
      <div class="meta"></div>
    </div>
    <div class="sheet-body">
      <div class="views-grid" id="viewsGrid"></div>
      <div class="side-col">
        <div class="ref-box"><div class="label">Reference appearance</div><img id="refImgBox" src="" style="display:none"></div>
        <div class="notes-box"><div class="label">MANUFACTURING NOTES</div><ol id="notesList"></ol></div>
      </div>
    </div>
    <div class="sheet-footer">
      <span>CONCEPT TECHNICAL SPECIFICATION - supplier must confirm production engineering, tolerances and tooling feasibility before mold release.</span>
      <span id="footerRev"></span>
    </div>
  `;
}

function aspectFor(viewKey, H, W, D, stretchOn){
  if(!stretchOn) return null;
  if((viewKey==='front'||viewKey==='back') && H && W) return `${W}/${H}`;
  if(viewKey==='side' && H && D) return `${D}/${H}`;
  if((viewKey==='top'||viewKey==='bottom') && W && D) return `${W}/${D}`;
  return null;
}

function render(){
  const code = txt('f_code'), title = txt('f_title'), category = txt('f_category');
  const rev = txt('f_rev'), date = txt('f_date');
  const H = num('d_H'), W = num('d_W'), D = num('d_D');
  const stretchOn = document.getElementById('f_stretchFit').checked;
  const text = txt('f_text');
  const fontsize = num('f_fontsize') || 14;
  const textcolor = document.getElementById('f_textcolor').value;

  document.querySelector('.sheet-header .code').textContent = code || '—';
  document.querySelector('.sheet-header .title').textContent = (title||'').toUpperCase() + (category ? ' — ' + category : '');
  document.querySelector('.sheet-header .meta').innerHTML = `H×W×D: ${H??'—'} × ${W??'—'} × ${D??'—'} מ"מ`;

  const refImg = document.getElementById('refImgBox');
  if(refImageDataUrl){ refImg.src = refImageDataUrl; refImg.style.display = 'block'; }
  else { refImg.style.display = 'none'; }

  const views = document.getElementById('viewsGrid');
  views.innerHTML = '';
  const labels = [
    {key:'top', label:'TOP'}, {key:'bottom', label:'BOTTOM'}, {key:'front', label:'FRONT'},
    {key:'back', label:'BACK'}, {key:'side', label:'SIDE'}, {key:'section', label:'SECTION'}
  ];
  labels.forEach(v => {
    const box = document.createElement('div');
    box.className = 'view-box';
    const imgSrc = viewImages[v.key];
    const ar = v.key==='section' ? null : aspectFor(v.key, H, W, D, stretchOn);
    const fitMode = (stretchOn && ar) ? 'fill' : 'contain';
    const annotations = (dimAnnotations[v.key]||[]).map(dimLineSvg).join('');
    const pendingDot = (pendingPoint && pendingPoint.view===v.key)
      ? `<circle class="dim-point" cx="${pendingPoint.x}%" cy="${pendingPoint.y}%" r="2.5"/>` : '';
    const engravedOverlay = (v.key==='front' && text) ? `<div class="engraved-text-overlay" id="engravedOverlay" style="left:${engravedPos.xPct}%; top:${engravedPos.yPct}%; font-size:${fontsize}px; color:${textcolor}; font-family:${activeFontId?`'custom-${activeFontId}'`:'inherit'}">${text}</div>` : '';

    box.innerHTML = `
      <div class="label">${v.label}</div>
      <div class="view-canvas" id="canvas-${v.key}" style="${ar?`aspect-ratio:${ar}`:''}">
        ${imgSrc ? `<img src="${imgSrc}" style="object-fit:${fitMode}">` : (v.key==='section' ? '<div class="placeholder">שרטוט סכמטי - להוסיף ידנית</div>' : '<div class="placeholder">טרם נוצרה תמונה</div>')}
        ${engravedOverlay}
        <svg>${annotations}${pendingDot}</svg>
      </div>
    `;
    views.appendChild(box);

    if(v.key !== 'section'){
      const canvasEl = box.querySelector('.view-canvas');
      canvasEl.addEventListener('click', (e) => {
        if(e.target.closest('.engraved-text-overlay')) return;
        handleCanvasClick(v.key, canvasEl, e);
      });
    }
  });

  // make the engraved text draggable
  const overlayEl = document.getElementById('engravedOverlay');
  if(overlayEl){
    overlayEl.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const canvasEl = overlayEl.parentElement;
      const onMove = (ev) => {
        const rect = canvasEl.getBoundingClientRect();
        engravedPos.xPct = Math.max(0, Math.min(100, ((ev.clientX-rect.left)/rect.width)*100));
        engravedPos.yPct = Math.max(0, Math.min(100, ((ev.clientY-rect.top)/rect.height)*100));
        overlayEl.style.left = engravedPos.xPct + '%';
        overlayEl.style.top = engravedPos.yPct + '%';
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  const notesList = document.getElementById('notesList');
  const lines = txt('f_notes').split('\n').map(l=>l.trim()).filter(Boolean);
  notesList.innerHTML = lines.map(l=>`<li>${l}</li>`).join('');

  document.getElementById('footerRev').textContent =
    `REV. ${rev || '01'} | ${date ? new Date(date).toLocaleDateString('en-GB').replace(/\//g,' ').toUpperCase() : ''}`;
}

/* ===================== wiring ===================== */

document.addEventListener('DOMContentLoaded', () => {
  buildSkeleton();
  document.getElementById('f_date').valueAsDate = new Date();

  loadFontLibrary();
  injectFontFaces();
  renderFontLibraryList();

  document.querySelectorAll('.panel input, .panel select, .panel textarea')
    .forEach(el => el.addEventListener('input', render));

  document.getElementById('f_fontUpload').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if(!file) return;
    const dataUrl = await fileToDataUrl(file);
    const id = 'f' + Date.now();
    const name = file.name.replace(/\.[^.]+$/, '');
    fontLibrary.push({ id, name, dataUrl });
    activeFontId = id;
    saveFontLibrary();
    injectFontFaces();
    renderFontLibraryList();
    render();
  });

  document.getElementById('f_refImage').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if(!file) return;
    refImageDataUrl = await fileToDataUrl(file);
    const preview = document.getElementById('refImgPreview');
    preview.innerHTML = `<img src="${refImageDataUrl}">`;
    render();
  });

  document.getElementById('btnGenerateViews').addEventListener('click', generateViews);
  document.getElementById('btnExport').addEventListener('click', () => window.print());

  render();
});
