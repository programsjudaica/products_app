/* ===================== state ===================== */

let fontLibrary = [];          // [{id, name, dataUrl}]
let activeFontId = null;
let refImages = []; // data URLs, max 8
let viewImages = { top:null, bottom:null, front:null, back:null, side:null };
let dimAnnotations = { top:[], bottom:[], front:[], back:[], side:[] }; // {x1,y1,x2,y2,label} in % coords
let pendingPoint = null; // {view, x, y} - first click of a dimension-line pair
let engravedPos = { xPct: 50, yPct: 78 }; // Front-view text overlay position, in % of the box
let detectedText = null; // text Claude Vision read directly off the product photo - reference only

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
  const designerNotes = txt('f_aiNotes').trim();
  const notesBlock = designerNotes
    ? `\n\nDESIGNER'S NOTES ABOUT THIS SPECIFIC PRODUCT (these are ground truth from the person who actually knows the product - they override any general assumption below if they conflict):\n${designerNotes}\n`
    : '';
  return `Using the attached photo(s) as reference, generate ONE image containing 6 separate sub-images of this exact same physical product, arranged in a clean 2x3 grid with thin dividing lines and small text labels above each cell.
${notesBlock}

Grid layout (left to right, top to bottom):
Row 1: Top, Front, Right Side
Row 2: Bottom, Back, Left Side

Requirements for all 6 sub-images:
- Flat, clean technical/catalog illustration style - no dramatic lighting, no shadows, no reflections, no isometric/3D angle under any circumstances - strictly straight-on orthographic views only
- Plain solid white background for every cell
- Same exact scale, framing and margins across all 6 cells
- Preserve the actual materials, colors and textures visible in the reference photo
- Do NOT add any decorative element, icon, symbol, handle, protrusion or other structural detail that is not visible in the reference photo - even if that kind of object commonly has one (e.g. many cups have handles - do not add one unless you can actually see it in the reference photo). If unsure, leave that area plain rather than inventing something.
- Do NOT render any text, lettering, or engraving anywhere in any image - leave any text/engraving area completely plain and blank (real text will be added separately as a precise overlay)
- If the reference photo shows more than one physical unit (e.g. a matching pair or set), depict only ONE single unit, not both together
- Back: not visible in the reference photo - do not invent any decorative detail for it. Render only the correct overall silhouette/proportions matching the other views, with the same material/texture, but no engraving.
- Top, Bottom, Left Side, Right Side: infer the correct silhouette and proportions from the reference photo, consistent with the front view.
- CRITICAL - structural consistency: identify every physical structural element visible in the reference photo (handles, spouts, feet, rims, insets, cutouts, protrusions, anything that is not just surface decoration). Every one of these elements MUST appear in EVERY view where it would actually be visible or would protrude into that view's silhouette - do not silently omit a handle or protrusion from the Top or Bottom view just because a typical/generic object of this rough category wouldn't normally have one there. Reason specifically about THIS object's actual geometry: e.g. if there are two side handles, the Top and Bottom views MUST show them sticking out on both sides, not a plain circle/oval as if the handles didn't exist.
- CRITICAL - overall silhouette consistency: do the same for the object's overall 3D shape, not just protrusions. If the reference photo shows a non-rectangular profile - a sloped/angled lid, a tapered or curved body, a bevelled edge, an irregular outline - that same shape must be reflected consistently in every relevant view derived from the SAME imagined 3D object. Do not default to a plain rectangle/box for Side, Top or Bottom just because that is the typical shape for that view of a generic object in this category - reason from what you actually generated for the Front view and carry its real geometry through to the other views. Example: if Front shows a box with a diagonal sloped top edge (like a peaked roof), Side must show that same slope in profile, not a flat rectangle.

Output: a single image, exactly a 2x3 grid as specified, each cell clearly labeled.`;
}

const singleViewLabels = { top:'Top', bottom:'Bottom', front:'Front', back:'Back', side:'Right Side' };
let viewNotes = { top:'', bottom:'', front:'', back:'', side:'' }; // remembers a per-view note while switching the picker

function buildSingleViewPrompt(viewLabel, viewNote){
  const globalNotes = txt('f_aiNotes').trim();
  let notesBlock = '';
  if(globalNotes) notesBlock += `\n\nGeneral designer notes about this product (ground truth, overrides assumptions if they conflict): ${globalNotes}`;
  if(viewNote) notesBlock += `\n\nSpecific instructions for THIS view (${viewLabel}) - follow these precisely, they are the most important guidance for this image: ${viewNote}`;
  return `Using the attached photo(s) as reference, generate ONE single image showing ONLY the "${viewLabel}" straight-on orthographic view (no angle, no perspective, no isometric/3D under any circumstances) of this exact physical product.
${notesBlock}

Requirements:
- Flat, clean technical/catalog illustration style - no dramatic lighting, no shadows, no reflections
- Plain solid white background, filling the frame with just this one view, no grid, no labels, no other angles
- Preserve the actual materials, colors and textures visible in the reference photo
- Do NOT add any decorative element, icon, symbol, handle, protrusion or other structural detail that is not visible in the reference photo - even if that kind of object commonly has one. If unsure, leave that area plain rather than inventing something.
- Do NOT render any text, lettering, or engraving anywhere - leave that area completely plain and blank
- If the reference photo shows more than one physical unit (e.g. a matching pair or set), depict only ONE single unit`;
}

async function regenerateSingleView(){
  const viewKey = document.getElementById('f_singleViewPicker').value;
  const viewLabel = singleViewLabels[viewKey];
  const note = document.getElementById('f_singleViewNote').value.trim();
  const status = document.getElementById('singleViewStatus');
  if(refImages.length === 0){
    status.textContent = 'קודם צריך להעלות לפחות תמונת רפרנס אחת.';
    return;
  }
  status.textContent = `🎨 יוצרת מחדש רק את ${viewLabel}...`;
  try {
    const resp = await fetch('/api/generate-views', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ images: refImages, prompt: buildSingleViewPrompt(viewLabel, note) })
    });
    if(!resp.ok){
      let errMsg = resp.status;
      try { const err = await resp.json(); if(err.error) errMsg = err.error; } catch(e){}
      status.textContent = `יצירה מחדש נכשלה (${errMsg}).`;
      return;
    }
    const data = await resp.json();
    viewImages[viewKey] = data.image;
    status.textContent = `✅ ${viewLabel} נוצר מחדש.`;
    render();
  } catch(e){
    status.textContent = 'יצירה מחדש נכשלה (השרת עדיין לא מחובר).';
  }
}

async function generateViews(){
  const status = document.getElementById('genStatus');
  if(refImages.length === 0){
    status.textContent = 'קודם צריך להעלות לפחות תמונת רפרנס אחת.';
    return;
  }
  status.textContent = '🎨 יוצר 6 תצוגות עם AI... זה יכול לקחת כ-20-40 שניות.';
  try {
    const resp = await fetch('/api/generate-views', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ images: refImages, prompt: buildGenerationPrompt() })
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

/* material/color/notes analysis via Claude Vision (/api/analyze) - completely separate
   from the GPT image generation above. Fires automatically on reference image upload. */
async function autoAnalyzeMaterial(){
  const status = document.getElementById('materialAnalysisStatus');
  if(refImages.length === 0) return;
  status.textContent = '🤖 מזהה חומר/צבע...';
  try {
    const resp = await fetch('/api/analyze', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ images: refImages })
    });
    if(!resp.ok){
      let errMsg = resp.status;
      try { const err = await resp.json(); if(err.error) errMsg = err.error; } catch(e){}
      status.textContent = `זיהוי אוטומטי לא זמין כרגע (${errMsg}).`;
      return;
    }
    const data = await resp.json();
    if(data.material) document.getElementById('f_material').value = data.material;
    if(data.color_name) document.getElementById('f_colorname').value = data.color_name;
    if(data.color_hex) document.getElementById('f_color').value = data.color_hex.startsWith('#') ? data.color_hex : '#'+data.color_hex;

    const notesEl = document.getElementById('f_notes');
    if(!notesEl.value.trim() && data.notes){
      notesEl.value = data.notes;
    }

    detectedText = (data.detected_text && data.detected_text.trim()) ? data.detected_text.trim() : null;

    let msg = '🤖 זוהה: ' + [data.material, data.color_name].filter(Boolean).join(', ') + '.';
    if(detectedText) msg += ` טקסט שזוהה על המוצר: "${detectedText}" (להשוות לטקסט/פונט המדויק שתזיני).`;
    if(data.notes) msg += ' ' + data.notes;
    status.textContent = msg;
    render();
  } catch(e){
    status.textContent = 'זיהוי אוטומטי לא זמין כרגע (השרת עדיין לא מחובר).';
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

/* automatic overall width/height dimension lines, computed live from the H/W/D fields -
   always present when those fields are filled, on top of whichever manual lines were added */
function autoDimLines(viewKey, H, W, D){
  let widthVal = null, heightVal = null;
  if(viewKey==='front' || viewKey==='back'){ widthVal = W; heightVal = H; }
  else if(viewKey==='side'){ widthVal = D; heightVal = H; }
  else if(viewKey==='top' || viewKey==='bottom'){ widthVal = W; heightVal = D; }
  let svg = '';
  if(widthVal){
    svg += `<g>
      <line class="dim-line-overlay" x1="8%" y1="95%" x2="92%" y2="95%"/>
      <line class="dim-tick-overlay" x1="8%" y1="93%" x2="8%" y2="97%"/>
      <line class="dim-tick-overlay" x1="92%" y1="93%" x2="92%" y2="97%"/>
      <rect class="dim-text-bg" x="42%" y="91.5%" width="16%" height="6%"/>
      <text class="dim-text-overlay" x="50%" y="96%">${widthVal}מ"מ</text>
    </g>`;
  }
  if(heightVal){
    svg += `<g>
      <line class="dim-line-overlay" x1="5%" y1="8%" x2="5%" y2="92%"/>
      <line class="dim-tick-overlay" x1="3%" y1="8%" x2="7%" y2="8%"/>
      <line class="dim-tick-overlay" x1="3%" y1="92%" x2="7%" y2="92%"/>
      <rect class="dim-text-bg" x="0%" y="47%" width="12%" height="6%"/>
      <text class="dim-text-overlay" x="5%" y="51.5%" style="font-size:8px">${heightVal}מ"מ</text>
    </g>`;
  }
  return svg;
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
        <div class="ref-box">
          <div class="label">Reference appearance</div>
          <div id="refImgGallery" class="ref-img-gallery"></div>
          <div id="detectedTextCaption" class="detected-text-caption"></div>
        </div>
        <div class="engraved-box" id="engravedBox" style="display:none">
          <div class="label">ENGRAVED TEXT (EXACT FONT)</div>
          <div id="engravedBoxText" class="engraved-box-text"></div>
        </div>
        <div class="notes-box"><div class="label">MANUFACTURING NOTES</div><ol id="notesList"></ol></div>
      </div>
    </div>
    <div class="sheet-footer">
      <span>CONCEPT TECHNICAL SPECIFICATION - supplier must confirm production engineering, tolerances and tooling feasibility before mold release.</span>
      <span id="footerRev"></span>
    </div>
  `;
}


function render(){
  const code = txt('f_code'), title = txt('f_title'), category = txt('f_category');
  const rev = txt('f_rev'), date = txt('f_date');
  const H = num('d_H'), W = num('d_W'), D = num('d_D');
  const text = txt('f_text');
  const fontsize = num('f_fontsize') || 14;
  const textcolor = document.getElementById('f_textcolor').value;

  document.querySelector('.sheet-header .code').textContent = code || '—';
  document.querySelector('.sheet-header .title').textContent = (title||'').toUpperCase() + (category ? ' — ' + category : '');
  const material = txt('f_material'), colorname = txt('f_colorname');
  document.querySelector('.sheet-header .meta').innerHTML =
    `Material: ${material || '—'}<br>Color: ${colorname || '—'}<br>H×W×D: ${H??'—'} × ${W??'—'} × ${D??'—'} מ"מ`;

  const gallery = document.getElementById('refImgGallery');
  gallery.innerHTML = refImages.length === 0 ? '' : refImages.map(src => `<img src="${src}">`).join('');
  gallery.className = 'ref-img-gallery' + (refImages.length <= 1 ? ' single' : '');

  document.getElementById('detectedTextCaption').innerHTML = detectedText
    ? `טקסט שזוהה אוטומטית ע"י AI: <strong>${detectedText}</strong> (לאימות - לא וקטור מדויק)`
    : '';

  const engravedBox = document.getElementById('engravedBox');
  if(text && activeFontId){
    engravedBox.style.display = 'block';
    document.getElementById('engravedBoxText').innerHTML =
      `<span style="font-family:'custom-${activeFontId}'; color:${textcolor}">${text}</span>`;
  } else {
    engravedBox.style.display = 'none';
  }

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
    const fitMode = 'contain'; // never distort the AI image - real measurements come from the dimension lines, not from stretching pixels
    const annotations = (dimAnnotations[v.key]||[]).map(dimLineSvg).join('');
    const autoDims = v.key==='section' ? '' : autoDimLines(v.key, H, W, D);
    const pendingDot = (pendingPoint && pendingPoint.view===v.key)
      ? `<circle class="dim-point" cx="${pendingPoint.x}%" cy="${pendingPoint.y}%" r="2.5"/>` : '';
    const engravedOverlay = (v.key==='front' && text) ? `<div class="engraved-text-overlay" id="engravedOverlay" style="left:${engravedPos.xPct}%; top:${engravedPos.yPct}%; font-size:${fontsize}px; color:${textcolor}; font-family:${activeFontId?`'custom-${activeFontId}'`:'inherit'}">${text}</div>` : '';

    box.innerHTML = `
      <div class="label">${v.label}</div>
      <div class="view-canvas" id="canvas-${v.key}">
        ${imgSrc ? `<img src="${imgSrc}" style="object-fit:${fitMode}">` : (v.key==='section' ? '<div class="placeholder">שרטוט סכמטי - להוסיף ידנית</div>' : '<div class="placeholder">טרם נוצרה תמונה</div>')}
        ${engravedOverlay}
        <svg>${autoDims}${annotations}${pendingDot}</svg>
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
    const files = Array.from(e.target.files).slice(0,8);
    if(files.length === 0) return;
    const results = new Array(files.length);
    let loaded = 0;
    files.forEach((file, idx) => {
      const reader = new FileReader();
      reader.onload = () => {
        results[idx] = reader.result;
        loaded++;
        if(loaded === files.length){
          refImages = results;
          const preview = document.getElementById('refImgPreview');
          preview.innerHTML = refImages.map(src => `<img src="${src}">`).join('');
          render();
          autoAnalyzeMaterial();
        }
      };
      reader.readAsDataURL(file);
    });
  });

  document.getElementById('btnGenerateViews').addEventListener('click', generateViews);

  document.getElementById('btnShowPrompt').addEventListener('click', () => {
    const box = document.getElementById('promptPreview');
    if(box.style.display === 'none'){
      box.value = buildGenerationPrompt();
      box.style.display = 'block';
    } else {
      box.style.display = 'none';
    }
  });

  document.getElementById('f_singleViewNote').addEventListener('input', (e) => {
    viewNotes[document.getElementById('f_singleViewPicker').value] = e.target.value;
  });
  document.getElementById('f_singleViewPicker').addEventListener('change', (e) => {
    document.getElementById('f_singleViewNote').value = viewNotes[e.target.value] || '';
  });
  document.getElementById('btnRegenerateSingleView').addEventListener('click', regenerateSingleView);
  document.getElementById('btnExport').addEventListener('click', () => window.print());

  render();
});
