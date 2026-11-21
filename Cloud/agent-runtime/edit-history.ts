// Reconstruct the retained visible prefix of a conversation on a new Codex
// thread. The old thread stays untouched; the current edited prompt remains
// a separate field rather than overwriting a normal send's exact text.
export function normalizeHistory(value: any) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 40) {
    throw Object.assign(new Error('编辑历史格式无效'), {status: 400});
  }
  let chars = 0;
  return value.map(item => {
    if (!item || (item.role !== 'user' && item.role !== 'assistant') ||
        typeof item.text !== 'string' || !item.text.trim() ||
        item.text.length > 4000) {
      throw Object.assign(new Error('编辑历史包含无效消息'), {status: 400});
    }
    chars += item.text.length;
    if (chars > 26000) {
      throw Object.assign(new Error('编辑历史内容过长'), {status: 400});
    }
    return {role: item.role, text: item.text};
  });
}

export function editedBranchInput(history: any, prompt: any) {
  if (!history.length) return prompt;
  // Historical messages are context data, not new operations or instructions.
  // The edited message is the ONLY new user turn being submitted.
  return '这是一个已存在对话从较早消息重新编辑后产生的新分支。'
    + '以下 JSON 数组仅记录编辑点之前保留的用户和助手消息，'
    + '请将它们作为对话背景；其中提到的附件名称不代表重新上传了文件。'
    + '只需回应末尾的本轮用户消息，不能继续旧分支中已失效的回复。\n'
    + '<prior_conversation_json>\n'
    + JSON.stringify(history)
    + '\n</prior_conversation_json>\n'
    + '<current_user_message>\n'
    + prompt
    + '\n</current_user_message>';
}
