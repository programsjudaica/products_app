/* ===================== state ===================== */

let refImages = []; // data URLs, max 8
let clipCounter = 0;
let customMaterials = []; // {id, name, baseType, density, opacity} - user-defined materials not in the built-in list
let primaryImageAspect = null; // width/height ratio detected from first uploaded image
let bboxDetectionFailed = false;
let textVector = null; // {viewBox, inner} parsed from an uploaded Illustrator SVG export

/* aiSketchParts: [{id, name, primary, visible, points:[{x,y},...], symmetric, axisX}, ...]
   Multiple parts because many products are physically several pieces (a kiddush cup + its
   own saucer, a besamim tower + lid) - forcing that into one polygon looks wrong. All parts
   share the same front-view mm coordinate space, so their relative position stays correct. */
let aiSketchParts = null;
let activePartId = null;
let draggingRef = null; // {partId, index}
let distanceLockModeOn = false;
let selectedPointRefs = []; // [{partId, index}, ...] max 2, must be same part

function getPart(partId){ return aiSketchParts ? aiSketchParts.find(p => p.id === partId) : null; }
function getActivePart(){ return getPart(activePartId); }

/* mirrors a right-half point profile across a vertical axis into a full closed polygon.
   Nothing about the left half is ever stored - it's always derived, so it's structurally
   impossible for the two sides to drift out of symmetry. */
function buildSymmetricFullPoints(rightPoints, axisX){
  if(!rightPoints || rightPoints.length < 2) return rightPoints || [];
  const mirrored = rightPoints.slice().reverse().map(p => ({ x: 2*axisX - p.x, y: p.y }));
  return [...rightPoints, ...mirrored];
}

function fullPointsForPart(part){
  return part.symmetric ? buildSymmetricFullPoints(part.points, part.axisX) : part.points;
}

/* the full multi-subpath outline for every visible part, as a single SVG "d" string
   (SVG paths natively support several "M...Z" subpaths in one d attribute) */
function combinedSketchPathD(){
  if(!aiSketchParts) return null;
  const visible = aiSketchParts.filter(p => p.visible);
  if(visible.length === 0) return null;
  return visible.map(p => pointsToPath(fullPointsForPart(p))).join(' ');
}

function convertPartToSymmetric(part){
  if(!part || part.points.length < 3) return;
  const xs = part.points.map(p => p.x);
  const axisX = (Math.min(...xs) + Math.max(...xs)) / 2;
  let right = part.points.filter(p => p.x >= axisX);
  if(right.length < 2) right = part.points.slice();
  right.sort((a,b) => a.y - b.y);
  right[0] = { ...right[0], x: axisX };
  right[right.length-1] = { ...right[right.length-1], x: axisX };
  part.points = right;
  part.axisX = axisX;
  part.symmetric = true;
}

/* uniform scale of a part's point set around one anchor point - used by the distance-lock
   tool: pick two points in the SAME part, say what the real mm distance between them should
   be, everything in that part rescales proportionally around the first point. */
function applyDistanceLock(pointsArr, idxA, idxB, desiredMm){
  const a = pointsArr[idxA], b = pointsArr[idxB];
  const currentDist = Math.hypot(b.x-a.x, b.y-a.y);
  if(currentDist < 0.001) return;
  const scale = desiredMm / currentDist;
  for(let i=0; i<pointsArr.length; i++){
    pointsArr[i].x = a.x + (pointsArr[i].x - a.x) * scale;
    pointsArr[i].y = a.y + (pointsArr[i].y - a.y) * scale;
  }
}

function updateDistanceLockStatus(){
  const box = document.getElementById('distanceLockStatus');
  if(!box) return;
  if(!distanceLockModeOn){ box.innerHTML = ''; return; }
  if(selectedPointRefs.length < 2){
    box.textContent = `מצב נעילת מרחק פעיל - לחצי על שתי נקודות **באותו חלק** בתצוגת Front (נבחרו ${selectedPointRefs.length}/2).`;
    return;
  }
  const [refA, refB] = selectedPointRefs;
  if(refA.partId !== refB.partId){
    box.textContent = 'אפשר לנעול מרחק רק בין שתי נקודות באותו חלק (לא בין חלקים שונים). בחרי שוב.';
    selectedPointRefs = [];
    return;
  }
  const part = getPart(refA.partId);
  const a = part.points[refA.index], b = part.points[refB.index];
  const currentMm = Math.hypot(b.x-a.x, b.y-a.y).toFixed(1);
  box.innerHTML = `מרחק נוכחי (בחלק "${part.name}"): ${currentMm}מ"מ. מרחק אמיתי (מ"מ): <input type="number" id="distanceLockValue" style="width:5em"> <button type="button" id="btnApplyDistanceLock">החל</button>`;
  document.getElementById('btnApplyDistanceLock').addEventListener('click', ()=>{
    const val = parseFloat(document.getElementById('distanceLockValue').value);
    if(!val || val <= 0) return;
    applyDistanceLock(part.points, refA.index, refB.index, val);
    selectedPointRefs = [];
    distanceLockModeOn = false;
    document.getElementById('btnDistanceLockMode').textContent = 'מצב נעילת מרחק מדויק בין שתי נקודות';
    render();
  });
}

function updateAspectSuggestion(){
  const box = document.getElementById('aspectSuggest');
  if(refImages.length === 0){ box.innerHTML = ''; return; }
  if(bboxDetectionFailed || primaryImageAspect === null){
    box.innerHTML = 'לא הצלחתי לזהות את גבולות המוצר בתמונה (רקע לא אחיד?) - אפשר עדיין להשתמש בה כרקע להתאמה ידנית.';
    return;
  }
  const sH = num('d_H');
  let suggestion = `יחס רוחב/גובה שזוהה בתמונה: ${primaryImageAspect.toFixed(2)}.`;
  if(sH){
    const suggestedW = Math.round(sH * primaryImageAspect);
    suggestion += ` לפי הגובה שהוזן (${sH}מ"מ) - רוחב מוצע: ~${suggestedW}מ"מ`;
    box.innerHTML = suggestion + ` <button type="button" id="btnApplyAspect">החל על רוחב</button>`;
    document.getElementById('btnApplyAspect').addEventListener('click', ()=>{
      document.getElementById('d_W').value = suggestedW;
      render();
    });
  } else {
    box.innerHTML = suggestion + ' הזיני גובה כדי לקבל הצעת רוחב מדויקת.';
  }
}

/* applies a structured AI-analysis result (whether pasted manually or fetched
   automatically from /api/analyze) onto the form fields. Always a suggestion the
   designer can see and override - never applied silently without a status message. */
function applyAiData(data, statusEl){
  function setField(id, v){
    if(v === undefined || v === null || v === '') return false;
    const el = document.getElementById(id);
    el.value = v;
    el.dispatchEvent(new Event('input', {bubbles:true}));
    return true;
  }
  const applied = [];
  if(setField('f_material', data.material)) applied.push('חומר');
  if(data.color_hex){
    const hex = data.color_hex.startsWith('#') ? data.color_hex : '#'+data.color_hex;
    if(setField('f_color', hex)) applied.push('צבע');
  }
  const knownTextures = ['ribs','stone','crystal','concrete','glass','wood','leather','none'];
  if(data.texture_type && knownTextures.includes(data.texture_type)){
    if(setField('f_texture', data.texture_type)) applied.push('טקסטורה');
  }
  if(data.text_style && ['engraved','embossed'].includes(data.text_style)){
    if(setField('f_textStyle', data.text_style)) applied.push('סגנון כיתוב');
  }
  if(data.top_opening){
    if(setField('d_slotOffsetX', data.top_opening.offsetX_hint)) applied.push('מיקום חריץ (אופקי)');
    if(setField('d_slotOffsetY', data.top_opening.offsetY_hint)) applied.push('מיקום חריץ (מהקצה)');
  }
  if(data.text_position){
    if(setField('f_textOffsetX', data.text_position.offsetX_hint)) applied.push('מיקום טקסט (אופקי)');
    if(setField('f_textOffsetY', data.text_position.offsetY_hint)) applied.push('מיקום טקסט (מהתחתית)');
  }

  let msg = applied.length ? `הוחל אוטומטית: ${applied.join(', ')}.` : 'לא נמצאו שדות מוכרים בתשובת ה-AI - בדקי את הפורמט.';
  if(data.shape_family) msg += ` משפחת צורה מוצעת ע"י ה-AI: "${data.shape_family}" (הפרוטוטייפ תומך כרגע רק ב"קופסה מעוגלת").`;
  if(data.top_opening && data.top_opening.present === false) msg += ' AI ציין: לא נראה פתח עליון בתמונה - בדקי אם רלוונטי.';
  if(data.notes) msg += ` הערת AI: ${data.notes}`;
  if(statusEl) statusEl.textContent = msg;
  render();
  return msg;
}

/* fires automatically after images are uploaded - best-effort: if no backend is
   deployed yet (no /api/analyze), fails quietly with a clear status instead of breaking the app */
async function autoAnalyze(){
  if(refImages.length === 0) return;
  const banner = document.getElementById('aiAutoStatus');
  if(!banner) return;
  banner.style.display = 'block';
  banner.textContent = '🤖 מנתחת את התמונות...';
  try {
    const resp = await fetch('/api/analyze', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ images: refImages })
    });
    if(!resp.ok){
      let errMsg = resp.status;
      try { const err = await resp.json(); if(err.error) errMsg = err.error; } catch(e){}
      banner.textContent = `ניתוח אוטומטי לא זמין כרגע (${errMsg}) - אפשר להמשיך עם ההעלאה הידנית של JSON למעלה.`;
      return;
    }
    const data = await resp.json();
    const msg = applyAiData(data, null);
    banner.textContent = '🤖 זוהה אוטומטית - ' + msg;
  } catch(e){
    banner.textContent = 'ניתוח אוטומטי לא זמין כרגע (השרת עדיין לא מחובר) - אפשר להמשיך עם ההעלאה הידנית של JSON למעלה.';
  }
}

/* parses a straight-line-only "M x,y L x,y ... Z" path into an ordered point array.
   The AI sketch endpoint is constrained (by its own prompt) to only ever emit M/L/Z,
   specifically so this simple parser is sufficient - no curve math needed. */
function parseStraightLinePath(d){
  const points = [];
  const re = /[ML]\s*(-?[\d.]+)[,\s]+(-?[\d.]+)/gi;
  let m;
  while((m = re.exec(d)) !== null){
    points.push({ x: parseFloat(m[1]), y: parseFloat(m[2]) });
  }
  return points;
}

function pointsToPath(points){
  if(!points || points.length === 0) return '';
  return 'M ' + points.map(p => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' L ') + ' Z';
}

async function generateAiSketch(){
  const status = document.getElementById('sketchStatus');
  const H = num('d_H'), W = num('d_W');
  if(!H || !W){
    status.textContent = 'קודם צריך למלא גובה ורוחב ב"מידות כלליות" למעלה - בלעדיהם אין קנה מידה לסקיצה.';
    return;
  }
  if(refImages.length === 0){
    status.textContent = 'קודם צריך להעלות לפחות תמונת רפרנס אחת.';
    return;
  }
  status.textContent = '🤖 משרטטת סקיצה ראשונית...';
  try {
    const resp = await fetch('/api/sketch', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ images: refImages })
    });
    if(!resp.ok){
      let errMsg = resp.status;
      try { const err = await resp.json(); if(err.error) errMsg = err.error; } catch(e){}
      status.textContent = `הסקיצה האוטומטית לא זמינה כרגע (${errMsg}).`;
      return;
    }
    const data = await resp.json();
    if(!Array.isArray(data.parts) || data.parts.length === 0){
      status.textContent = 'ה-AI לא החזיר צורה תקינה - אפשר לנסות שוב או להמשיך עם הצורה הבסיסית.';
      return;
    }
    const margin = 16;
    const parts = [];
    data.parts.forEach((p, i) => {
      const normPoints = parseStraightLinePath(p.path);
      if(normPoints.length < 3) return;
      parts.push({
        id: 'part' + Date.now() + '_' + i,
        name: p.name || `חלק ${i+1}`,
        primary: !!p.primary,
        visible: true,
        symmetric: false,
        axisX: null,
        points: normPoints.map(pt => ({ x: margin + (pt.x/100) * W, y: margin + (pt.y/100) * H }))
      });
    });
    if(parts.length === 0){
      status.textContent = 'ה-AI לא החזיר צורה תקינה - אפשר לנסות שוב או להמשיך עם הצורה הבסיסית.';
      return;
    }
    aiSketchParts = parts;
    activePartId = (parts.find(p => p.primary) || parts[0]).id;

    let msg = data.confidence ? `🤖 סקיצה נוצרה (רמת ביטחון: ${data.confidence}), ${parts.length} חלק/ים: ${parts.map(p=>p.name).join(', ')}.` : `🤖 סקיצה נוצרה, ${parts.length} חלק/ים.`;
    if(data.notes) msg += ` ${data.notes}`;
    if(data.questions && data.questions.length) msg += ` שאלות מה-AI: ${data.questions.join(' | ')}`;
    msg += ' בחרי חלק לעריכה למטה וגררי את הנקודות שלו על תצוגת ה-Front כדי לדייק.';
    status.textContent = msg;
    render();
  } catch(e){
    status.textContent = 'הסקיצה האוטומטית לא זמינה כרגע (השרת עדיין לא מחובר).';
  }
}

/* draggable point-editor overlaid on the AI-suggested front silhouette - lets the designer
   nudge the rough sketch into an accurate shape without needing Illustrator */
/* only the active part's points get draggable handles (avoids clutter when there are
   several parts) - the other parts still render their outline, just not editable right now */
function renderPartSelector(){
  const box = document.getElementById('partSelector');
  if(!box || !aiSketchParts) return;
  box.innerHTML = aiSketchParts.map(part => `
    <div class="part-row ${part.id === activePartId ? 'active' : ''}">
      <input type="radio" name="activePartRadio" data-part-id="${part.id}" ${part.id === activePartId ? 'checked' : ''}>
      <span class="part-name">${part.name}${part.primary ? ' (עיקרי)' : ''}</span>
      ${part.symmetric ? '<span class="sym-badge">סימטרי</span>' : ''}
      <label><input type="checkbox" data-visible-part-id="${part.id}" ${part.visible ? 'checked' : ''}> כלול</label>
    </div>
  `).join('');
  box.querySelectorAll('input[data-part-id]').forEach(el => {
    el.addEventListener('change', () => { activePartId = el.getAttribute('data-part-id'); render(); });
  });
  box.querySelectorAll('input[data-visible-part-id]').forEach(el => {
    el.addEventListener('change', () => {
      const part = getPart(el.getAttribute('data-visible-part-id'));
      if(part) part.visible = el.checked;
      render();
    });
  });
}

function attachSketchHandles(){
  const svg = document.getElementById('frontOutlinePath');
  const part = getActivePart();
  if(!svg || !part) return;
  const svgRoot = svg.ownerSVGElement;
  if(!svgRoot) return;

  part.points.forEach((pt, i) => {
    const isSelected = selectedPointRefs.some(r => r.partId === part.id && r.index === i);
    const handle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    handle.setAttribute('cx', pt.x);
    handle.setAttribute('cy', pt.y);
    handle.setAttribute('r', 2.2);
    handle.setAttribute('fill', isSelected ? '#c0392b' : '#8a7a5c');
    handle.setAttribute('stroke', '#fff');
    handle.setAttribute('stroke-width', '0.5');
    handle.style.cursor = distanceLockModeOn ? 'pointer' : 'grab';

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();

      if(distanceLockModeOn){
        const ref = { partId: part.id, index: i };
        const existingIdx = selectedPointRefs.findIndex(r => r.partId === ref.partId && r.index === ref.index);
        if(existingIdx >= 0){
          selectedPointRefs.splice(existingIdx, 1);
        } else {
          selectedPointRefs.push(ref);
          if(selectedPointRefs.length > 2) selectedPointRefs.shift();
        }
        updateDistanceLockStatus();
        render();
        return;
      }

      draggingRef = { partId: part.id, index: i };
      const onMove = (ev) => {
        if(!draggingRef) return;
        const pointInSvg = svgRoot.createSVGPoint();
        pointInSvg.x = ev.clientX; pointInSvg.y = ev.clientY;
        const ctm = svgRoot.getScreenCTM();
        if(!ctm) return;
        const local = pointInSvg.matrixTransform(ctm.inverse());
        part.points[draggingRef.index].x = local.x;
        part.points[draggingRef.index].y = local.y;
        handle.setAttribute('cx', local.x);
        handle.setAttribute('cy', local.y);
        svg.setAttribute('d', combinedSketchPathD());
      };
      const onUp = () => {
        draggingRef = null;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        render();
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
    svgRoot.appendChild(handle);
  });
}

function num(id){
  const v = document.getElementById(id).value;
  return v === '' || v === null ? null : parseFloat(v);
}
function txt(id){ return document.getElementById(id).value; }

function getState(){
  return {
    code: txt('f_code'), title: txt('f_title'), category: txt('f_category'),
    rev: txt('f_rev'), date: txt('f_date'),
    material: txt('f_material'), color: txt('f_color'), colorname: txt('f_colorname'),
    texture: txt('f_texture'),
    H: num('d_H'), W: num('d_W'), D: num('d_D'),
    wall: num('d_wall'), radius: num('d_radius'), bottom: num('d_bottom'),
    slotW: num('d_slotW'), slotH: num('d_slotH'),
    slotOffsetX: num('d_slotOffsetX'), slotOffsetY: num('d_slotOffsetY'),
    cork: num('d_cork'), corkNote: txt('d_corkNote'),
    corkOffsetX: num('d_corkOffsetX'), corkOffsetY: num('d_corkOffsetY'),
    text: txt('f_text'), font: document.getElementById('f_font').value,
    fontsize: num('f_fontsize') || 9,
    letterspacing: num('f_letterspacing') || 0,
    strokew: num('f_strokew') || 0.4,
    textOffsetX: num('f_textOffsetX'), textOffsetY: num('f_textOffsetY'),
    textStyle: txt('f_textStyle'), textColor: txt('f_textColor'),
    notes: txt('f_notes'),
    showRefBg: document.getElementById('f_showRefBg').checked,
    refOpacity: parseFloat(document.getElementById('f_refOpacity').value)
  };
}

/* rough bounding-box detection: distinguishes the product from a plain/near-white
   or transparent studio background. Gives an approximate width/height ratio only -
   not a manufacturing-accurate contour, just a starting-point suggestion. */
function analyzeImageBBox(dataURL){
  return new Promise(resolve=>{
    const img = new Image();
    img.onload = () => {
      const cw = 220, ch = Math.max(1, Math.round(220 * img.height / img.width));
      const canvas = document.createElement('canvas');
      canvas.width = cw; canvas.height = ch;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, cw, ch);
      let data;
      try { data = ctx.getImageData(0, 0, cw, ch).data; }
      catch(e){ resolve(null); return; } // e.g. tainted canvas
      let minX=cw, minY=ch, maxX=0, maxY=0, found=false;
      for(let y=0; y<ch; y++){
        for(let x=0; x<cw; x++){
          const i = (y*cw+x)*4;
          const r=data[i], g=data[i+1], b=data[i+2], a=data[i+3];
          const isBg = a < 10 || (r>235 && g>235 && b>235);
          if(!isBg){
            found = true;
            if(x<minX)minX=x; if(x>maxX)maxX=x;
            if(y<minY)minY=y; if(y>maxY)maxY=y;
          }
        }
      }
      if(!found){ resolve(null); return; }
      resolve({ w: maxX-minX, h: maxY-minY, aspect: (maxX-minX)/Math.max(1,(maxY-minY)) });
    };
    img.onerror = () => resolve(null);
    img.src = dataURL;
  });
}

/* fallback drawing values when a field is left empty (shape still needs proportions,
   but dimension labels are only drawn when the user actually provided a value) */
function withDefaults(s){
  return {
    H: s.H ?? 140, W: s.W ?? 102, D: s.D ?? 62,
    wall: s.wall ?? 2, radius: s.radius ?? 6, bottom: s.bottom ?? 3,
    slotW: s.slotW ?? 50, slotH: s.slotH ?? 7,
    cork: s.cork ?? 34
  };
}

/* ===================== geometry helpers ===================== */

function roundedRectPath(x, y, w, h, r){
  r = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  return `M ${x+r},${y}
    H ${x+w-r} A ${r},${r} 0 0 1 ${x+w},${y+r}
    V ${y+h-r} A ${r},${r} 0 0 1 ${x+w-r},${y+h}
    H ${x+r} A ${r},${r} 0 0 1 ${x},${y+h-r}
    V ${y+r} A ${r},${r} 0 0 1 ${x+r},${y} Z`;
}

function circlePathD(cx, cy, r){
  return `M ${cx-r},${cy} A ${r},${r} 0 1 0 ${cx+r},${cy} A ${r},${r} 0 1 0 ${cx-r},${cy} Z`;
}

function darken(hex, amt){
  const c = hex.replace('#','');
  const num = parseInt(c,16);
  let r = (num>>16) - amt, g = ((num>>8)&0xff) - amt, b = (num&0xff) - amt;
  r = Math.max(0,Math.min(255,r)); g = Math.max(0,Math.min(255,g)); b = Math.max(0,Math.min(255,b));
  return '#' + ((1<<24)+(r<<16)+(g<<8)+b).toString(16).slice(1);
}

/* dimension line with end-ticks and a centered label; orientation 'h' or 'v' */
function dimLine(x1,y1,x2,y2,label,orientation){
  if(label === null || label === undefined) return '';
  const tick = 2;
  let ticks = '';
  if(orientation === 'h'){
    ticks = `<line x1="${x1}" y1="${y1-tick}" x2="${x1}" y2="${y1+tick}" class="dim-tick"/>
             <line x1="${x2}" y1="${y2-tick}" x2="${x2}" y2="${y2+tick}" class="dim-tick"/>`;
  } else {
    ticks = `<line x1="${x1-tick}" y1="${y1}" x2="${x1+tick}" y2="${y1}" class="dim-tick"/>
             <line x1="${x2-tick}" y1="${y2}" x2="${x2+tick}" y2="${y2}" class="dim-tick"/>`;
  }
  const mx = (x1+x2)/2, my=(y1+y2)/2;
  const labelTransform = orientation === 'v' ? `transform="rotate(-90 ${mx} ${my})"` : '';
  return `<g class="dim">
    <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="dim-line"/>
    ${ticks}
    <rect x="${mx-9}" y="${my-3.2}" width="18" height="6.4" fill="white" opacity="0.85" ${labelTransform}/>
    <text x="${mx}" y="${my+1.6}" class="dim-text" ${labelTransform}>${label}</text>
  </g>`;
}

/* texture overlay clipped to a path */
function textureOverlay(clipId, path, type, color){
  let overlay = '';
  const dark = darken(color, 40);
  if(type === 'crystal'){
    overlay = `<g clip-path="url(#${clipId})" opacity="0.55">
      <line x1="-10" y1="20" x2="120" y2="-10" stroke="white" stroke-width="3"/>
      <line x1="0" y1="90" x2="90" y2="20" stroke="white" stroke-width="2"/>
      <line x1="40" y1="150" x2="130" y2="60" stroke="white" stroke-width="2.5"/>
    </g>`;
  } else if(type === 'concrete'){
    overlay = `<g clip-path="url(#${clipId})" opacity="0.28" stroke="${dark}" stroke-width="0.6">
      ${Array.from({length:40}).map((_,i)=>`<line x1="${-40+i*8}" y1="0" x2="${-40+i*8+160}" y2="200"/>`).join('')}
    </g>`;
  } else if(type === 'glass'){
    overlay = `<g clip-path="url(#${clipId})">
      <path d="${path}" fill="white" opacity="0.12"/>
      <line x1="10" y1="10" x2="40" y2="-10" stroke="white" stroke-width="4" opacity="0.5"/>
    </g>`;
  } else if(type === 'wood'){
    overlay = `<g clip-path="url(#${clipId})" opacity="0.3" stroke="${dark}" stroke-width="0.7">
      ${Array.from({length:15}).map((_,i)=>`<path d="M -10 ${i*14} Q 60 ${i*14+10} 140 ${i*14}" fill="none"/>`).join('')}
    </g>`;
  } else if(type === 'leather'){
    overlay = `<g clip-path="url(#${clipId})" opacity="0.3" fill="${dark}">
      ${Array.from({length:60}).map(()=>`<circle cx="${Math.random()*130}" cy="${Math.random()*180}" r="0.7"/>`).join('')}
    </g>`;
  } else if(type === 'stone'){
    /* schematic running-bond brick/stone coursing (e.g. "Jerusalem stone" style) -
       a tiled grout-line pattern, not a photographic texture */
    const patId = clipId + '-stone';
    const bw = 13, bh = 6.5;
    overlay = `<defs>
      <pattern id="${patId}" width="${bw}" height="${bh*2}" patternUnits="userSpaceOnUse">
        <line x1="0" y1="0" x2="${bw}" y2="0" stroke="${dark}" stroke-width="0.3"/>
        <line x1="0" y1="${bh}" x2="${bw}" y2="${bh}" stroke="${dark}" stroke-width="0.3"/>
        <line x1="0" y1="0" x2="0" y2="${bh}" stroke="${dark}" stroke-width="0.3"/>
        <line x1="${bw/2}" y1="${bh}" x2="${bw/2}" y2="${bh*2}" stroke="${dark}" stroke-width="0.3"/>
      </pattern>
    </defs>
    <path d="${path}" fill="url(#${patId})" opacity="0.65"/>`;
  } else if(type && type.startsWith('custom:')){
    const mat = customMaterials.find(m => 'custom:'+m.id === type);
    if(mat) overlay = customTextureOverlay(clipId, path, mat, color);
  }
  return overlay;
}

/* generic, parameterized texture engine backing user-added custom materials -
   reuses the same visual primitives as the built-in textures (lines/dots/grid)
   but with density/opacity the designer controls, instead of a bespoke renderer per material */
function customTextureOverlay(clipId, path, mat, color){
  const dark = darken(color, 40);
  if(mat.baseType === 'flat') return '';
  if(mat.baseType === 'lines'){
    const step = Math.max(2, 60 / mat.density);
    let lines = [];
    for(let i=-40; i<200; i+=step) lines.push(`<line x1="${-40+i}" y1="0" x2="${-40+i+160}" y2="200"/>`);
    return `<g clip-path="url(#${clipId})" opacity="${mat.opacity}" stroke="${dark}" stroke-width="0.6">${lines.join('')}</g>`;
  }
  if(mat.baseType === 'dots'){
    const count = Math.round(mat.density * 8);
    return `<g clip-path="url(#${clipId})" opacity="${mat.opacity}" fill="${dark}">${Array.from({length:count}).map(()=>`<circle cx="${Math.random()*130}" cy="${Math.random()*180}" r="0.7"/>`).join('')}</g>`;
  }
  if(mat.baseType === 'grid'){
    const bw = Math.max(4, 60 / mat.density), bh = bw/2;
    const patId = clipId + '-cm' + mat.id;
    return `<defs>
      <pattern id="${patId}" width="${bw}" height="${bh*2}" patternUnits="userSpaceOnUse">
        <line x1="0" y1="0" x2="${bw}" y2="0" stroke="${dark}" stroke-width="0.3"/>
        <line x1="0" y1="${bh}" x2="${bw}" y2="${bh}" stroke="${dark}" stroke-width="0.3"/>
        <line x1="0" y1="0" x2="0" y2="${bh}" stroke="${dark}" stroke-width="0.3"/>
        <line x1="${bw/2}" y1="${bh}" x2="${bw/2}" y2="${bh*2}" stroke="${dark}" stroke-width="0.3"/>
      </pattern>
    </defs>
    <path d="${path}" fill="url(#${patId})" opacity="${mat.opacity}"/>`;
  }
  return '';
}

/* parses an Illustrator-exported SVG (text converted to outlines) so it can be
   embedded inline as a nested <svg>, keeping it real vector paths in the final PDF -
   this is the escape hatch for hand-tuned letterforms instead of the built-in font renderer */
function parseTextVectorSVG(svgText){
  try{
    const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    const svgEl = doc.documentElement;
    if(svgEl.nodeName !== 'svg') return null;
    let viewBox = svgEl.getAttribute('viewBox');
    if(!viewBox){
      const w = parseFloat(svgEl.getAttribute('width')) || 100;
      const h = parseFloat(svgEl.getAttribute('height')) || 100;
      viewBox = `0 0 ${w} ${h}`;
    }
    return { viewBox, inner: svgEl.innerHTML };
  } catch(e){ return null; }
}

/* ===================== view builders ===================== */
/* each view returns an <svg> string, viewBox uses real mm plus margin */

function svgWrap(vbW, vbH, inner){
  return `<svg viewBox="0 0 ${vbW} ${vbH}" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;
}

function frontLikeView({W,H,radius,color,texture,ribZone,showRibs,text,font,fontsize,letterspacing,strokew,dims,curvedLine,label,bgImage,bgOpacity,textOffsetX,textOffsetY,textVectorData,textStyle,textColor,customOutlinePath,outlineId}){
  const margin = 16;
  const vbW = W + margin*2, vbH = H + margin*2;
  const x = margin, y = margin;
  const path = customOutlinePath || roundedRectPath(x,y,W,H,radius);
  const outlineIdAttr = outlineId ? `id="${outlineId}"` : '';
  const cid = 'clip'+(clipCounter++);
  let refUnderlay = '';
  let shapeOpacity = 1;
  if(bgImage){
    shapeOpacity = 0.55;
    refUnderlay = `<image href="${bgImage}" x="${x}" y="${y}" width="${W}" height="${H}"
      preserveAspectRatio="xMidYMid meet" opacity="${bgOpacity}"/>`;
  }
  let ribs = '';
  if(showRibs){
    const zoneL = ribZone, zoneR = W - ribZone;
    const step = 3.2;
    let lines = [];
    for(let lx = 3; lx < zoneL; lx += step) lines.push(`<line x1="${x+lx}" y1="${y+radius}" x2="${x+lx}" y2="${y+H-radius}"/>`);
    for(let lx = zoneR+2; lx < W-1; lx += step) lines.push(`<line x1="${x+lx}" y1="${y+radius}" x2="${x+lx}" y2="${y+H-radius}"/>`);
    ribs = `<g stroke="${darken(color,30)}" stroke-width="0.35" opacity="0.6">${lines.join('')}</g>`;
  }
  let curve = '';
  if(curvedLine){
    curve = `<path d="M ${x+W*0.55} ${y+2} Q ${x+W*0.68} ${y+H*0.5} ${x+W*0.5} ${y+H-2}" fill="none" stroke="${darken(color,15)}" stroke-width="0.3" opacity="0.35"/>`;
  }
  let engraved = '';
  if(text || textVectorData){
    const box_w = text ? Math.min(W*0.78, text.length*fontsize*0.9+10) : W*0.5;
    const box_h = fontsize + 6;
    const offX = textOffsetX ?? 0;
    const bottomMargin = textOffsetY ?? (H*0.14);
    const bx = x + (W-box_w)/2 + offX, by = y + H - box_h - bottomMargin;
    if(textVectorData){
      engraved = `<g>
        <rect x="${bx}" y="${by}" width="${box_w}" height="${box_h}" fill="none" stroke="${darken(color,25)}" stroke-width="0.3" opacity="0.5"/>
        <svg x="${bx}" y="${by}" width="${box_w}" height="${box_h}" viewBox="${textVectorData.viewBox}" preserveAspectRatio="xMidYMid meet">${textVectorData.inner}</svg>
      </g>`;
    } else if(textStyle === 'embossed'){
      const tx = bx+box_w/2, ty = by+box_h/2+fontsize*0.32;
      engraved = `<g>
        <text x="${tx+0.6}" y="${ty+0.6}" text-anchor="middle"
          font-family="${font}" font-size="${fontsize}" font-weight="700" letter-spacing="${letterspacing}"
          fill="${darken(color,55)}" opacity="0.45" direction="rtl">${text}</text>
        <text x="${tx}" y="${ty}" text-anchor="middle"
          font-family="${font}" font-size="${fontsize}" font-weight="700" letter-spacing="${letterspacing}"
          fill="${textColor}" stroke="${darken(textColor,30)}" stroke-width="${strokew*0.5}" direction="rtl">${text}</text>
      </g>`;
    } else {
      engraved = `<g>
        <rect x="${bx}" y="${by}" width="${box_w}" height="${box_h}" fill="none" stroke="${darken(color,25)}" stroke-width="0.3" opacity="0.5"/>
        <text x="${bx+box_w/2}" y="${by+box_h/2+fontsize*0.32}" text-anchor="middle"
          font-family="${font}" font-size="${fontsize}" letter-spacing="${letterspacing}"
          fill="${color}" stroke="${darken(color,35)}" stroke-width="${strokew}" direction="rtl">${text}</text>
      </g>`;
    }
  }
  let dimEls = '';
  if(dims && dims.W !== null && dims.W !== undefined){
    dimEls += dimLine(x, y+H+8, x+W, y+H+8, dims.W, 'h');
  }
  if(dims && dims.H !== null && dims.H !== undefined){
    dimEls += dimLine(x-8, y, x-8, y+H, dims.H, 'v');
  }
  const inner = `
    <defs><clipPath id="${cid}"><path d="${path}"/></clipPath></defs>
    ${refUnderlay}
    <path ${outlineIdAttr} d="${path}" fill="${color}" fill-opacity="${shapeOpacity}" stroke="${darken(color,45)}" stroke-width="0.6"/>
    ${ribs}
    ${curve}
    ${textureOverlay(cid, path, texture, color)}
    ${engraved}
    ${dimEls}
    <text x="${vbW/2}" y="${vbH-3}" text-anchor="middle" class="view-caption">${label||''}</text>
  `;
  return svgWrap(vbW, vbH, inner);
}

function topBottomView({W,D,radius,color,texture,mode,slotW,slotH,cork,slotOffsetX,slotOffsetY,corkOffsetX,corkOffsetY,dims,circleDiameter}){
  const margin = 16;
  if(circleDiameter){ W = circleDiameter; D = circleDiameter; }
  const vbW = W + margin*2, vbH = D + margin*2;
  const x = margin, y = margin;
  const path = circleDiameter
    ? circlePathD(x + W/2, y + D/2, W/2)
    : roundedRectPath(x,y,W,D,radius);
  const cid = 'clip'+(clipCounter++);
  let feature = '';
  if(mode === 'top'){
    const sw = slotW, sh = slotH;
    const offX = slotOffsetX ?? 0;
    const offY = slotOffsetY ?? (D*0.32);
    const sx = x + (W-sw)/2 + offX, sy = y + offY - sh/2;
    feature = `<rect x="${sx}" y="${sy}" width="${sw}" height="${sh}" rx="${sh/2}" fill="${darken(color,50)}" opacity="0.55"/>`;
    if(dims && dims.slotW!==null && dims.slotW!==undefined) feature += dimLine(sx, sy-4, sx+sw, sy-4, dims.slotW, 'h');
    if(dims && dims.slotOffsetY!==null && dims.slotOffsetY!==undefined) feature += dimLine(x-8, y, x-8, y+offY, dims.slotOffsetY, 'v');
    if(dims && dims.slotOffsetX!==null && dims.slotOffsetX!==undefined) feature += dimLine(x+W/2, sy+sh+5, sx+sw/2, sy+sh+5, dims.slotOffsetX, 'h');
  } else if(mode === 'bottom'){
    const r = cork/2;
    const offX = corkOffsetX ?? 0;
    const offY = corkOffsetY ?? 0;
    const cx = x + W/2 + offX, cy = y + D/2 + offY;
    feature = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${darken(color,45)}" stroke-width="0.6"/>`;
    if(dims && dims.cork!==null && dims.cork!==undefined) feature += dimLine(cx-r, cy+r+6, cx+r, cy+r+6, dims.cork, 'h');
    if(dims && dims.corkOffsetX!==null && dims.corkOffsetX!==undefined) feature += dimLine(x+W/2, cy, cx, cy, dims.corkOffsetX, 'h');
    if(dims && dims.corkOffsetY!==null && dims.corkOffsetY!==undefined) feature += dimLine(cx+r+6, y+D/2, cx+r+6, cy, dims.corkOffsetY, 'v');
  }
  let dimEls = '';
  if(dims && dims.W !== null && dims.W !== undefined) dimEls += dimLine(x, y-8, x+W, y-8, dims.W, 'h');
  if(dims && dims.D !== null && dims.D !== undefined) dimEls += dimLine(x-8, y, x-8, y+D, dims.D, 'v');
  const inner = `
    <defs><clipPath id="${cid}"><path d="${path}"/></clipPath></defs>
    <path d="${path}" fill="${color}" stroke="${darken(color,45)}" stroke-width="0.6"/>
    ${textureOverlay(cid, path, 'ribs'==texture?'':texture, color)}
    ${feature}
    ${dimEls}
    <text x="${vbW/2}" y="${vbH-3}" text-anchor="middle" class="view-caption">${mode==='top'?'TOP':'BOTTOM'}</text>
  `;
  return svgWrap(vbW, vbH, inner);
}

function sideView({D,H,radius,color,texture,dims}){
  const margin = 16;
  const vbW = D + margin*2, vbH = H + margin*2;
  const x = margin, y = margin;
  const path = roundedRectPath(x,y,D,H,radius);
  const cid = 'clip'+(clipCounter++);
  const step = 3.2;
  let lines = [];
  for(let lx = 3; lx < D-1; lx += step) lines.push(`<line x1="${x+lx}" y1="${y+radius}" x2="${x+lx}" y2="${y+H-radius}"/>`);
  const ribs = `<g stroke="${darken(color,30)}" stroke-width="0.35" opacity="0.6">${lines.join('')}</g>`;
  let dimEls = '';
  if(dims && dims.D !== null && dims.D !== undefined) dimEls += dimLine(x, y+H+8, x+D, y+H+8, dims.D, 'h');
  const inner = `
    <defs><clipPath id="${cid}"><path d="${path}"/></clipPath></defs>
    <path d="${path}" fill="${color}" stroke="${darken(color,45)}" stroke-width="0.6"/>
    ${ribs}
    ${textureOverlay(cid, path, texture, color)}
    ${dimEls}
    <text x="${vbW/2}" y="${vbH-3}" text-anchor="middle" class="view-caption">SIDE</text>
  `;
  return svgWrap(vbW, vbH, inner);
}

function sectionView({W,H,wall,bottom,color,dims}){
  const margin = 16;
  const vbW = W + margin*2, vbH = H + margin*2;
  const x = margin, y = margin;
  const outerPath = roundedRectPath(x,y,W,H,4);
  const ix = x+wall, iy = y+wall, iw = W-wall*2, ih = H-wall-bottom;
  const innerPath = roundedRectPath(ix,iy,iw,ih,2);
  let dimEls = '';
  if(dims && dims.wall !== null && dims.wall !== undefined){
    dimEls += dimLine(x, y-8, x+wall, y-8, dims.wall, 'h');
  }
  if(dims && dims.bottom !== null && dims.bottom !== undefined){
    dimEls += dimLine(x+W+8, y+H-bottom, x+W+8, y+H, dims.bottom, 'v');
  }
  const inner = `
    <path d="${outerPath}" fill="none" stroke="${darken(color,50)}" stroke-width="0.7"/>
    <path d="${innerPath}" fill="none" stroke="${darken(color,50)}" stroke-width="0.5" stroke-dasharray="1.2,1"/>
    <line x1="${x+2}" y1="${y+H-bottom}" x2="${x+W-2}" y2="${y+H-bottom}" stroke="${darken(color,50)}" stroke-width="0.4" stroke-dasharray="1.2,1"/>
    ${dimEls}
    <text x="${vbW/2}" y="${vbH-3}" text-anchor="middle" class="view-caption">SECTION</text>
  `;
  return svgWrap(vbW, vbH, inner);
}

/* ===================== render ===================== */

function render(){
  clipCounter = 0;
  const s = getState();
  const d = withDefaults(s);
  const ribZone = d.W * 0.24;
  updateAspectSuggestion();
  updateDistanceLockStatus();

  document.querySelector('.sheet-header .code').textContent = s.code || '—';
  document.querySelector('.sheet-header .title').textContent =
    (s.title || '').toUpperCase() + (s.category ? ' — ' + s.category : '');
  document.querySelector('.sheet-header .meta').innerHTML =
    `Material: ${s.material || '—'}<br>Color: ${s.colorname || '—'}`;

  const refBox = document.getElementById('refImgs');
  refBox.innerHTML = '';
  refBox.className = 'ref-imgs' + (refImages.length <= 1 ? ' single' : '');
  if(refImages.length === 0){
    refBox.innerHTML = '<div style="grid-column:1/3;height:48mm;display:flex;align-items:center;justify-content:center;color:#bbb;font-size:8pt;border:1px dashed #ddd;border-radius:4px;">אין תמונת רפרנס</div>';
  } else {
    refImages.slice(0,8).forEach(src=>{
      const img = document.createElement('img'); img.src = src; refBox.appendChild(img);
    });
  }

  const rotationalSymmetry = document.getElementById('f_rotationalSymmetry').checked;
  const sketchPathD = combinedSketchPathD();
  let circleDiameter = null;
  if(sketchPathD && rotationalSymmetry){
    const visibleParts = aiSketchParts.filter(p => p.visible);
    const allPts = visibleParts.flatMap(p => fullPointsForPart(p));
    const xs = allPts.map(p=>p.x);
    circleDiameter = Math.max(...xs) - Math.min(...xs);
  }
  document.getElementById('sketchToolsBox').style.display = aiSketchParts ? 'block' : 'none';
  if(aiSketchParts) renderPartSelector();

  const views = document.getElementById('viewsGrid');
  views.innerHTML = '';
  const specs = [
    {label:'TOP', html: topBottomView({W:d.W,D:d.D,radius:Math.min(d.radius,d.D/2-1),color:s.color,texture:s.texture,mode:'top',slotW:d.slotW,slotH:d.slotH,slotOffsetX:s.slotOffsetX,slotOffsetY:s.slotOffsetY,circleDiameter,dims:circleDiameter?{}:{W:s.W,D:s.D,slotW:s.slotW,slotOffsetX:s.slotOffsetX,slotOffsetY:s.slotOffsetY}})},
    {label:'BOTTOM', html: topBottomView({W:d.W,D:d.D,radius:Math.min(d.radius,d.D/2-1),color:s.color,texture:s.texture,mode:'bottom',cork:d.cork,corkOffsetX:s.corkOffsetX,corkOffsetY:s.corkOffsetY,circleDiameter,dims:{W:null,D:null,cork:s.cork,corkOffsetX:s.corkOffsetX,corkOffsetY:s.corkOffsetY}})},
    {label:'FRONT', html: frontLikeView({W:d.W,H:d.H,radius:d.radius,color:s.color,texture:s.texture,ribZone,showRibs:!aiSketchParts,curvedLine:!aiSketchParts,text:s.text,font:s.font,fontsize:s.fontsize,letterspacing:s.letterspacing,strokew:s.strokew,dims:aiSketchParts?{}:{W:s.W,H:s.H},label:'',
      bgImage: (s.showRefBg && refImages[0]) ? refImages[0] : null, bgOpacity: s.refOpacity,
      textOffsetX:s.textOffsetX, textOffsetY:s.textOffsetY, textVectorData:textVector,
      textStyle:s.textStyle, textColor:s.textColor,
      customOutlinePath: sketchPathD,
      outlineId: aiSketchParts ? 'frontOutlinePath' : null})},
    {label:'BACK', html: frontLikeView({W:d.W,H:d.H,radius:d.radius,color:s.color,texture:s.texture,ribZone,showRibs:!aiSketchParts,curvedLine:false,text:'',font:s.font,fontsize:s.fontsize,letterspacing:s.letterspacing,strokew:s.strokew,dims:{},customOutlinePath:sketchPathD,label:''})},
    {label:'SIDE', html: (rotationalSymmetry && sketchPathD)
      ? frontLikeView({W:d.W,H:d.H,radius:d.radius,color:s.color,texture:s.texture,ribZone,showRibs:false,curvedLine:false,text:'',font:s.font,fontsize:s.fontsize,letterspacing:s.letterspacing,strokew:s.strokew,dims:{},customOutlinePath:sketchPathD,label:''})
      : sideView({D:d.D,H:d.H,radius:d.radius,color:s.color,texture:s.texture,dims:{D:s.D}})},
    {label:'SECTION', html: sectionView({W:d.W,H:d.H,wall:d.wall,bottom:d.bottom,color:s.color,dims:{wall:s.wall,bottom:s.bottom}})}
  ];
  specs.forEach(v=>{
    const box = document.createElement('div');
    box.className = 'view-box';
    box.innerHTML = `<div class="label">${v.label}</div>${v.html}`;
    views.appendChild(box);
  });
  if(aiSketchParts) attachSketchHandles();

  const notesList = document.getElementById('notesList');
  const lines = s.notes.split('\n').map(l=>l.trim()).filter(Boolean);
  notesList.innerHTML = lines.map(l=>`<li>${l}</li>`).join('');

  document.getElementById('footerRev').textContent =
    `REV. ${s.rev || '01'} | ${s.date ? new Date(s.date).toLocaleDateString('en-GB').replace(/\//g,' ').toUpperCase() : ''}`;
}

/* ===================== wiring ===================== */

function buildSkeleton(){
  document.getElementById('specSheet').innerHTML = `
    <div class="sheet-header">
      <div>
        <div class="code"></div>
        <div class="title"></div>
      </div>
      <div class="meta"></div>
    </div>
    <div class="sheet-body">
      <div class="views-grid" id="viewsGrid"></div>
      <div class="side-col">
        <div class="ref-box">
          <div class="label">Reference appearance</div>
          <div class="ref-imgs" id="refImgs"></div>
        </div>
        <div class="notes-box">
          <div class="label">MANUFACTURING NOTES</div>
          <ol id="notesList"></ol>
        </div>
      </div>
    </div>
    <div class="sheet-footer">
      <span>CONCEPT TECHNICAL SPECIFICATION - supplier must confirm production engineering, tolerances and tooling feasibility before mold release.</span>
      <span id="footerRev"></span>
    </div>
  `;
}

document.addEventListener('DOMContentLoaded', ()=>{
  buildSkeleton();
  document.getElementById('f_date').valueAsDate = new Date();

  document.querySelectorAll('.panel input, .panel select, .panel textarea')
    .forEach(el => el.addEventListener('input', render));

  function renderCustomMaterialsList(){
    const list = document.getElementById('customMaterialsList');
    list.innerHTML = customMaterials.map(m => `
      <span class="chip">${m.name}<button type="button" data-remove="${m.id}">✕</button></span>
    `).join('');
    list.querySelectorAll('button[data-remove]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const id = btn.getAttribute('data-remove');
        const select = document.getElementById('f_texture');
        const opt = select.querySelector(`option[value="custom:${id}"]`);
        const wasSelected = opt && opt.selected;
        if(opt) opt.remove();
        customMaterials = customMaterials.filter(m => m.id !== id);
        renderCustomMaterialsList();
        if(wasSelected){ select.value = 'none'; render(); }
      });
    });
  }

  document.getElementById('btnAddMaterial').addEventListener('click', ()=>{
    const name = document.getElementById('cm_name').value.trim();
    if(!name){ document.getElementById('cm_name').focus(); return; }
    const id = 'm' + Date.now();
    const mat = {
      id, name,
      baseType: document.getElementById('cm_baseType').value,
      density: parseFloat(document.getElementById('cm_density').value) || 8,
      opacity: parseFloat(document.getElementById('cm_opacity').value) || 0.3
    };
    customMaterials.push(mat);
    const opt = document.createElement('option');
    opt.value = 'custom:' + id;
    opt.textContent = name + ' (מותאם)';
    document.getElementById('f_texture').appendChild(opt);
    renderCustomMaterialsList();
    document.getElementById('cm_name').value = '';
  });

  document.getElementById('btnApplyAi').addEventListener('click', ()=>{
    const raw = document.getElementById('f_aiJson').value.trim();
    const status = document.getElementById('aiApplyStatus');
    if(!raw){ status.textContent = 'לא הודבק כלום.'; return; }
    let data;
    try { data = JSON.parse(raw); }
    catch(e){ status.textContent = 'JSON לא תקין - ודאי שהעתקת את כל הבלוק כולל הסוגריים המסולסלים.'; return; }
    applyAiData(data, status);
  });

  document.getElementById('f_images').addEventListener('change', (e)=>{
    const files = Array.from(e.target.files).slice(0,8);
    const results = new Array(files.length);
    let loaded = 0;
    if(files.length === 0){ refImages = []; primaryImageAspect = null; bboxDetectionFailed = false; render(); return; }
    files.forEach((f, idx)=>{
      const reader = new FileReader();
      reader.onload = ev => {
        results[idx] = ev.target.result;
        loaded++;
        if(loaded === files.length){
          refImages = results;
          const preview = document.getElementById('imgPreviewList');
          preview.innerHTML = '';
          refImages.forEach(src=>{ const img=document.createElement('img'); img.src=src; preview.appendChild(img); });
          analyzeImageBBox(refImages[0]).then(bbox=>{
            primaryImageAspect = bbox ? bbox.aspect : null;
            bboxDetectionFailed = !bbox;
            render();
          });
          autoAnalyze();
        }
      };
      reader.readAsDataURL(f);
    });
  });

  document.getElementById('f_textVector').addEventListener('change', (e)=>{
    const file = e.target.files[0];
    const status = document.getElementById('textVectorStatus');
    const clearBtn = document.getElementById('btnClearTextVector');
    if(!file){ return; }
    const reader = new FileReader();
    reader.onload = ev => {
      const parsed = parseTextVectorSVG(ev.target.result);
      if(!parsed){
        status.textContent = 'לא הצלחתי לקרוא את הקובץ כ-SVG תקין.';
        textVector = null;
      } else {
        textVector = parsed;
        status.textContent = `נטען: ${file.name} - הטקסט המוקלד/הפונט מנוטרלים כל עוד הוקטור טעון`;
        clearBtn.style.display = 'block';
      }
      render();
    };
    reader.readAsText(file);
  });

  document.getElementById('btnClearTextVector').addEventListener('click', ()=>{
    textVector = null;
    document.getElementById('f_textVector').value = '';
    document.getElementById('textVectorStatus').textContent = '';
    document.getElementById('btnClearTextVector').style.display = 'none';
    render();
  });

  document.getElementById('btnGenSketch').addEventListener('click', generateAiSketch);

  document.getElementById('btnResetSketch').addEventListener('click', ()=>{
    aiSketchParts = null;
    activePartId = null;
    distanceLockModeOn = false; selectedPointRefs = [];
    document.getElementById('sketchStatus').textContent = '';
    document.getElementById('distanceLockStatus').textContent = '';
    document.getElementById('f_rotationalSymmetry').checked = false;
    render();
  });

  document.getElementById('btnMakeSymmetric').addEventListener('click', ()=>{
    const part = getActivePart();
    if(!part) return;
    convertPartToSymmetric(part);
    document.getElementById('sketchStatus').textContent = `החלק "${part.name}" הפך לסימטרי - גררי רק את הנקודות בצד ימין שלו, השמאל יתעדכן אוטומטית.`;
    render();
  });

  document.getElementById('btnDistanceLockMode').addEventListener('click', ()=>{
    distanceLockModeOn = !distanceLockModeOn;
    selectedPointRefs = [];
    document.getElementById('btnDistanceLockMode').textContent = distanceLockModeOn
      ? 'בטל מצב נעילת מרחק'
      : 'מצב נעילת מרחק מדויק בין שתי נקודות (באותו חלק)';
    updateDistanceLockStatus();
    render();
  });

  document.getElementById('btnExport').addEventListener('click', ()=> window.print());

  render();
});
