// Vercel serverless function: POST { image: dataURL, prompt: string } -> { image: dataURL }
// Uses OpenAI's image model (gpt-image-1) to generate a single 2x3 grid image (6 views)
// from one reference photo. Requires OPENAI_API_KEY in Vercel env vars (separate from
// ANTHROPIC_API_KEY - OpenAI is the one used for image generation, Anthropic doesn't
// generate images).
//
// This is the "simple" version's only AI call: the image is illustrative, not a source of
// real dimensions - those always come from what the designer types and draws by hand on top.

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Server missing OPENAI_API_KEY' });
    return;
  }

  const { image, prompt } = req.body || {};
  if (!image || !prompt) {
    res.status(400).json({ error: 'Missing image or prompt' });
    return;
  }

  const match = image.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) {
    res.status(400).json({ error: 'Invalid image data URL' });
    return;
  }
  const mimeType = match[1];
  const ext = (mimeType.split('/')[1] || 'png').replace('jpeg', 'jpg');
  const buffer = Buffer.from(match[2], 'base64');

  const boundary = '----WebAppFormBoundary' + Math.random().toString(16).slice(2);
  const preamble =
    `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\ngpt-image-1\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\n${prompt}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="size"\r\n\r\n1536x1024\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="reference.${ext}"\r\nContent-Type: ${mimeType}\r\n\r\n`;
  const body = Buffer.concat([
    Buffer.from(preamble, 'utf8'),
    buffer,
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
  ]);

  try {
    const response = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`
      },
      body
    });

    const data = await response.json();
    if (!response.ok) {
      res.status(502).json({ error: (data.error && data.error.message) || 'Image generation API error' });
      return;
    }

    const item = data.data && data.data[0];
    if (!item) { res.status(502).json({ error: 'No image returned' }); return; }

    const outDataUrl = item.b64_json ? `data:image/png;base64,${item.b64_json}` : item.url;
    if (!outDataUrl) { res.status(502).json({ error: 'Unrecognized image response format' }); return; }

    res.status(200).json({ image: outDataUrl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

module.exports.config = { maxDuration: 60 };
