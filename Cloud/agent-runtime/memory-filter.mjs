// Pure rule layer that runs before any model call. It only decides whether a turn
// can plausibly contain a durable user fact; it never saves anything by itself.
const trivial = /^(?:好的?|好滴|嗯+|谢谢|感谢|收到|ok(?:ay)?|hi|hello|你好|哈哈+|继续|是的?|对|行|可以)[!！。.\s]*$/i;
const signal = /我|咱们|我们|\bI\b|I'm|\bmy\b|prefer|always|usually|以后|今后|长期|默认|每次|总是|习惯|喜欢|偏好|记住|忘记|不再|项目|改为|改成|不要|别再|请|帮我/i;

export function worthExtracting(text = '') {
  const value = String(text).replace(/\s+/g, ' ').trim();
  if (value.length < 4) return false;
  if (trivial.test(value)) return false;
  return signal.test(value);
}
