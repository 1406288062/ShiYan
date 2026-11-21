// 在这里注册全部模型提供方。注册顺序 = 选择器分组顺序 = 模型 id 冲突时的优先级。
// 新增 SDK：在 providers/ 下新建模块（实现 README.md 中的合同），再在下面加一行 registerProvider。
import { registerProvider } from './registry.ts';
import codex from './codex.ts';
import claude from './claude.ts';

registerProvider(codex);
registerProvider(claude);

export * from './registry.ts';
