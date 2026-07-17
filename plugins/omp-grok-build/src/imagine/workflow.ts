import { isAbsolute, resolve } from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { resolveGrokVersion } from "../auth";
import { resolveUsageToken } from "../usage";
import type { AspectRatio } from "./aspect";
import { generateImage } from "./generate";
import { saveImage, type SavedImage } from "./save";

export const IMAGINE_AUTH_ERROR =
  "No Grok Build login found. Run `/login grok-build` or `grok login`.";

export type ImagineDependencies = {
  generateImage: typeof generateImage;
  saveImage: typeof saveImage;
  resolveToken: typeof resolveUsageToken;
  resolveVersion: typeof resolveGrokVersion;
};

export const DEFAULT_IMAGINE_DEPENDENCIES: ImagineDependencies = {
  generateImage,
  saveImage,
  resolveToken: resolveUsageToken,
  resolveVersion: resolveGrokVersion,
};

export type SavedImagineImage = SavedImage & {
  b64: string;
  mimeType: "image/jpeg";
};

export async function generateAndSaveImage(
  options: {
    ctx: ExtensionContext;
    prompt: string;
    aspectRatio: AspectRatio;
    resolution?: string;
    signal?: AbortSignal;
    outPath?: string;
  },
  dependencies: ImagineDependencies = DEFAULT_IMAGINE_DEPENDENCIES,
): Promise<SavedImagineImage> {
  const token = await dependencies.resolveToken(options.ctx);
  if (!token) throw new Error(IMAGINE_AUTH_ERROR);

  const generated = await dependencies.generateImage({
    token,
    prompt: options.prompt,
    aspectRatio: options.aspectRatio,
    resolution: options.resolution,
    clientVersion: dependencies.resolveVersion(),
    signal: options.signal,
  });

  // Prefer the live session tree when OMP has persisted the session file.
  // In-memory / ephemeral sessions fall back to tmpdir storage.
  const persisted = options.ctx.sessionManager?.getSessionFile?.() !== undefined;
  const sessionDir = persisted ? options.ctx.sessionManager.getSessionDir() : undefined;
  const sessionId = persisted ? options.ctx.sessionManager.getSessionId() : undefined;

  const resolvedOut = options.outPath
    ? isAbsolute(options.outPath)
      ? options.outPath
      : resolve(options.ctx.cwd, options.outPath)
    : undefined;

  const saved = await dependencies.saveImage({
    b64: generated.b64,
    sessionDir,
    sessionId,
    outPath: resolvedOut,
  });

  return {
    ...saved,
    b64: generated.b64,
    mimeType: generated.mimeType,
  };
}
