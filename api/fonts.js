// Vercel serverless function: shared font library, stored in Vercel Blob so every
// designer on every device sees the same fonts (replaces the old per-browser localStorage
// version). No database needed - the display name is encoded into the blob's pathname,
// so a plain list() call is enough to reconstruct the font list.
//
// The blob store on this account is private-access only, so uploads use access:'private'
// and reads happen server-side (with the Bearer token) instead of handing the browser a
// public blob URL - the browser gets the font back as a data URL, exactly like the old
// localStorage version did, so @font-face keeps working unchanged.
//
// GET  -> { fonts: [{ id, name, dataUrl }, ...] }
// POST { name, dataUrl } -> { id, name, dataUrl }   (dataUrl = base64 font file, e.g. from FileReader)

const { put, list } = require('@vercel/blob');

async function fetchBlobAsDataUrl(url, contentType){
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) throw new Error('Failed to read stored font (' + resp.status + ')');
  const buffer = Buffer.from(await resp.arrayBuffer());
  const type = contentType || resp.headers.get('content-type') || 'application/octet-stream';
  return `data:${type};base64,${buffer.toString('base64')}`;
}

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      const { blobs } = await list({ prefix: 'fonts/' });
      const fonts = await Promise.all(blobs.map(async b => {
        const filename = b.pathname.split('/').pop();
        const sepIndex = filename.indexOf('__');
        const rawName = sepIndex >= 0 ? filename.slice(sepIndex + 2) : filename;
        const name = decodeURIComponent(rawName.replace(/\.[^.]+$/, ''));
        const dataUrl = await fetchBlobAsDataUrl(b.url, b.contentType);
        return { id: b.pathname, name, dataUrl };
      }));
      fonts.sort((a, b) => a.name.localeCompare(b.name));
      res.status(200).json({ fonts });
      return;
    }

    if (req.method === 'POST') {
      const { name, dataUrl } = req.body || {};
      if (!name || !dataUrl) { res.status(400).json({ error: 'Missing name or dataUrl' }); return; }
      const match = typeof dataUrl === 'string' && dataUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (!match) { res.status(400).json({ error: 'Invalid font data URL' }); return; }
      const mimeType = match[1];
      const buffer = Buffer.from(match[2], 'base64');
      const extMatch = name.match(/\.([a-zA-Z0-9]+)$/);
      const ext = extMatch ? extMatch[1] : 'ttf';
      const baseName = name.replace(/\.[^.]+$/, '');
      const safeName = encodeURIComponent(baseName);
      const pathname = `fonts/${Date.now()}__${safeName}.${ext}`;
      const blob = await put(pathname, buffer, { access: 'private', contentType: mimeType });
      res.status(200).json({ id: blob.pathname, name: baseName, dataUrl });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

module.exports.config = { maxDuration: 30 };
