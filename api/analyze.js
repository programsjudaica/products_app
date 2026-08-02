// Vercel serverless function: POST { images: [dataURL, ...] } -> structured product analysis JSON.
// Requires the ANTHROPIC_API_KEY environment variable to be set in the Vercel project
// (Project Settings -> Environment Variables) - never commit the key itself.

const SYSTEM_PROMPT = `You analyze product photos of Judaica items (charity boxes, candlesticks, mezuzahs, etc.) for a factory spec-sheet tool. You will be shown one or more photos of the same physical product from different angles.

Respond with ONLY a single JSON object, no markdown fences, no extra commentary, matching exactly this shape:

{
  "material": "short free-text guess, e.g. 'Polyresin, matte stone finish'",
  "color_hex": "6 hex digits, no # prefix, best estimate of the dominant body color",
  "color_name": "short human-readable color description in words, e.g. 'black with silver accents' or 'warm ivory / stone tone' - must match color_hex, not a leftover from a different product",
  "shape_family": "short free-text description of the overall form, e.g. 'rounded rectangular box'",
  "texture_type": "must be exactly one of: ribs | stone | crystal | concrete | glass | wood | leather | none",
  "top_opening": { "present": true or false, "offsetX_hint": number or null },
  "bottom_opening": { "present": true or false },
  "text_position": { "offsetX_hint": number or null, "offsetY_hint": number or null },
  "text_style": "must be exactly one of: engraved | embossed",
  "detected_text": "transcribe any text/lettering/inscription visible on the product exactly as written, in its original language and script (e.g. Hebrew) - null or empty string if no text is visible. This is read directly from the photo for reference only, not a substitute for the designer's own precise text/font entry.",
  "notes": "any other detail relevant to a manufacturing spec sheet, in one or two sentences"
}

offsetX_hint / offsetY_hint are rough millimeter-scale hints relative to a plausible default size for this
kind of object (0 = centered). If you cannot judge a position confidently, use null rather than guessing.
These are always starting suggestions for a human designer to verify against the real physical dimensions -
never claim precision you don't have.`;

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
        model: 'claude-opus-4-8',
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: [...imageBlocks, { type: 'text', text: 'Analyze this product and return the JSON object described in the system prompt.' }]
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

    res.status(200).json(parsed);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

module.exports.config = { maxDuration: 30 };
