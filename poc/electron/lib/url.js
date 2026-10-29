// 地址校验与补全保持纯函数，测试无需加载 Electron 运行时。
function normalizeUrl(value) {
  const text = String(value || '').trim();
  if (!text) throw new Error('地址不能为空');
  if (text === 'about:blank') return text;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  const url = new URL(withScheme);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || text.length > 8192) {
    throw new Error('仅支持无凭据的 HTTP/HTTPS 地址');
  }
  return url.href;
}
module.exports = { normalizeUrl };
