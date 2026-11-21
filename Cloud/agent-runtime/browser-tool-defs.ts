// Browser tool definitions shared by the MCP bridges (agent-runtime) and the Dots agent runtime
// (dots-runtime), which exposes the same tools to sandboxed agents. No side effects on import.
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
export const BROWSER_TOOLS = [
  { name: 'browse', description: '在真实网站上操作（服务器上的真实 Chrome，由后台执行者完成）。开新活传 task_id: "new"；继续某个已有窗口传它的 task_id。task 里写清：要达到的结果、已知的确切选择、限制条件，以及完成任务所需且已授权的信息（用户给的卡片或一次性验证码可以文字写进来）。密码绝不能写进 task：登录用保存的登录（Secure Vault）或用户加密录入。需要的文件用 files 授权（附件 id）。受保护的验证码引用放在 verification_code。返回的是受理回执，受理不等于完成；结果和需要决定的问题会自动回到对话。修改、登录、核对购物车、结账都继续用同一个 task_id；不同网站的购买或登录各开一个窗口；一个窗口一次只跑一个结账。回答任务提出的问题时：answer_to 设成那个 question_id，回复写在 task 里——先自己对照用户的要求核对（比如购物车），只把用户没定、会影响结果的选择拿给用户。加密输入、付款授权、权限询问和接管只能由用户在专用界面处理，别在聊天里索要，也别在等决定时另开任务。',
    inputSchema: { type: 'object', additionalProperties: false, required: ['task_id', 'task'], properties: {
      task_id: str('"new" 表示新任务窗口；否则为已有窗口的 task_id'),
      task: str('给执行者的要求，或对 answer_to 问题的回复'),
      answer_to: str('要回答的 question_id（可选）'),
      verification_code: str('受保护的验证码引用（可选，如 vc_…）；用户批准分享后才会给浏览器，只对当前这次验证有效'),
      files: { type: 'array', maxItems: 10, items: { type: 'string' }, description: '授权给任务使用的文件（拾燕附件 id）' },
      identity: str('浏览器身份（可选，默认 default；用其他账号时用用户在设置里建好的身份）'),
      title: str('窗口标题（可选）'),
    } } },
  { name: 'windows', description: '列出、打开、关闭浏览器窗口和标签页。用户提到正在进行的工作、某个窗口或身份，或你需要 task_id 时使用。每个任务就是一个带标签页的窗口；所有窗口默认共用浏览器身份（一次登录可用于所有对话和定时任务），除非用指定身份打开。action: list（可带 task_id 看详情、进度和文件）| open（url、identity 可选，返回新 task_id）| close（task_id；停止任务并关窗，已在网站上完成的操作不会撤销）| open_tab（task_id、url）| close_tab（task_id、tab_id）。',
    inputSchema: { type: 'object', additionalProperties: false, required: ['action'], properties: {
      action: { type: 'string', enum: ['list', 'open', 'close', 'open_tab', 'close_tab'] }, task_id: str('窗口的 task_id'), tab_id: str('标签页 id'), url: str('网址'), identity: str('浏览器身份'), title: str('窗口标题'),
    } } },
  { name: 'search', description: '用服务器浏览器搜索网页，返回标题、链接和摘要。只读取文字；失败时如实汇报实际看到的失败，不代表真实浏览器被拦住，也不代表网站需要登录。',
    inputSchema: { type: 'object', additionalProperties: false, required: ['query'], properties: { query: str('搜索内容'), max_results: { type: 'integer', minimum: 1, maximum: 15 } } } },
  { name: 'open', description: '读取网页文字（分段返回，用 next_cursor 继续）。读取失败不代表真实浏览器被拦住，也不代表需要登录；需要在网站上操作请用 browse。',
    inputSchema: { type: 'object', additionalProperties: false, required: ['url'], properties: { url: str('网址'), cursor: { type: 'integer', minimum: 0 } } } },
  { name: 'find', description: '在已用 open 读取的网页里查找文字（不传 url 时用最近打开的页面），返回匹配位置和上下文。',
    inputSchema: { type: 'object', additionalProperties: false, required: ['query'], properties: { query: str('要查找的文字'), url: str('网址（可选）') } } },
];

const obj = (properties, required: string[] = []) => ({ type: 'object', additionalProperties: false, properties, required });
const s = description => ({ type: 'string', description });
const n = description => ({ type: 'number', description });
export const EXEC_TOOLS = [
  ['get_task', '读取任务要求、新输入（追加要求、问题答复、交还说明）、授权文件、权限和窗口状态。', obj({})],
  ['snapshot', '读取当前页面：网址、标题、标签页、可交互元素（ref 编号）、可见文字、滚动位置、机器人验证迹象、被拦截的导航。页面变化后 ref 失效，需要重新 snapshot。', obj({})],
  ['screenshot', '截取当前视口图片（用于看清布局或 snapshot 读不到的 iframe 内容，坐标可用于 click）。', obj({})],
  ['navigate', '在当前标签页打开网址（或搜索词）。可能因用户的网站权限被拦截。', obj({ url: s('网址') }, ['url'])],
  ['back', '后退', obj({})], ['forward', '前进', obj({})], ['reload', '刷新', obj({})],
  ['click', '点击元素（ref）或视口坐标（x、y）。会提交订单或付款的按钮必须用 place_order。', obj({ ref: s('元素 ref'), x: n('x'), y: n('y'), double: { type: 'boolean' }, button: { type: 'string', enum: ['left', 'right'] } })],
  ['type', '在输入框里输入文字（默认先清空）。不能用于密码或加密字段。', obj({ ref: s('元素 ref'), text: s('文字'), clear: { type: 'boolean' }, submit: { type: 'boolean', description: '输入后按回车' } }, ['ref', 'text'])],
  ['press', '按键：Enter、Tab、Escape、Backspace、Delete、方向键、Home、End、PageUp、PageDown、Space 或单个字符。', obj({ key: s('按键'), modifiers: { type: 'array', items: { type: 'string', enum: ['alt', 'ctrl', 'meta', 'shift'] } } }, ['key'])],
  ['select', '选择下拉框选项（按值或文字）。', obj({ ref: s('下拉框 ref'), option: s('选项') }, ['ref', 'option'])],
  ['scroll', '滚动页面（direction up/down，amount 像素）或把 ref 元素滚到可见处。', obj({ direction: { type: 'string', enum: ['up', 'down'] }, amount: n('像素'), ref: s('元素 ref') })],
  ['switch_tab', '切换到窗口内的另一个标签页。', obj({ tab_id: s('标签页 id') }, ['tab_id'])],
  ['new_tab', '在本任务窗口打开新标签页。', obj({ url: s('网址') })],
  ['close_tab', '关闭本任务窗口的一个标签页。', obj({ tab_id: s('标签页 id') }, ['tab_id'])],
  ['read_text', '读取当前页面完整文字（分段，用 next_cursor 继续）。', obj({ cursor: n('起始位置') })],
  ['find_text', '在当前页面文字里查找。', obj({ query: s('要找的文字') }, ['query'])],
  ['ask', '向 Dots 提出一个会影响结果、而要求里没定的选择（kind=choice），或请求确认购物车（kind=cart_confirmation，cart 写清商品、规格、数量、单价、运费、合计、收货信息）。会等待答复。', obj({ question: s('问题'), options: { type: 'array', items: { type: 'string' } }, kind: { type: 'string', enum: ['choice', 'cart_confirmation'] }, cart: { type: 'object' } }, ['question'])],
  ['wait_for_answer', '等待某个已提出的问题（例如网站访问许可）的答复。', obj({ question_id: s('question_id') }, ['question_id'])],
  ['request_secure_input', '请用户在加密输入界面填写敏感字段（密码、卡号、验证码等）；内容直接填进页面，不经过你。', obj({ ref: s('输入框 ref'), label: s('要填什么'), kind: { type: 'string', enum: ['password', 'card', 'otp', 'other'] } }, ['ref', 'label'])],
  ['fill_saved_login', '用 Secure Vault 里为当前网站保存的登录填写账号和密码（按用户权限设置，可能需要用户许可）。', obj({ username_ref: s('账号框 ref'), password_ref: s('密码框 ref'), entry_id: s('有多条时指定') })],
  ['enter_verification_code', '把 Dots 传来的受保护验证码引用填入输入框（用户批准后才可用，只能用一次）。', obj({ ref: s('输入框 ref'), code_ref: s('验证码引用（可选）') }, ['ref'])],
  ['request_payment_authorization', '在提交订单/付款前，请用户在付款授权界面批准这一笔（写清商家、金额、币种、商品、支付方式）。', obj({ merchant: s('商家'), amount: s('金额'), currency: s('币种'), items: { type: 'array', items: { type: 'string' } }, payment_method: s('支付方式') }, ['merchant', 'amount'])],
  ['place_order', '用已批准的付款授权点击“提交订单/付款”按钮。每个授权只能用一次。', obj({ ref: s('按钮 ref'), authorization_id: s('付款授权 id') }, ['ref', 'authorization_id'])],
  ['request_takeover', '请用户接管真实浏览器亲自完成某一步（例如机器人验证或网站拦截）。只对对话里发起的任务可用；交还后继续。', obj({ reason: s('需要用户做什么') }, ['reason'])],
  ['download_file', '下载文件（点击 ref 或打开 url），按用户的下载权限处理，结果保存为受保护文件。', obj({ ref: s('下载链接 ref'), url: s('下载地址'), description: s('下载的是什么') })],
  ['upload_file', '把已授权给本任务的文件放进上传框（ref 为文件输入框或会打开文件选择的按钮）。', obj({ ref: s('元素 ref'), file_id: s('授权文件 id') }, ['ref', 'file_id'])],
  ['save_screenshot', '把当前页面截图保存为受保护文件（用于交付或作为凭证）。', obj({ label: s('文件名') })],
  ['report_progress', '记录一句进展（用户在任务面板可见）。', obj({ text: s('进展') }, ['text'])],
  ['wait', '等待几秒（页面加载、浏览器忙时重试）。', obj({ seconds: n('秒，最多 30') })],
  ['finish', '结束本轮：status done/failed/blocked，summary 写清实际结果；提交过订单的必须在 merchant_confirmation 写商家凭证（订单号等），没有就说明结果不明。', obj({ status: { type: 'string', enum: ['done', 'failed', 'blocked'] }, summary: s('结果'), merchant_confirmation: s('商家订单凭证') }, ['status', 'summary'])],
].map(([name, description, inputSchema]) => ({ name, description, inputSchema }));
