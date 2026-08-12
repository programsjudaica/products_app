/* ===================== state ===================== */

let fontLibrary = [];          // [{id, name, url}] - shared across all designers, from /api/fonts
let activeFontId = null;
let refImages = []; // data URLs, max 8
let viewImages = { top:null, bottom:null, front:null, back:null, side:null };
let dimAnnotations = { top:[], bottom:[], front:[], back:[], side:[] }; // {x1,y1,x2,y2,label} in % coords
let pendingPoint = null; // {view, x, y} - first click of a dimension-line pair
let engravedPos = { xPct: 50, yPct: 78 }; // Front-view text overlay position, in % of the box
let detectedText = null; // text Claude Vision read directly off the product photo - reference only
let vectorGraphics = []; // [{id, name, svgMarkup, xPct, yPct, widthPct, rotationDeg}] - uploaded SVG logos/graphics, placed on a dedicated "Front without text" box
let activeGraphicId = null;
let reliefAnnotations = { top:[], bottom:[], front:[], back:[], side:[] }; // {xPct,yPct,type,values,label} - 3D structural features (engraving/protrusion/curve/stripe/recess)
let annotationMode = 'dimension'; // 'dimension' | 'relief' - which tool a click on a view-canvas triggers

/* ===================== font library (shared, /api/fonts) ===================== */
/* Font ids are Vercel Blob pathnames (e.g. "fonts/171..._MyFont.ttf") - not safe to use
   directly as a CSS font-family name, so cssSafeId() strips it down to [a-zA-Z0-9_]. */

function cssSafeId(id){ return String(id).replace(/[^a-zA-Z0-9]/g, '_'); }

async function fetchFontLibrary(){
  const status = document.getElementById('fontLibraryStatus');
  try {
    const resp = await fetch('/api/fonts');
    if(!resp.ok) throw new Error(resp.status);
    const data = await resp.json();
    fontLibrary = data.fonts || [];
    injectFontFaces();
    renderFontLibrarySelect();
  } catch(e){
    if(status) status.textContent = 'לא ניתן לטעון כרגע את ספריית הפונטים המשותפת.';
  }
}
function injectFontFaces(){
  let styleEl = document.getElementById('dynamicFontFaces');
  if(!styleEl){
    styleEl = document.createElement('style');
    styleEl.id = 'dynamicFontFaces';
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = fontLibrary.map(f =>
    `@font-face { font-family: "custom-${cssSafeId(f.id)}"; src: url("${f.dataUrl}"); }`
  ).join('\n');
}
function renderFontLibrarySelect(){
  const sel = document.getElementById('fontLibrarySelect');
  if(fontLibrary.length === 0){
    sel.innerHTML = '<option value="">אין פונטים משותפים עדיין - העלי קובץ פונט למעלה</option>';
    return;
  }
  sel.innerHTML = '<option value="">— ללא פונט —</option>' + fontLibrary.map(f =>
    `<option value="${f.id}" ${f.id===activeFontId ? 'selected' : ''}>${f.name}</option>`
  ).join('');
}

/* ===================== vector graphics (SVG logos on the "Front without text" box) ===================== */
/* Per-project only (not a shared library like fonts) - uploaded SVG markup is kept inline
   in vectorGraphics/svgMarkup so it stays real vector content straight through to print. */

function renderVectorGraphicList(){
  const box = document.getElementById('vectorGraphicList');
  const controls = document.getElementById('vectorGraphicControls');
  if(vectorGraphics.length === 0){
    box.innerHTML = '<span class="hint">אין גרפיקות שהועלו למוצר הזה</span>';
    controls.style.display = 'none';
    return;
  }
  box.innerHTML = vectorGraphics.map(g => `
    <span class="chip ${g.id===activeGraphicId?'active':''}" data-graphic-id="${g.id}">
      ${g.name}<button type="button" data-remove-graphic="${g.id}">✕</button>
    </span>
  `).join('');
  box.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', (e) => {
      if(e.target.matches('[data-remove-graphic]')) return;
      selectGraphic(chip.getAttribute('data-graphic-id'));
    });
  });
  box.querySelectorAll('[data-remove-graphic]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeGraphic(btn.getAttribute('data-remove-graphic'));
    });
  });

  const active = vectorGraphics.find(g => g.id === activeGraphicId);
  if(active){
    controls.style.display = 'block';
    document.getElementById('g_width').value = active.widthPct;
    document.getElementById('g_rotation').value = active.rotationDeg;
  } else {
    controls.style.display = 'none';
  }
}

function selectGraphic(id){
  activeGraphicId = id;
  renderVectorGraphicList();
  render();
}

function removeGraphic(id){
  vectorGraphics = vectorGraphics.filter(g => g.id !== id);
  if(activeGraphicId === id) activeGraphicId = null;
  renderVectorGraphicList();
  render();
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
function fileToText(file){
  return new Promise((resolve,reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsText(file);
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
  const recreateText = document.getElementById('f_aiRecreateText').checked;
  const textRule = recreateText
    ? `- On the FRONT cell ONLY: reproduce any text/lettering/logo visible on the product's surface in the reference photo, matching its real position, size and style on the product as closely as possible.${detectedText ? ` The text reads: "${detectedText}".` : ''} This is for overall visual reference only, not a precise vector - a separate exact overlay is added later. On every OTHER cell (Top, Bottom, Back, Left/Right Side) do NOT render any text/lettering/engraving at all - leave that area completely plain and blank, even if the same text would logically appear there too.`
    : `- On the product itself: do NOT render any text/lettering/engraving on the product's surface either - leave any text/engraving area on the product completely plain and blank (real text will be added separately as a precise overlay). To be clear: no text anywhere at all, neither on the product nor around it.`;
  return `Using the attached photo(s) as reference, generate ONE image containing 6 separate sub-images of this exact same physical product, arranged in a clean 2x3 grid with thin dividing lines between cells. Do NOT add any text labels, captions or titles for the cells - the grid position alone identifies each view.
${notesBlock}

Grid layout (left to right, top to bottom):
Row 1: Top, Front, Right Side
Row 2: Bottom, Back, Left Side

Requirements for all 6 sub-images:
- Flat, clean technical/catalog illustration style - no dramatic lighting, no shadows, no reflections, no isometric/3D angle under any circumstances - strictly straight-on orthographic views only
- Plain solid white background for every cell, completely empty - ABSOLUTELY NO text, letters, numbers, watermarks, labels, captions, logos or any marking of any kind anywhere in the white background or empty space around the product (this white-background rule applies even on the FRONT cell). This is a hard rule with zero exceptions.
- Same exact scale, framing and margins across all 6 cells
- Preserve the actual materials, colors and textures visible in the reference photo
- Do NOT add any decorative element, icon, symbol, handle, protrusion or other structural detail that is not visible in the reference photo - even if that kind of object commonly has one (e.g. many cups have handles - do not add one unless you can actually see it in the reference photo). If unsure, leave that area plain rather than inventing something.
${textRule}
- If the reference photo shows more than one physical unit (e.g. a matching pair or set), depict only ONE single unit, not both together
- Back: not visible in the reference photo - do not invent any decorative detail for it. Render only the correct overall silhouette/proportions matching the other views, with the same material/texture, but no engraving.
- Top, Bottom, Left Side, Right Side: infer the correct silhouette and proportions from the reference photo, consistent with the front view.
- CRITICAL - structural consistency: identify every physical structural element visible in the reference photo (handles, spouts, feet, rims, insets, cutouts, protrusions, anything that is not just surface decoration). Every one of these elements MUST appear in EVERY view where it would actually be visible or would protrude into that view's silhouette - do not silently omit a handle or protrusion from the Top or Bottom view just because a typical/generic object of this rough category wouldn't normally have one there. Reason specifically about THIS object's actual geometry: e.g. if there are two side handles, the Top and Bottom views MUST show them sticking out on both sides, not a plain circle/oval as if the handles didn't exist.
- CRITICAL - overall silhouette consistency: do the same for the object's overall 3D shape, not just protrusions. If the reference photo shows a non-rectangular profile - a sloped/angled lid, a tapered or curved body, a bevelled edge, an irregular outline - that same shape must be reflected consistently in every relevant view derived from the SAME imagined 3D object. Do not default to a plain rectangle/box for Side, Top or Bottom just because that is the typical shape for that view of a generic object in this category - reason from what you actually generated for the Front view and carry its real geometry through to the other views. Example: if Front shows a box with a diagonal sloped top edge (like a peaked roof), Side must show that same slope in profile, not a flat rectangle.

Output: a single image, exactly a 2x3 grid as specified, each cell clearly labeled.`;
}

const singleViewLabels = { top:'Top', bottom:'Bottom', front:'Front', back:'Back', side:'Right Side' };
let viewNotes = { top:'', bottom:'', front:'', back:'', side:'' }; // remembers a per-view note while switching the picker
let viewRefImages = { top:null, bottom:null, front:null, back:null, side:null }; // an optional extra reference photo specific to one view

function buildSingleViewPrompt(viewLabel, viewNote, hasSpecificImage){
  const globalNotes = txt('f_aiNotes').trim();
  let notesBlock = '';
  if(globalNotes) notesBlock += `\n\nGeneral designer notes about this product (ground truth, overrides assumptions if they conflict): ${globalNotes}`;
  if(viewNote) notesBlock += `\n\nSpecific instructions for THIS view (${viewLabel}) - follow these precisely, they are the most important guidance for this image: ${viewNote}`;
  if(hasSpecificImage) notesBlock += `\n\nIMPORTANT: the LAST photo attached shows this exact "${viewLabel}" angle directly, photographed specifically for this purpose. Prioritize it as the primary geometric reference for this view over the other photos - match its actual proportions and structure precisely, not just a generic guess.`;
  const recreateText = viewLabel === 'Front' && document.getElementById('f_aiRecreateText').checked;
  const textRule = recreateText
    ? `- Reproduce any text/lettering/logo visible on the product's surface in the reference photo, matching its real position, size and style on the product as closely as possible.${detectedText ? ` The text reads: "${detectedText}".` : ''} This is for overall visual reference only, not a precise vector - a separate exact overlay is added later.`
    : `- ABSOLUTELY NO text, letters, numbers, watermarks, labels, captions, logos or any marking anywhere - not around the product and not on the product's own surface either. This is a hard rule with zero exceptions (real text will be added separately as a precise overlay).`;
  return `Using the attached photo(s) as reference, generate ONE single image showing ONLY the "${viewLabel}" straight-on orthographic view (no angle, no perspective, no isometric/3D under any circumstances) of this exact physical product.
${notesBlock}

Requirements:
- Flat, clean technical/catalog illustration style - no dramatic lighting, no shadows, no reflections
- Plain solid white background, filling the frame with just this one view, no grid, no labels, no other angles, completely empty otherwise
${textRule}
- Preserve the actual materials, colors and textures visible in the reference photo
- Do NOT add any decorative element, icon, symbol, handle, protrusion or other structural detail that is not visible in the reference photo - even if that kind of object commonly has one. If unsure, leave that area plain rather than inventing something.
- If the reference photo shows more than one physical unit (e.g. a matching pair or set), depict only ONE single unit`;
}

async function regenerateSingleView(){
  const viewKey = document.getElementById('f_singleViewPicker').value;
  const viewLabel = singleViewLabels[viewKey];
  const note = document.getElementById('f_singleViewNote').value.trim();
  const specificImg = viewRefImages[viewKey];
  const status = document.getElementById('singleViewStatus');
  if(refImages.length === 0 && !specificImg){
    status.textContent = 'קודם צריך להעלות לפחות תמונת רפרנס אחת (כללית או ספציפית לתצוגה).';
    return;
  }
  const imagesToSend = specificImg ? [...refImages, specificImg] : refImages;
  status.textContent = `🎨 יוצרת מחדש רק את ${viewLabel}...`;
  try {
    const resp = await fetch('/api/generate-views', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ images: imagesToSend, prompt: buildSingleViewPrompt(viewLabel, note, !!specificImg) })
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

const generatableViewKeys = ['top', 'front', 'side', 'bottom', 'back'];

async function generateViews(){
  const status = document.getElementById('genStatus');
  if(refImages.length === 0){
    status.textContent = 'קודם צריך להעלות לפחות תמונת רפרנס אחת.';
    return;
  }
  const selectedKeys = generatableViewKeys.filter(k => document.getElementById('f_genView_' + k).checked);
  if(selectedKeys.length === 0){
    status.textContent = 'צריך לבחור לפחות תצוגה אחת ליצירה.';
    return;
  }

  if(selectedKeys.length === generatableViewKeys.length){
    // all 5 selected - use the combined grid, which keeps the views consistent with each other
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
    return;
  }

  // partial selection - generate just the chosen views, one at a time (same path as "regenerate single view")
  status.textContent = `🎨 יוצר ${selectedKeys.length} תצוגות נבחרות עם AI...`;
  try {
    for(const key of selectedKeys){
      const viewLabel = singleViewLabels[key];
      const resp = await fetch('/api/generate-views', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ images: refImages, prompt: buildSingleViewPrompt(viewLabel, viewNotes[key] || '', false) })
      });
      if(!resp.ok){
        let errMsg = resp.status;
        try { const err = await resp.json(); if(err.error) errMsg = err.error; } catch(e){}
        status.textContent = `יצירת ${viewLabel} נכשלה (${errMsg}) - ממשיכה לתצוגות הבאות.`;
        continue;
      }
      const data = await resp.json();
      viewImages[key] = data.image;
      render();
    }
    status.textContent = '✅ נוצרו התצוגות הנבחרות. אפשר ללחוץ על כל תצוגה כדי להוסיף קווי מידה (שתי נקודות + מספר אמיתי).';
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

/* ===================== saved projects (shared, /api/projects) ===================== */
/* Projects are NEVER auto-saved - only when the designer confirms "yes" in the dialog
   shown by the export button, right before printing. */

const projectFieldIds = [
  'f_code','f_title','f_category','f_rev','f_date',
  'f_material','f_colorname','f_color',
  'd_H','d_W','d_D',
  'f_text','f_fontsize','f_textcolor','f_aiNotes','f_notes'
];

function collectProjectState(){
  const fields = {};
  projectFieldIds.forEach(id => { fields[id] = document.getElementById(id).value; });
  return {
    fields, activeFontId, refImages, viewImages, dimAnnotations,
    engravedPos, detectedText, viewNotes, viewRefImages,
    vectorGraphics, activeGraphicId, reliefAnnotations, layout,
    aiRecreateText: document.getElementById('f_aiRecreateText').checked
  };
}

function applyProjectState(state){
  if(!state) return;
  const fields = state.fields || {};
  projectFieldIds.forEach(id => {
    const el = document.getElementById(id);
    if(el && fields[id] !== undefined) el.value = fields[id];
  });
  activeFontId = state.activeFontId || null;
  refImages = state.refImages || [];
  viewImages = state.viewImages || { top:null, bottom:null, front:null, back:null, side:null };
  dimAnnotations = state.dimAnnotations || { top:[], bottom:[], front:[], back:[], side:[] };
  engravedPos = state.engravedPos || { xPct:50, yPct:78 };
  detectedText = state.detectedText || null;
  viewNotes = state.viewNotes || { top:'', bottom:'', front:'', back:'', side:'' };
  viewRefImages = state.viewRefImages || { top:null, bottom:null, front:null, back:null, side:null };
  vectorGraphics = state.vectorGraphics || [];
  activeGraphicId = state.activeGraphicId || null;
  reliefAnnotations = state.reliefAnnotations || { top:[], bottom:[], front:[], back:[], side:[] };
  document.getElementById('f_aiRecreateText').checked = !!state.aiRecreateText;
  layout = state.layout || cloneDefaultLayout();

  document.getElementById('refImgPreview').innerHTML = refImages.map(src => `<img src="${src}">`).join('');
  renderFontLibrarySelect();
  renderVectorGraphicList();
  buildSkeleton();
  render();
}

async function saveProject(){
  const status = document.getElementById('exportStatus');
  if(status) status.textContent = '⏳ שומר את הפרויקט...';
  try {
    const resp = await fetch('/api/projects', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ code: txt('f_code') || 'untitled', title: txt('f_title') || '', data: collectProjectState() })
    });
    if(!resp.ok){
      let errMsg = resp.status;
      try { const err = await resp.json(); if(err.error) errMsg = err.error; } catch(e){}
      if(status) status.textContent = `שמירת הפרויקט נכשלה (${errMsg}) - ה-PDF יורד בכל זאת.`;
      return;
    }
    if(status) status.textContent = '✅ הפרויקט נשמר לשימוש חוזר.';
    fetchSavedProjects();
  } catch(e){
    if(status) status.textContent = 'שמירת הפרויקט נכשלה (השרת עדיין לא מחובר) - ה-PDF יורד בכל זאת.';
  }
}

async function fetchSavedProjects(){
  try {
    const resp = await fetch('/api/projects');
    if(!resp.ok) throw new Error(resp.status);
    const data = await resp.json();
    const sel = document.getElementById('savedProjectsSelect');
    const projects = data.projects || [];
    sel.innerHTML = '<option value="">— בחרי פרויקט —</option>' + projects.map(p =>
      `<option value="${p.id}">${p.code}${p.title ? ' – ' + p.title : ''} (${new Date(p.uploadedAt).toLocaleDateString('he-IL')})</option>`
    ).join('');
  } catch(e){
    // not critical if this list fails to load - saving/exporting still works
  }
}

async function loadSelectedProject(){
  const sel = document.getElementById('savedProjectsSelect');
  const id = sel.value;
  const status = document.getElementById('loadProjectStatus');
  if(!id){ status.textContent = 'בחרי פרויקט מהרשימה קודם.'; return; }
  status.textContent = '⏳ טוען פרויקט...';
  try {
    const resp = await fetch('/api/projects?id=' + encodeURIComponent(id));
    if(!resp.ok) throw new Error(resp.status);
    const result = await resp.json();
    applyProjectState(result.data);
    status.textContent = '✅ הפרויקט נטען.';
  } catch(e){
    status.textContent = 'טעינת הפרויקט נכשלה.';
  }
}

/* ===================== 3D/relief element annotation tool ===================== */
/* Not real 3D geometry - like a dimension line, this is a marked point + a manufacturing
   callout (depth/height/radius numbers), the same spirit as an engineering-drawing leader line. */

const reliefTypes = {
  engraving: { label: 'חריטה', labelEn: 'ENGRAVED', fields: [ {key:'depth', label:'עומק (מ״מ)'}, {key:'width', label:'רוחב (מ״מ)'} ] },
  protrusion: { label: 'בליטה', labelEn: 'RAISED', fields: [ {key:'height', label:'גובה (מ״מ)'}, {key:'width', label:'רוחב (מ״מ)'} ] },
  curve: { label: 'עיקול', labelEn: 'CURVED', fields: [ {key:'radius', label:'רדיוס (מ״מ)'} ] },
  stripe: { label: 'פס דקורטיבי', labelEn: 'STRIPE', fields: [ {key:'width', label:'רוחב (מ״מ)'}, {key:'thickness', label:'עובי (מ״מ)'} ] },
  recess: { label: 'שקע', labelEn: 'RECESSED', fields: [ {key:'depth', label:'עומק (מ״מ)'}, {key:'width', label:'רוחב (מ״מ)'} ] }
};

function reliefMarkerSvg(ann, index, viewKey){
  const {xPct, yPct, label} = ann;
  const boxW = Math.max(20, label.length * 2.3);
  const labelY = Math.max(4, yPct - 9);
  return `<g class="dim-draggable" data-relief-view="${viewKey}" data-relief-index="${index}">
    <line class="dim-line-overlay" x1="${xPct}%" y1="${yPct}%" x2="${xPct}%" y2="${labelY+2}%"/>
    <circle class="relief-point" cx="${xPct}%" cy="${yPct}%" r="1.6%"/>
    <g class="dim-removable" data-relief-remove-view="${viewKey}" data-relief-remove-index="${index}">
      <rect class="dim-text-bg" x="${xPct-boxW/2}%" y="${labelY-2.6}%" width="${boxW}%" height="5.2%"/>
      <text class="dim-text-overlay" x="${xPct-boxW/2+2}%" y="${labelY+0.6}%" style="direction:ltr; text-anchor:start; font-size:6.5px">${label}</text>
      <text class="dim-remove-x" x="${xPct+boxW/2-2}%" y="${labelY+0.6}%">✕</text>
    </g>
  </g>`;
}

function handleReliefClick(viewKey, canvasEl, e){
  const typeKeys = Object.keys(reliefTypes);
  const typeChoices = typeKeys.map(k => `${reliefTypes[k].label} (${k})`).join('\n');
  const typeInput = prompt(`סוג האלמנט - הקלידי אחת מהמילים:\n${typeChoices}`);
  if(!typeInput) return;
  const trimmed = typeInput.trim();
  const matchedType = typeKeys.find(k => k === trimmed.toLowerCase() || reliefTypes[k].label === trimmed);
  if(!matchedType){ alert('סוג לא מזוהה - לחצי שוב על התמונה ונסי להקליד בדיוק אחת מהמילים מהרשימה.'); return; }

  const values = {};
  for(const field of reliefTypes[matchedType].fields){
    const v = prompt(`${field.label}:`);
    if(v === null) return;
    values[field.key] = parseFloat(v) || 0;
  }

  const rect = canvasEl.getBoundingClientRect();
  const xPct = ((e.clientX - rect.left) / rect.width) * 100;
  const yPct = ((e.clientY - rect.top) / rect.height) * 100;
  const label = reliefTypes[matchedType].labelEn + ' · ' +
    reliefTypes[matchedType].fields.map(f => `${f.key} ${values[f.key]}mm`).join(' · ');

  reliefAnnotations[viewKey].push({ xPct, yPct, type: matchedType, values, label });
  render();
}

/* ===================== dimension-line annotation tool ===================== */
/* simple click-two-points-type-a-number tool - no vector shape editing, just
   static annotation lines drawn on top of whatever image is already there */

function dimLineSvg(ann, index, viewKey){
  const {x1,y1,x2,y2,label} = ann;
  const mx = (x1+x2)/2, my=(y1+y2)/2;
  return `<g class="dim-draggable" data-dim-view="${viewKey}" data-dim-index="${index}">
    <line class="dim-line-overlay" x1="${x1}%" y1="${y1}%" x2="${x2}%" y2="${y2}%"/>
    <g class="dim-removable" data-remove-view="${viewKey}" data-remove-index="${index}">
      <rect class="dim-text-bg" x="${mx-9}%" y="${my-2.6}%" width="18%" height="5.2%"/>
      <text class="dim-text-overlay" x="${mx-2.5}%" y="${my+1.2}%">${label}</text>
      <text class="dim-remove-x" x="${mx+7}%" y="${my+1.2}%">✕</text>
    </g>
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
    const label = `${widthVal}mm`;
    const boxW = Math.max(16, label.length * 3.2);
    svg += `<g>
      <line class="dim-line-overlay" x1="8%" y1="95%" x2="92%" y2="95%"/>
      <line class="dim-tick-overlay" x1="8%" y1="93%" x2="8%" y2="97%"/>
      <line class="dim-tick-overlay" x1="92%" y1="93%" x2="92%" y2="97%"/>
      <rect class="dim-text-bg" x="${50-boxW/2}%" y="91.5%" width="${boxW}%" height="6%"/>
      <text class="dim-text-overlay" x="50%" y="96%" style="direction:ltr">${label}</text>
    </g>`;
  }
  if(heightVal){
    // anchored to grow rightward from a fixed left inset, instead of centering near x=0 -
    // centering longer 3-4 digit numbers there pushed them past the edge and got clipped.
    // direction:ltr is required explicitly - the page is RTL, which flips what "start" anchor
    // means (it would otherwise grow the text leftward, off the edge, defeating the fix)
    const label = `${heightVal}mm`;
    const boxW = Math.max(18, label.length * 4.5);
    svg += `<g>
      <line class="dim-line-overlay" x1="9%" y1="8%" x2="9%" y2="92%"/>
      <line class="dim-tick-overlay" x1="7%" y1="8%" x2="11%" y2="8%"/>
      <line class="dim-tick-overlay" x1="7%" y1="92%" x2="11%" y2="92%"/>
      <rect class="dim-text-bg" x="4%" y="46%" width="${boxW}%" height="7%"/>
      <text class="dim-text-overlay" x="5.5%" y="51%" style="font-size:6.2px; text-anchor:start; direction:ltr">${label}</text>
    </g>`;
  }
  return svg;
}

function handleViewCanvasClick(viewKey, canvasEl, e){
  const removeDimTarget = e.target.closest('[data-remove-view]');
  if(removeDimTarget){
    const rView = removeDimTarget.getAttribute('data-remove-view');
    const rIndex = parseInt(removeDimTarget.getAttribute('data-remove-index'), 10);
    dimAnnotations[rView].splice(rIndex, 1);
    render();
    return;
  }
  const removeReliefTarget = e.target.closest('[data-relief-remove-view]');
  if(removeReliefTarget){
    const rView = removeReliefTarget.getAttribute('data-relief-remove-view');
    const rIndex = parseInt(removeReliefTarget.getAttribute('data-relief-remove-index'), 10);
    reliefAnnotations[rView].splice(rIndex, 1);
    render();
    return;
  }

  if(annotationMode === 'relief'){
    handleReliefClick(viewKey, canvasEl, e);
    return;
  }

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
    dimAnnotations[viewKey].push({ x1: pendingPoint.x, y1: pendingPoint.y, x2: xPct, y2: yPct, label: parseFloat(value) + 'mm' });
  }
  pendingPoint = null;
  render();
}

/* ===================== render ===================== */

/* builds just the <svg> inner content for one view-canvas - factored out so a drag in
   progress can cheaply refresh only this SVG instead of re-rendering the whole sheet */
function buildViewSvgContent(viewKey, H, W, D){
  const annotations = (dimAnnotations[viewKey]||[]).map((ann,i) => dimLineSvg(ann, i, viewKey)).join('');
  const reliefMarkers = (reliefAnnotations[viewKey]||[]).map((ann,i) => reliefMarkerSvg(ann, i, viewKey)).join('');
  const autoDims = viewKey==='section' ? '' : autoDimLines(viewKey, H, W, D);
  const pendingDot = (pendingPoint && pendingPoint.view===viewKey)
    ? `<circle class="dim-point" cx="${pendingPoint.x}%" cy="${pendingPoint.y}%" r="2.5"/>` : '';
  return `${autoDims}${annotations}${reliefMarkers}${pendingDot}`;
}

/* lets a designer drag an already-placed dimension line or relief marker to reposition it,
   instead of only being able to delete and recreate it. Uses a cheap SVG-only refresh during
   the drag (buildViewSvgContent) and a full render() on mouseup to re-attach listeners. */
function wireAnnotationDragging(canvasEl, viewKey){
  canvasEl.querySelectorAll('.dim-draggable').forEach(dragEl => {
    dragEl.addEventListener('mousedown', (e) => {
      if(e.target.closest('.dim-remove-x')) return;
      e.preventDefault();
      e.stopPropagation();

      const rect = canvasEl.getBoundingClientRect();
      let lastXPct = ((e.clientX - rect.left) / rect.width) * 100;
      let lastYPct = ((e.clientY - rect.top) / rect.height) * 100;
      const dimView = dragEl.getAttribute('data-dim-view');
      const dimIndex = dragEl.hasAttribute('data-dim-index') ? parseInt(dragEl.getAttribute('data-dim-index'), 10) : null;
      const reliefView = dragEl.getAttribute('data-relief-view');
      const reliefIndex = dragEl.hasAttribute('data-relief-index') ? parseInt(dragEl.getAttribute('data-relief-index'), 10) : null;
      let moved = false;

      const onMove = (ev) => {
        const curXPct = ((ev.clientX - rect.left) / rect.width) * 100;
        const curYPct = ((ev.clientY - rect.top) / rect.height) * 100;
        const dx = curXPct - lastXPct, dy = curYPct - lastYPct;
        lastXPct = curXPct; lastYPct = curYPct;
        if(Math.abs(dx) > 0.05 || Math.abs(dy) > 0.05) moved = true;

        if(dimView){
          const ann = dimAnnotations[dimView] && dimAnnotations[dimView][dimIndex];
          if(!ann) return;
          ann.x1 += dx; ann.y1 += dy; ann.x2 += dx; ann.y2 += dy;
        } else if(reliefView){
          const ann = reliefAnnotations[reliefView] && reliefAnnotations[reliefView][reliefIndex];
          if(!ann) return;
          ann.xPct += dx; ann.yPct += dy;
        }
        const svgEl = canvasEl.querySelector('svg');
        if(svgEl) svgEl.innerHTML = buildViewSvgContent(viewKey, num('d_H'), num('d_W'), num('d_D'));
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        if(moved){
          document.addEventListener('click', (ce) => { ce.stopPropagation(); ce.preventDefault(); }, { capture:true, once:true });
        }
        render();
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });
}

/* ===================== free-form worksheet layout ===================== */
/* Every box on the sheet (header, the 6 views, ref/engraved/graphic/notes, footer) has an
   explicit x/y/w/h in % of the sheet, and can be dragged (by its label) and resized (corner
   handle) independently - a designer can rearrange the whole page like a work surface. */

const boxDefs = [
  { id:'header' },
  { id:'view_top', viewKey:'top', label:'TOP' },
  { id:'view_bottom', viewKey:'bottom', label:'BOTTOM' },
  { id:'view_front', viewKey:'front', label:'FRONT' },
  { id:'view_back', viewKey:'back', label:'BACK' },
  { id:'view_side', viewKey:'side', label:'SIDE' },
  { id:'view_section', viewKey:'section', label:'SECTION' },
  { id:'ref_box' },
  { id:'engraved_box' },
  { id:'graphic_box' },
  { id:'notes_box' },
  { id:'footer' }
];

const defaultLayout = {
  header:       { xPct:0,    yPct:0,    wPct:100, hPct:10 },
  view_top:     { xPct:0,    yPct:12,   wPct:19,  hPct:40 },
  view_front:   { xPct:20.5, yPct:12,   wPct:19,  hPct:40 },
  view_side:    { xPct:41,   yPct:12,   wPct:19,  hPct:40 },
  view_bottom:  { xPct:0,    yPct:53,   wPct:19,  hPct:40 },
  view_back:    { xPct:20.5, yPct:53,   wPct:19,  hPct:40 },
  view_section: { xPct:41,   yPct:53,   wPct:19,  hPct:40 },
  ref_box:      { xPct:62,   yPct:12,   wPct:38,  hPct:24 },
  engraved_box: { xPct:62,   yPct:37,   wPct:38,  hPct:12 },
  graphic_box:  { xPct:62,   yPct:50,   wPct:38,  hPct:24 },
  notes_box:    { xPct:62,   yPct:75,   wPct:38,  hPct:19 },
  footer:       { xPct:0,    yPct:95.5, wPct:100, hPct:4 }
};

let layout = null;

function cloneDefaultLayout(){
  return JSON.parse(JSON.stringify(defaultLayout));
}

function resetLayout(){
  if(!confirm('לאפס את הפריסה למיקום/גודל ברירת המחדל? כל השינויים הידניים במיקום התיבות יאבדו (התוכן עצמו - תמונות, מידות, טקסט - לא נפגע).')) return;
  layout = cloneDefaultLayout();
  buildSkeleton();
  render();
}

/* drag-by-handle + resize-by-corner for one free-box wrapper. Called once per box in
   buildSkeleton() - the wrapper element itself persists across render() calls (only its
   inner content gets rebuilt), so these listeners never need re-attaching. */
function wireFreeBox(boxEl, boxId){
  const sheet = document.getElementById('sheetCanvas');
  const handle = boxEl.querySelector('.box-handle') || boxEl;

  handle.addEventListener('mousedown', (e) => {
    if(e.target.closest('.view-canvas') || e.target.closest('.graphic-canvas') || e.target.closest('.box-resize-handle')) return;
    e.preventDefault();
    const rect = sheet.getBoundingClientRect();
    let lastXPct = ((e.clientX-rect.left)/rect.width)*100;
    let lastYPct = ((e.clientY-rect.top)/rect.height)*100;
    const onMove = (ev) => {
      const curXPct = ((ev.clientX-rect.left)/rect.width)*100;
      const curYPct = ((ev.clientY-rect.top)/rect.height)*100;
      const dx = curXPct-lastXPct, dy = curYPct-lastYPct;
      lastXPct = curXPct; lastYPct = curYPct;
      const box = layout[boxId];
      box.xPct = Math.max(0, Math.min(100 - box.wPct, box.xPct + dx));
      box.yPct = Math.max(0, Math.min(100 - box.hPct, box.yPct + dy));
      boxEl.style.left = box.xPct + '%';
      boxEl.style.top = box.yPct + '%';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  const resizeHandle = boxEl.querySelector('.box-resize-handle');
  resizeHandle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = sheet.getBoundingClientRect();
    let lastXPct = ((e.clientX-rect.left)/rect.width)*100;
    let lastYPct = ((e.clientY-rect.top)/rect.height)*100;
    const onMove = (ev) => {
      const curXPct = ((ev.clientX-rect.left)/rect.width)*100;
      const curYPct = ((ev.clientY-rect.top)/rect.height)*100;
      const dx = curXPct-lastXPct, dy = curYPct-lastYPct;
      lastXPct = curXPct; lastYPct = curYPct;
      const box = layout[boxId];
      box.wPct = Math.max(6, box.wPct + dx);
      box.hPct = Math.max(4, box.hPct + dy);
      boxEl.style.width = box.wPct + '%';
      boxEl.style.height = box.hPct + '%';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function boxInnerHtml(def){
  if(def.id === 'header'){
    return `<div class="sheet-header box-handle"><div><div class="code"></div><div class="title"></div></div><div class="meta"></div></div>`;
  }
  if(def.viewKey){
    return `<div class="label box-handle">${def.label}</div><div class="view-canvas" id="canvas-${def.viewKey}"></div>`;
  }
  if(def.id === 'ref_box'){
    return `<div class="label box-handle">Reference appearance</div><div id="refImgGallery" class="ref-img-gallery"></div><div id="detectedTextCaption" class="detected-text-caption"></div>`;
  }
  if(def.id === 'engraved_box'){
    return `<div class="label box-handle">ENGRAVED TEXT (EXACT FONT)</div><div id="engravedBoxText" class="engraved-box-text"></div>`;
  }
  if(def.id === 'graphic_box'){
    return `<div class="label box-handle">FRONT - VECTOR GRAPHIC PLACEMENT</div><div class="graphic-canvas" id="graphicCanvas"></div>`;
  }
  if(def.id === 'notes_box'){
    return `<div class="label box-handle">MANUFACTURING NOTES</div><ol id="notesList"></ol>`;
  }
  if(def.id === 'footer'){
    return `<div class="sheet-footer box-handle"><span>CONCEPT TECHNICAL SPECIFICATION - supplier must confirm production engineering, tolerances and tooling feasibility before mold release.</span><span id="footerRev"></span></div>`;
  }
  return '';
}

function buildSkeleton(){
  if(!layout) layout = cloneDefaultLayout();
  const sheet = document.getElementById('specSheet');
  const boxesHtml = boxDefs.map(def => {
    const pos = layout[def.id];
    const extraClass = def.id === 'header' ? 'header-box' : def.id === 'footer' ? 'footer-box' : def.viewKey ? 'view-box' : def.id.replace(/_/g,'-');
    return `<div class="free-box ${extraClass}" id="box-${def.id}" style="left:${pos.xPct}%; top:${pos.yPct}%; width:${pos.wPct}%; height:${pos.hPct}%">
      ${boxInnerHtml(def)}
      <div class="box-resize-handle"></div>
    </div>`;
  }).join('');
  sheet.innerHTML = `<div id="sheetCanvas" class="sheet-canvas">${boxesHtml}</div>`;

  boxDefs.forEach(def => wireFreeBox(document.getElementById('box-'+def.id), def.id));

  boxDefs.forEach(def => {
    if(!def.viewKey || def.viewKey === 'section') return;
    const canvasEl = document.getElementById('canvas-' + def.viewKey);
    canvasEl.addEventListener('click', (e) => {
      if(e.target.closest('.engraved-text-overlay')) return;
      if(e.target.closest('.dim-draggable') && !e.target.closest('[data-remove-view]') && !e.target.closest('[data-relief-remove-view]')) return;
      handleViewCanvasClick(def.viewKey, canvasEl, e);
    });
  });
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
    `Material: ${material || '—'}<br>Color: ${colorname || '—'}<br>H×W×D: ${H??'—'} × ${W??'—'} × ${D??'—'} mm`;

  const gallery = document.getElementById('refImgGallery');
  gallery.innerHTML = refImages.length === 0 ? '' : refImages.map(src => `<img src="${src}">`).join('');
  gallery.className = 'ref-img-gallery' + (refImages.length <= 1 ? ' single' : '');

  document.getElementById('detectedTextCaption').innerHTML = detectedText
    ? `Text detected automatically by AI: <strong>${detectedText}</strong> (for verification - not exact vector)`
    : '';

  const engravedBox = document.getElementById('box-engraved_box');
  if(text && activeFontId){
    engravedBox.style.display = 'flex';
    document.getElementById('engravedBoxText').innerHTML =
      `<span style="font-family:'custom-${cssSafeId(activeFontId)}'; color:${textcolor}">${text}</span>`;
  } else {
    engravedBox.style.display = 'none';
  }

  const graphicBox = document.getElementById('box-graphic_box');
  const frontImgSrc = viewImages.front;
  if(frontImgSrc){
    graphicBox.style.display = 'flex';
    const graphicCanvas = document.getElementById('graphicCanvas');
    graphicCanvas.innerHTML = `
      <img src="${frontImgSrc}">
      ${vectorGraphics.length === 0 ? '<div class="placeholder">העלי קובץ SVG בפאנל כדי למקם אותו כאן</div>' : ''}
      ${vectorGraphics.map(g => `
        <div class="vector-graphic-overlay ${g.id===activeGraphicId?'active':''}" data-graphic-id="${g.id}"
             style="left:${g.xPct}%; top:${g.yPct}%; width:${g.widthPct}%; transform:translate(-50%,-50%) rotate(${g.rotationDeg}deg)">
          ${g.svgMarkup}
        </div>
      `).join('')}
    `;
    graphicCanvas.querySelectorAll('.vector-graphic-overlay').forEach(overlayEl => {
      const gId = overlayEl.getAttribute('data-graphic-id');
      overlayEl.addEventListener('mousedown', (e) => {
        e.preventDefault();
        selectGraphic(gId);
        const g = vectorGraphics.find(gr => gr.id === gId);
        const onMove = (ev) => {
          const rect = graphicCanvas.getBoundingClientRect();
          g.xPct = Math.max(0, Math.min(100, ((ev.clientX-rect.left)/rect.width)*100));
          g.yPct = Math.max(0, Math.min(100, ((ev.clientY-rect.top)/rect.height)*100));
          overlayEl.style.left = g.xPct + '%';
          overlayEl.style.top = g.yPct + '%';
        };
        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    });
  } else {
    graphicBox.style.display = 'none';
  }

  const labels = [
    {key:'top'}, {key:'bottom'}, {key:'front'},
    {key:'back'}, {key:'side'}, {key:'section'}
  ];
  labels.forEach(v => {
    const canvasEl = document.getElementById('canvas-' + v.key);
    const imgSrc = viewImages[v.key];
    const fitMode = 'contain'; // never distort the AI image - real measurements come from the dimension lines, not from stretching pixels
    const engravedOverlay = (v.key==='front' && text) ? `<div class="engraved-text-overlay" id="engravedOverlay" style="left:${engravedPos.xPct}%; top:${engravedPos.yPct}%; font-size:${fontsize}px; color:${textcolor}; font-family:${activeFontId?`'custom-${cssSafeId(activeFontId)}'`:'inherit'}">${text}</div>` : '';

    canvasEl.innerHTML = `
      ${imgSrc ? `<img src="${imgSrc}" style="object-fit:${fitMode}">` : (v.key==='section' ? '<div class="placeholder">Schematic drawing - add manually</div>' : '<div class="placeholder">Image not generated yet</div>')}
      ${engravedOverlay}
      <svg>${buildViewSvgContent(v.key, H, W, D)}</svg>
    `;

    if(v.key !== 'section'){
      wireAnnotationDragging(canvasEl, v.key);
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
  const reliefNoteLines = [];
  Object.keys(reliefAnnotations).forEach(viewKey => {
    reliefAnnotations[viewKey].forEach(ann => {
      reliefNoteLines.push(`${viewKey.toUpperCase()}: ${ann.label}`);
    });
  });
  notesList.innerHTML = [...lines, ...reliefNoteLines].map(l=>`<li>${l}</li>`).join('');

  document.getElementById('footerRev').textContent =
    `REV. ${rev || '01'} | ${date ? new Date(date).toLocaleDateString('en-GB').replace(/\//g,' ').toUpperCase() : ''}`;
}

/* ===================== wiring ===================== */

document.addEventListener('DOMContentLoaded', () => {
  buildSkeleton();
  document.getElementById('f_date').valueAsDate = new Date();

  fetchFontLibrary();
  fetchSavedProjects();

  document.querySelectorAll('.panel input, .panel select, .panel textarea')
    .forEach(el => el.addEventListener('input', render));

  document.getElementById('fontLibrarySelect').addEventListener('change', (e) => {
    activeFontId = e.target.value || null;
    render();
  });

  document.getElementById('f_fontUpload').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if(!file) return;
    const status = document.getElementById('fontLibraryStatus');
    status.textContent = '⏳ מעלה פונט לספרייה המשותפת...';
    try {
      const dataUrl = await fileToDataUrl(file);
      const resp = await fetch('/api/fonts', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ name: file.name, dataUrl })
      });
      if(!resp.ok){
        let errMsg = resp.status;
        try { const err = await resp.json(); if(err.error) errMsg = err.error; } catch(err){}
        status.textContent = `העלאת הפונט נכשלה (${errMsg}).`;
        return;
      }
      const newFont = await resp.json();
      fontLibrary.push(newFont);
      activeFontId = newFont.id;
      injectFontFaces();
      renderFontLibrarySelect();
      status.textContent = `✅ הפונט "${newFont.name}" נשמר בספרייה המשותפת.`;
      render();
    } catch(err){
      status.textContent = 'העלאת הפונט נכשלה (השרת עדיין לא מחובר).';
    }
    e.target.value = '';
  });

  document.getElementById('btnLoadProject').addEventListener('click', loadSelectedProject);
  document.getElementById('btnResetLayout').addEventListener('click', resetLayout);

  const btnModeDimension = document.getElementById('btnModeDimension');
  const btnModeRelief = document.getElementById('btnModeRelief');
  function updateModeButtons(){
    btnModeDimension.classList.toggle('active', annotationMode === 'dimension');
    btnModeRelief.classList.toggle('active', annotationMode === 'relief');
  }
  btnModeDimension.addEventListener('click', () => { annotationMode = 'dimension'; pendingPoint = null; updateModeButtons(); render(); });
  btnModeRelief.addEventListener('click', () => { annotationMode = 'relief'; pendingPoint = null; updateModeButtons(); render(); });

  renderVectorGraphicList();

  document.getElementById('f_vectorGraphicUpload').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if(!file) return;
    const status = document.getElementById('vectorGraphicStatus');
    const text = await fileToText(file);
    if(!/<svg[\s>]/i.test(text)){
      status.textContent = 'הקובץ שנבחר לא נראה כמו SVG תקין.';
      e.target.value = '';
      return;
    }
    const id = 'g' + Date.now();
    vectorGraphics.push({
      id, name: file.name.replace(/\.[^.]+$/, ''), svgMarkup: text,
      xPct: 50, yPct: 50, widthPct: 20, rotationDeg: 0
    });
    activeGraphicId = id;
    status.textContent = `✅ "${file.name}" נוסף - אפשר לגרור אותו על התמונה כדי למקם אותו.`;
    renderVectorGraphicList();
    render();
    e.target.value = '';
  });

  document.getElementById('g_width').addEventListener('input', (e) => {
    const g = vectorGraphics.find(gr => gr.id === activeGraphicId);
    if(!g) return;
    g.widthPct = parseFloat(e.target.value) || g.widthPct;
    render();
  });
  document.getElementById('g_rotation').addEventListener('input', (e) => {
    const g = vectorGraphics.find(gr => gr.id === activeGraphicId);
    if(!g) return;
    g.rotationDeg = parseFloat(e.target.value) || 0;
    render();
  });
  document.getElementById('btnRemoveGraphic').addEventListener('click', () => {
    if(activeGraphicId) removeGraphic(activeGraphicId);
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
  function renderSingleViewImgPreview(){
    const viewKey = document.getElementById('f_singleViewPicker').value;
    const preview = document.getElementById('singleViewImgPreview');
    preview.innerHTML = viewRefImages[viewKey] ? `<img src="${viewRefImages[viewKey]}">` : '';
  }
  document.getElementById('f_singleViewPicker').addEventListener('change', (e) => {
    document.getElementById('f_singleViewNote').value = viewNotes[e.target.value] || '';
    document.getElementById('f_singleViewRefImage').value = '';
    renderSingleViewImgPreview();
  });
  document.getElementById('f_singleViewRefImage').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if(!file) return;
    const viewKey = document.getElementById('f_singleViewPicker').value;
    viewRefImages[viewKey] = await fileToDataUrl(file);
    renderSingleViewImgPreview();
  });
  document.getElementById('btnRegenerateSingleView').addEventListener('click', regenerateSingleView);

  document.getElementById('btnExport').addEventListener('click', async () => {
    const wantsSave = confirm('האם לשמור את הפרויקט לפעם הבאה?');
    if(wantsSave){
      await saveProject();
    }
    window.print();
  });

  render();
});
