// Vercel serverless function: POST { images: [dataURL, ...] } -> a normalized (0-100 x 0-100)
// multi-part straight-line silhouette trace, for the app to scale into real mm using the
// designer-entered height/width. Never asked to guess real dimensions - only proportional
// shape. The designer edits the resulting points afterward (draggable in the UI).
//
// Split into parts (not one blob) because many products are physically multiple pieces -
// a kiddush cup with its own matching saucer, a besamim tower with a separate lid, a knife
// with a stand - and forcing that into a single closed polygon produces a shape that
// resembles neither piece.

const SYSTEM_PROMPT = `You look at product photos and trace the visible front-facing silhouette(s) as one or more simple polygons - one polygon per physically distinct piece.

Respond with ONLY a JSON object, no markdown fences, no extra text:

{
  "parts": [
    {
      "name": "short label for this piece, e.g. 'cup', 'saucer', 'lid', 'stand'",
      "path": "SVG path 'd' string using ONLY M, L and Z commands (straight line segments, no curves). All parts share ONE common normalized 0-100 x 0-100 coordinate box representing the combined product's overall front-facing bounding box exactly as photographed, so parts stay correctly positioned relative to each other (e.g. a saucer stays under its cup). Trace the outer silhouette of just this one piece. 4 to 16 points is usually enough. Close with Z.",
      "primary": true or false
    }
  ],
  "rotationally_symmetric": true or false,
  "confidence": "high" | "medium" | "low",
  "questions": ["short clarifying questions about anything structurally ambiguous or ambiguous about which parts should be included - empty array if none"],
  "notes": "one sentence on what angle/photo you traced from and any uncertainty"
}

Rules:
- If the product is one single piece, return exactly one entry in "parts".
- If it's multiple distinct physical pieces (e.g. a goblet + its separate saucer), return one part per piece, each with its own name. Mark the main/central piece "primary": true and accessories "primary": false.
- "rotationally_symmetric" means: is this an object of revolution around a vertical axis (a turned/round form like a goblet, candlestick, spice tower, round dish) where the front, back and side views would all look the same, and the top/bottom views would be circles? Set it true only when you're confident the object is round like that - false for anything box-like or otherwise not round from every horizontal angle.
- Only trace what is actually visible. If the photos don't show the product's own front face clearly, say so in notes and lower confidence rather than inventing a silhouette.
- Never output curves (C/Q/A/S commands) - approximate any curved edges with several short straight segments instead.`;

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
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: [...imageBlocks, { type: 'text', text: 'Trace the front-facing silhouette(s), one polygon per physical piece, and return the JSON object described in the system prompt.' }]
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
      const hint = data.stop_reason === 'max_tokens' ? ' (response was cut off - try fewer/simpler reference photos)' : '';
      res.status(502).json({ error: 'Model did not return valid JSON' + hint, raw: text });
      return;
    }

    let parsed;
    try { parsed = JSON.parse(jsonMatch[0]); }
    catch (e) {
      const hint = data.stop_reason === 'max_tokens' ? ' (response was cut off - try fewer/simpler reference photos)' : '';
      res.status(502).json({ error: 'Could not parse model JSON' + hint, raw: text });
      return;
    }

    if (!Array.isArray(parsed.parts) || parsed.parts.length === 0) {
      res.status(502).json({ error: 'Model returned no parts', raw: parsed });
      return;
    }
    const validParts = parsed.parts.filter(p => p && typeof p.path === 'string' && /^[ML][\s\S]*Z$/i.test(p.path.trim()));
    if (validParts.length === 0) {
      res.status(502).json({ error: 'Model returned no usable paths', raw: parsed });
      return;
    }
    parsed.parts = validParts;

    res.status(200).json(parsed);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

// a multi-part vision response can take a while to generate - default Vercel function
// timeouts (especially on the Hobby plan) can be shorter than that, so extend it explicitly
module.exports.config = { maxDuration: 60 };
