import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { normalizeAspectRatio } from "./aspect";
import {
  DEFAULT_IMAGINE_DEPENDENCIES,
  generateAndSaveImage,
  type ImagineDependencies,
} from "./workflow";

type ImageGenDetails = {
  path?: string;
  relativePath?: string;
  filename?: string;
  error?: string;
};

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text" as const, text: `Image Gen error: ${message}` }],
    details: { error: message } satisfies ImageGenDetails,
  };
}

export function registerImageGenTool(
  pi: ExtensionAPI,
  dependencies: ImagineDependencies = DEFAULT_IMAGINE_DEPENDENCIES,
): void {
  const { z } = pi.zod;

  pi.registerTool({
    name: "image_gen",
    label: "Image Gen",
    description:
      "Generate a new image from a text description using Grok Imagine; returns the saved image's absolute path. For a request for one image, call this tool exactly once. Call it multiple times only when the user explicitly requests multiple images. Do not re-read or re-display the image unless the user asks.",
    parameters: z.object({
      prompt: z.string().describe("Text description of the image to generate."),
      aspect_ratio: z
        .string()
        .optional()
        .describe(
          "Aspect ratio of the generated image. Defaults to 'auto'. Examples: 1:1, 16:9, 9:16, 3:2, 2:3.",
        ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const prompt = params.prompt.trim();
        if (!prompt) throw new Error("Prompt is required");
        const aspectRatio = normalizeAspectRatio(params.aspect_ratio);
        const saved = await generateAndSaveImage(
          { ctx, prompt, aspectRatio, signal },
          dependencies,
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                path: saved.absolutePath,
                filename: saved.filename,
                relative_path: saved.relativePath,
                message:
                  "Image generated successfully. Do not repeat the saved path unless the user asks.",
              }),
            },
          ],
          details: {
            path: saved.absolutePath,
            relativePath: saved.relativePath,
            filename: saved.filename,
          } satisfies ImageGenDetails,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  });
}
