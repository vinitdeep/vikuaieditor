// Free image generation API on Cloudflare Workers AI.
// Based on github.com/saurav-z/free-image-generation-api (MIT), extended:
// model choice, size/steps/seed/negative prompt, Flux base64 output, model list.

const MODELS = {
  "flux": "@cf/black-forest-labs/flux-1-schnell",          // best quality/speed, max 8 steps
  "sdxl": "@cf/stabilityai/stable-diffusion-xl-base-1.0",   // max 20 steps
  "sdxl-lightning": "@cf/bytedance/stable-diffusion-xl-lightning",
  "dreamshaper": "@cf/lykon/dreamshaper-8-lcm",
};
const DEFAULT_MODEL = "flux";
// text models for /text (multilingual: Odia / Hindi lines -> English picture descriptions)
const TEXT_MODELS = {
  "gemma": "@cf/google/gemma-3-12b-it",
  "llama": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "llama-small": "@cf/meta/llama-3.1-8b-instruct",
};
const DEFAULT_TEXT = "llama";
const PASSTHROUGH = ["negative_prompt", "width", "height", "num_steps", "steps", "guidance", "seed", "strength"];

export default {
  async fetch(request, env) {
    if (request.headers.get("Authorization") !== `Bearer ${env.API_KEY}`) {
      return json({ error: "Unauthorized" }, 401);
    }
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/models") {
      return json({ default: DEFAULT_MODEL, models: MODELS });
    }
    // POST /text {messages: [{role, content}], model?, max_tokens?} -> {response, model}
    // Used by Viku to turn a sermon line (Odia / Hindi / English) into an English picture description.
    if (request.method === "POST" && url.pathname === "/text") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "Body must be JSON" }, 400); }
      const tmodel = TEXT_MODELS[body.model || DEFAULT_TEXT] || null;
      if (!tmodel) return json({ error: `Unknown text model '${body.model}'`, models: Object.keys(TEXT_MODELS) }, 400);
      if (!Array.isArray(body.messages) || !body.messages.length) return json({ error: "messages are required" }, 400);
      try {
        const out = await env.AI.run(tmodel, { messages: body.messages, max_tokens: Math.min(body.max_tokens || 400, 1200) });
        const text = typeof out?.response === "string" ? out.response : (out?.choices?.[0]?.message?.content ?? "");
        return json({ response: text, model: tmodel });
      } catch (err) {
        return json({ error: "Text model failed", model: tmodel, details: err.message }, 500);
      }
    }
    if (request.method !== "POST" || url.pathname !== "/") {
      return json({ error: "Not allowed" }, 405);
    }

    let body;
    try { body = await request.json(); } catch { return json({ error: "Body must be JSON" }, 400); }
    const { prompt, model = DEFAULT_MODEL } = body;
    if (!prompt) return json({ error: "Prompt is required" }, 400);

    const modelId = MODELS[model] || (String(model).startsWith("@cf/") ? model : null);
    if (!modelId) return json({ error: `Unknown model '${model}'`, models: Object.keys(MODELS) }, 400);

    const input = { prompt };
    for (const k of PASSTHROUGH) if (body[k] !== undefined) input[k] = body[k];
    // Flux uses `steps` (max 8) and ignores size/negative/guidance; SD models use `num_steps`.
    if (modelId.includes("flux")) {
      if (input.num_steps && !input.steps) input.steps = input.num_steps;
      for (const k of ["num_steps", "width", "height", "negative_prompt", "guidance", "strength"]) delete input[k];
    } else if (input.steps && !input.num_steps) {
      input.num_steps = input.steps;
      delete input.steps;
    }

    try {
      const result = await env.AI.run(modelId, input);
      let bytes;
      if (result && typeof result === "object" && typeof result.image === "string") {
        bytes = Uint8Array.from(atob(result.image), c => c.charCodeAt(0));
      } else {
        bytes = new Uint8Array(await new Response(result).arrayBuffer());
      }
      const type = bytes[0] === 0x89 && bytes[1] === 0x50 ? "image/png" : "image/jpeg";
      return new Response(bytes, { headers: { "Content-Type": type, "X-Model": modelId } });
    } catch (err) {
      return json({ error: "Failed to generate image", model: modelId, details: err.message }, 500);
    }
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { "Content-Type": "application/json" } });
}
