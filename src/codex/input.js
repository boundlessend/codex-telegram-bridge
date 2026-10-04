export function buildInput(text, imagePaths) {
  if (imagePaths.length === 0) return text;
  return [
    { type: "text", text },
    ...imagePaths.map((imagePath) => ({ type: "local_image", path: imagePath }))
  ];
}

export function mergeReplyContext(text, replyContext) {
  if (!replyContext.text) return text;
  return [
    "Use the following replied-to Telegram message as context.",
    "",
    "<replied_message>",
    replyContext.text,
    "</replied_message>",
    "",
    "<current_message>",
    text,
    "</current_message>"
  ].join("\n");
}
