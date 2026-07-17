import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { parseImagineArgs } from "./parseArgs";
import { registerImageGenTool } from "./tool";
import {
  DEFAULT_IMAGINE_DEPENDENCIES,
  generateAndSaveImage,
  type ImagineDependencies,
} from "./workflow";

export function registerImagineCommand(
  pi: ExtensionAPI,
  dependencies: ImagineDependencies = DEFAULT_IMAGINE_DEPENDENCIES,
): void {
  pi.registerCommand("grok-build-imagine", {
    description:
      "Generate an image with Grok Imagine. Usage: /grok-build-imagine <prompt> [--aspect <ratio>] [--out <path>]",
    handler: async (args, ctx: ExtensionCommandContext) => {
      let parsed;
      try {
        parsed = parseImagineArgs(args);
      } catch (err) {
        ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
        return;
      }

      ctx.ui.setWorkingMessage("Generating image…");
      try {
        const saved = await generateAndSaveImage(
          {
            ctx,
            prompt: parsed.prompt,
            aspectRatio: parsed.aspectRatio,
            resolution: parsed.resolution,
            outPath: parsed.outPath,
          },
          dependencies,
        );

        if (saved.usedFallback) {
          ctx.ui.notify(
            "Session storage unavailable; saved image in temporary storage.",
            "warning",
          );
        }

        // Inject the image into the conversation so both the user and the model
        // see it on the next turn. This is the OMP-native equivalent of the
        // original pi entry renderer + notify path.
        pi.sendUserMessage([
          { type: "image", data: saved.b64, mimeType: saved.mimeType },
          {
            type: "text",
            text: `Image saved to ${saved.relativePath} (${saved.absolutePath})`,
          },
        ]);
      } catch (err) {
        ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
      } finally {
        ctx.ui.setWorkingMessage(undefined);
      }
    },
  });

  registerImageGenTool(pi, dependencies);
}
