/*********************************************************************
 * MCP Tool-Hub Worker
 * ---------------------------------------------------------------
 * Exposes a single MCP SSE endpoint (/sse) that aggregates multiple
 * downstream tools (text-to-speech, image generation, translation).
 *
 * Shared-secret auth:
 *   - pass  ?token=YOUR_HUB_TOKEN   query param
 *     OR    X-Api-Token: YOUR_HUB_TOKEN   header
 *
 * Environment bindings (add via CF Dashboard → Settings → Variables):
 *
 *   HUB_TOKEN         (secret)  – gateway secret
 *
 *   TTS_ENDPOINT      (string)  – URL of your ElevenLabs Worker, ending with '/'
 *   TTS_TOKEN         (secret)  – its shared secret
 *
 *   IMAGE_ENDPOINT    (string)  – Stable Diffusion / DALL-E / custom URL
 *   IMAGE_KEY         (secret)  – API key / bearer token for image service
 *
 *   TRANSLATE_ENDPOINT (string) – URL of translator Worker / API
 *
 *********************************************************************/

import { McpServer } from "@cloudflare/agents-sdk/server/mcp";
import { z } from "zod";

/* ---------- helpers ------------------------------------------------ */
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Api-Token",
  "Access-Control-Max-Age": "86400"
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS }
  });
}

/* ---------- build the MCP server (cached per isolate) -------------- */
function buildServer(env: Env) {
  const mcp = new McpServer({ name: "ToolHub", version: "1.0.0" });

  /* --- Tool 1 : ElevenLabs text-to-speech -------------------------- */
  mcp.tool(
    "generate_audio",
    z.object({
      text:    z.string().min(1).max(5_000),
      voiceId: z.string(),
      modelId: z.string().default("eleven_turbo_v2")
    }),
    async ({ text, voiceId, modelId }) => {
      const res = await fetch(`${env.TTS_ENDPOINT}?token=${env.TTS_TOKEN}`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, voiceId, modelId })
      });
      if (!res.ok) throw new Error(await res.text());
      const { audioUrl } = await res.json<{
        audioUrl: string;
      }>();
      return {
        content: [
          { type: "text",  text: "Audio created successfully." },
          { type: "audio", url: audioUrl, mime_type: "audio/mpeg" }
        ]
      };
    }
  );

  /* --- Tool 2 : Image generation ---------------------------------- */
  mcp.tool(
    "generate_image",
    z.object({
      prompt: z.string().min(1).max(800),
      steps:  z.number().int().min(1).max(100).default(30)
    }),
    async ({ prompt, steps }) => {
      const res = await fetch(env.IMAGE_ENDPOINT, {
        method:  "POST",
        headers: {
          "Authorization": `Bearer ${env.IMAGE_KEY}`,
          "Content-Type":  "application/json"
        },
        body: JSON.stringify({ prompt, steps })
      });
      if (!res.ok) throw new Error(await res.text());
      const { url } = await res.json<{ url: string }>();
      return { content: [{ type: "image", url }] };
    }
  );

  /* --- Tool 3 : Translate text ------------------------------------ */
  mcp.tool(
    "translate_text",
    z.object({
      text:       z.string().min(1).max(10_000),
      targetLang: z.string().length(2)
    }),
    async ({ text, targetLang }) => {
      const res = await fetch(`${env.TRANSLATE_ENDPOINT}?lang=${targetLang}`, {
        method: "POST",
        body:   text
      });
      if (!res.ok) throw new Error(await res.text());
      return { content: [{ type: "text", text: await res.text() }] };
    }
  );

  return mcp;
}

/* ---------- Worker entry ------------------------------------------ */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    /* CORS pre-flight */
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: CORS_HEADERS });

    /* shared-secret gate */
    const url   = new URL(request.url);
    const token = url.searchParams.get("token") ?? request.headers.get("X-Api-Token");
    if (!token || token !== env.HUB_TOKEN)
      return json({ success: false, error: "Unauthorized" }, 401);

    /* build (or reuse) MCP server */
    env.__SERVER ??= buildServer(env);

    /* all paths (/, /sse, etc.) delegated to MCP server */
    return env.__SERVER.handle(request, env, ctx);
  }
};

/* ---------- Environment interface --------------------------------- */
interface Env {
  HUB_TOKEN: string;

  TTS_ENDPOINT: string;
  TTS_TOKEN:    string;

  IMAGE_ENDPOINT: string;
  IMAGE_KEY:      string;

  TRANSLATE_ENDPOINT: string;

  /* cache handle */
  __SERVER?: ReturnType<typeof buildServer>;
}
