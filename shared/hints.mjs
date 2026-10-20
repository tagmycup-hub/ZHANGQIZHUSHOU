// 参考资料（用户以往的商家与型号）附在提示词后面；前端 Claude 通道与后端服务共用
export const HINTS_MAX = 6000;
export function withHints(prompt, hints) {
  const h = String(hints ?? '').trim().slice(0, HINTS_MAX);
  if (!h) return prompt;
  return (
    prompt +
    '\n\n【参考资料】以下是这位用户以往记录的商家与型号，只用来帮助辨认模糊的手写字：' +
    '图片上没有的内容绝不能因为参考资料而写出；看得清的字以图片为准；' +
    '某处字形本身模糊、而按常用型号/商家名读正好说得通时，可以这样读，但该字段 confidence 不得高于 0.8，并在 warnings 写明「按常用型号辨认」。\n' +
    h
  );
}
