/** 草稿与历史只显示内嵌的栅格图片，不因消息内容访问外部地址或本地文件。 */
export function inlineImageUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  return /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(value) ? value : undefined;
}
