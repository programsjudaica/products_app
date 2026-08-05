// Vercel serverless function: shared, cross-device saved projects, stored in Vercel Blob.
// A project is only saved when the designer explicitly confirms it in the export dialog -
// there is no auto-save. Each project is one JSON blob holding the full app state
// (form fields, reference images, generated AI views, dimension lines, font/text choice).
//
// GET  -> { projects: [{ id, code, title, url, uploadedAt }, ...] }   (list only, no full data)
// POST { code, title, data } -> { id, url }   (data = full state object, saved as-is)

const { put, list } = require('@vercel/blob');

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      const { blobs } = await list({ prefix: 'projects/' });
      const projects = blobs.map(b => {
        const filename = b.pathname.split('/').pop();
        const sepIndex = filename.indexOf('__');
        const rawLabel = sepIndex >= 0 ? filename.slice(sepIndex + 2) : filename;
        const label = decodeURIComponent(rawLabel.replace(/\.json$/, ''));
        const [code, ...titleParts] = label.split('__');
        return {
          id: b.pathname,
          code: code || label,
          title: titleParts.join('__') || '',
          url: b.url,
          uploadedAt: b.uploadedAt
        };
      });
      projects.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
      res.status(200).json({ projects });
      return;
    }

    if (req.method === 'POST') {
      const { code, title, data } = req.body || {};
      if (!data) { res.status(400).json({ error: 'Missing data' }); return; }
      const safeCode = encodeURIComponent(code || 'untitled');
      const safeTitle = encodeURIComponent(title || '');
      const pathname = `projects/${Date.now()}__${safeCode}__${safeTitle}.json`;
      const blob = await put(pathname, JSON.stringify(data), { access: 'public', contentType: 'application/json' });
      res.status(200).json({ id: blob.pathname, url: blob.url });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

module.exports.config = { maxDuration: 20 };
