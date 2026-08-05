// Vercel serverless function: shared, cross-device saved projects, stored in Vercel Blob.
// A project is only saved when the designer explicitly confirms it in the export dialog -
// there is no auto-save. Each project is one JSON blob holding the full app state
// (form fields, reference images, generated AI views, dimension lines, font/text choice).
//
// The blob store on this account is private-access only, so uploads use access:'private'
// and reads happen server-side (with the Bearer token) - the browser never talks to the
// blob store directly, only to this endpoint.
//
// GET              -> { projects: [{ id, code, title, uploadedAt }, ...] }   (list only, no full data)
// GET ?id=<blobId>  -> { data }   (full saved state for one project)
// POST { code, title, data } -> { id }   (data = full state object, saved as-is)

const { put, list } = require('@vercel/blob');

async function fetchBlobJson(url){
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) throw new Error('Failed to read stored project (' + resp.status + ')');
  return resp.json();
}

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      const id = req.query && req.query.id;

      if (id) {
        const { blobs } = await list({ prefix: id });
        const match = blobs.find(b => b.pathname === id);
        if (!match) { res.status(404).json({ error: 'Project not found' }); return; }
        const data = await fetchBlobJson(match.url);
        res.status(200).json({ data });
        return;
      }

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
      const blob = await put(pathname, JSON.stringify(data), { access: 'private', contentType: 'application/json' });
      res.status(200).json({ id: blob.pathname });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

module.exports.config = { maxDuration: 30 };
