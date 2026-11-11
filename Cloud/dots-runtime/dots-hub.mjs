// Dots 的推理类调用（assess）与模型中枢的衔接。智能体线程（manager、Mac 执行器）不经这里。
// 中枢不可用时返回空对象，调用方沿用原有的 Codex 与环境变量默认值。
import { createHubClient } from '/home/ubuntu/model-hub/client.mjs';

const CONSUMER_BY_SOURCE = { 'dots-mail-summary': 'dots.mail', 'dots-github-summary': 'dots.github', 'dots-subscribe': 'dots.subscribe', 'dots-route': 'dots.route' };
export const dotsConsumer = source => CONSUMER_BY_SOURCE[source] || 'dots.proactive';

export function createDotsHub(client = createHubClient()) {
  return {
    // 返回：
    //   { result }    中枢已经完成，result 是解析好的 JSON
    //   { settings }  仍由 Codex 执行，使用中枢指定的 {model, effort}
    //   {}            沿用原有默认
    async plan(source, { data, schema, signal, account } = {}) {
      const consumer = dotsConsumer(source);
      const route = await client.route(consumer);
      if (!route) return {};
      if (route.provider === 'openai') return { settings: { model: route.model, effort: route.reasoning } };
      // 非 GPT：交给中枢；出错时错误向上抛出，由调用方按原有方式处理。
      const response = await client.infer(consumer, { prompt: data, outputSchema: schema, ...(account ? { account } : {}) }, { signal });
      return { result: JSON.parse(response.finalResponse) };
    },
    // 业务自己执行的调用（GPT 路线、智能体）结束后上报元数据。
    report: (consumer, entry) => client.report?.(consumer, entry),
    route: consumer => client.route(consumer),
    infer: (consumer, body, options) => client.infer(consumer, body, options),
  };
}
