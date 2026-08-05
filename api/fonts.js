// Vercel serverless function: shared font library, stored in Vercel Blob so every
// designer on every device sees the same fonts (replaces the old per-browser localStorage
// version). No database needed - the display name is encoded into the blob's pathname,
// so a plain list() call is enough to reconstruct the font list.
//
// GET  -> { fonts: [{ id, name, url }, ...] }
// POST { name, dataUrl } -> { id, name, url }   (dataUrl = base64 font file, e.g. from FileReader)

const { put, list } = require('@vercel/blob');

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      const { blobs } = await list({ prefix: 'fonts/' });
      const fonts = blobs.map(b => {
        const filename = b.pathname.split('/').pop();
        const sepIndex = filename.indexOf('__');
        const rawName = sepIndex >= 0 ? filename.slice(sepIndex + 2) : filename;
        const name = decodeURIComponent(rawName.replace(/\.[^.]+$/, ''));
        return { id: b.pathname, name, url: b.url };
      });
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
      const blob = await put(pathname, buffer, { access: 'public', contentType: mimeType });
      res.status(200).json({ id: blob.pathname, name: baseName, url: blob.url });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

module.exports.config = { maxDuration: 20 };
