// Vercel serverless function: POST { images: [dataURL, ...] } -> a normalized (0-100 x 0-100)
// straight-line silhouette trace of the product's front-facing view, for the app to scale
// into real mm using the designer-entered height/width. Never asked to guess real dimensions -
// only proportional shape. The designer edits the resulting points afterward (draggable in the UI).

const SYSTEM_PROMPT = `You look at product photos and trace the visible front-facing silhouette as a simple polygon.

Respond with ONLY a JSON object, no markdown fences, no extra text:

{
  "front_path": "SVG path 'd' string using ONLY M, L and Z commands (straight line segments, no curves), in a normalized 0-100 x 0-100 coordinate box where (0,0) is top-left and (100,100) is bottom-right of the product's front-facing bounding box. Trace the outer silhouette only - 6 to 16 points is usually enough. Close the path with Z.",
  "confidence": "high" | "medium" | "low",
  "questions": ["short clarifying questions about anything structurally ambiguous that isn't visible in the photos - empty array if none"],
  "notes": "one sentence on what angle/photo you traced from and any uncertainty"
}

Only trace what is actually visible. If the photos don't show the product's own front face clearly (e.g. only a lifestyle/angled shot), say so in notes and lower confidence rather than inventing a silhouette. Never output curves (C/Q/A/S commands) - approximate any curved edges with several short straight segments instead.`;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Server missing ANTHROPIC_API_KEY' });
    return;
  }

  const { images } = req.body || {};
  if (!Array.isArray(images) || images.length === 0) {
    res.status(400).json({ error: 'No images provided' });
    return;
  }

  const imageBlocks = [];
  for (const dataUrl of images.slice(0, 8)) {
    const match = typeof dataUrl === 'string' && dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!match) continue;
    imageBlocks.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } });
  }
  if (imageBlocks.length === 0) {
    res.status(400).json({ error: 'No valid image data URLs provided' });
    return;
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: [...imageBlocks, { type: 'text', text: 'Trace the front-facing silhouette and return the JSON object described in the system prompt.' }]
        }]
      })
    });

    const data = await response.json();
    if (!response.ok) {
      res.status(502).json({ error: (data.error && data.error.message) || 'Vision API error' });
      return;
    }

    const text = (data.content && data.content[0] && data.content[0].text) || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      res.status(502).json({ error: 'Model did not return valid JSON', raw: text });
      return;
    }

    let parsed;
    try { parsed = JSON.parse(jsonMatch[0]); }
    catch (e) { res.status(502).json({ error: 'Could not parse model JSON', raw: text }); return; }

    if (!parsed.front_path || !/^[ML][\s\S]*Z$/i.test(parsed.front_path.trim())) {
      res.status(502).json({ error: 'Model returned an unusable path', raw: parsed });
      return;
    }

    res.status(200).json(parsed);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
