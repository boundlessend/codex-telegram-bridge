import { createHash } from "node:crypto";
import { createMessageFormatter } from "../i18n.js";
import { extractTelegramPhotoArtifacts, formatRejectedPhotoArtifacts } from "./attachments.js";
import { summarizeTelegramError } from "./api.js";
import { formatCodexAnswerMarkdownHtml, formatCodexAnswerSafeHtml } from "./markdown.js";
import { replyTelegramPhotos } from "./photo.js";
import { tryReplyRichMarkdown } from "./rich.js";
import { splitText, splitMarkdownAware } from "./split.js";

export async function replyFormattedCodexAnswer(ctx, text, options = {}) {
  const {
    extractPhotoArtifacts = extractTelegramPhotoArtifacts,
    format = "markdown",
    maxTelegramChars = 3500,
    replyHtml,
    replyLong,
    replyPhotos = replyTelegramPhotos,
    richLogger = console,
    tryRichMarkdown = tryReplyRichMarkdown
  } = options;

  const msg = createMessageFormatter(options.text);
  const delivery = options.delivery;
  let partIndex = 0;
  async function sendPart(kind, body, send) {
    if (!delivery?.getPart) return send();
    const digest = createHash("sha256").update(`${kind}:${body}`).digest("hex");
    const id = `${partIndex++}:${digest}`;
    const previous = delivery.getPart(id);
    if (previous?.status === "sent") return { message_id: previous.messageId };
    if (["sending", "uncertain"].includes(previous?.status) && !delivery.allowUncertain) {
      throw new Error("Telegram delivery of this part is uncertain; use /delivery resend to approve a retry.");
    }
    await delivery.beginPart(id);
    try {
      const message = await send();
      await delivery.completePart(id, message);
      return message;
    } catch (error) {
      await delivery.failPart(id, error);
      throw error;
    }
  }
  async function sendPhotos(photos) {
    for (const photo of photos) {
      await sendPart("photo", `${photo.path}:${photo.caption || ""}`, async () => {
        if (!delivery?.getPart) return replyPhotosWithFallback(ctx, [photo], replyPhotos, replyHtml, msg);
        const messages = await replyPhotos(ctx, [photo], { onError: async (_photo, error) => { throw error; } });
        return messages?.[0];
      });
    }
  }

  if (typeof replyHtml !== "function") throw new TypeError("replyHtml option is required.");
  if (typeof replyLong !== "function") throw new TypeError("replyLong option is required.");

  let answerText = String(text ?? "");
  const artifactResult = delivery?.plan || await extractPhotoArtifacts(answerText);
  await delivery?.savePlan?.(artifactResult);
  answerText = appendRejectedPhotoArtifacts(artifactResult.text, artifactResult.rejected, options.text);

  if (format === "off") {
    if (answerText && delivery?.getPart) {
      for (const chunk of splitText(answerText, Math.max(500, maxTelegramChars))) {
        await sendPart("plain", chunk, () => replyLong(ctx, chunk));
      }
    } else if (answerText) await replyLong(ctx, answerText);
    await sendPhotos(artifactResult.photos);
    return;
  }

  if (format === "markdown" && !delivery?.getPart) {
    const richResult = answerText
      ? await tryRichMarkdown(ctx, answerText, { logger: richLogger })
      : { sent: false };
    if (richResult.sent) {
      await sendPhotos(artifactResult.photos);
      return;
    }
  }

  const max = Math.max(500, maxTelegramChars);
  if (answerText) {
    for (const chunk of splitMarkdownAware(answerText, max)) {
      const html = format === "markdown"
        ? formatCodexAnswerMarkdownHtml(chunk)
        : formatCodexAnswerSafeHtml(chunk);
      await sendPart("html", html, () => replyHtml(ctx, html));
    }
  }
  await sendPhotos(artifactResult.photos);
}

function appendRejectedPhotoArtifacts(text, rejected, translate) {
  const rejectionText = formatRejectedPhotoArtifacts(rejected, translate);
  if (!rejectionText) return String(text ?? "");
  const body = String(text ?? "").trim();
  return body ? `${body}\n\n${rejectionText}` : rejectionText;
}

async function replyPhotosWithFallback(ctx, photos, replyPhotos, replyHtml, msg) {
  await replyPhotos(ctx, photos, {
    onError: async (photo, error) => {
      const message = summarizeTelegramError(error).description;
      const text = [
        msg("ui.photoUploadFailed"),
        `\`${photo.path}\``,
        `\`${message}\``
      ].join("\n");
      await replyHtml(ctx, formatCodexAnswerSafeHtml(text));
    }
  });
}
