/* eslint-env browser */
/**
 * The console's client script, served verbatim at a content-addressed URL.
 *
 * A real file rather than a template literal: it used to live inside one, where
 * the parser silently ate every backslash — `/\s+/g` reached the browser as
 * `/s+/g`, which matches the letter s and quietly corrupted every screen-reader
 * announcement. A .js file also gets syntax-checked by `npm run check`.
 */
const translations = {
  'brand-tagline': '私有账号与设备控制平面',
  'member-zone-label': '成员自助区 · 所有成员看到的就是这里',
  'member-heading': '给这台设备开通 AI 工具',
  'member-intro': '选择团队账号并领取本机配置，不需要管理员转发令牌，也不需要登录共享的上游账号。',
  'tailscale-identity': 'Tailscale 身份',
  'open-banner': '本控制台没有任何认证：任何能访问它的人都可以签发和撤销凭据。',
  'no-identity': '无身份',
  'anonymous-visitor': '匿名访问者',
  'member-label': '你的标签（自己填写，不做校验）',
  'member-label-note': '没有人会校验这个标签，它只用来区分不同成员的设备名。',
  'claude-description': '领取一个只属于当前成员和设备、可通过公网使用的配置。上游 OAuth 令牌不会离开服务器。',
  'team-account': '团队账号',
  'device-name': '本机设备名',
  'get-claude': '领取 Claude Code 配置',
  'no-account': '尚无可用账号',
  'waiting-owner': '等待账号所有者录入',
  'owner-add-once': '账号所有者只需在下方管理员区录入一次，之后所有成员都能自行领取。',
  'codex-description': 'refresh center 会持续轮换主凭据。领取不依赖内网的单文件安装器与独立设备 token。',
  'get-codex': '领取 Codex 安装脚本',
  'codex-unavailable': 'Codex 自助登记尚未配置。管理员需要连接 dispenser enrollment。',
  'admin-zone': '管理员区',
  'admin-heading': '账号、设备与特殊登记',
  'admin-intro': '这里用于一次性录入上游账号、查看设备和撤销访问。普通成员的日常领取发生在上方自助区。',
  'accounts': '账号',
  'healthy': '健康',
  'active-claude-credentials': '有效的 Claude 凭据',
  'account': '账号',
  'provider': '提供商',
  'status': '状态',
  'devices': '设备',
  'expires': '过期时间',
  'usage-quota': '用量额度',
  'usage-five-hour': '5 小时窗口',
  'usage-weekly': '周窗口',
  'usage-remaining': '剩余',
  'usage-resets': '重置于',
  'usage-updated': '更新于',
  'usage-not-reported': '上游未提供',
  'usage-loading': '正在等待首次每小时用量刷新。',
  'usage-reauthorize': '需要为该 Claude 账号重新授权一次，才能显示额度。',
  'usage-authorize-first': '完成该账号的授权后才能显示额度。',
  'usage-stale': '最新刷新失败，当前显示上一次成功结果。',
  'usage-unavailable': '当前暂时无法取得用量。',
  'action': '操作',
  'last-seen': '最后使用',
  'no-accounts': '尚无账号。',
  'upstream-secret-note': '上游令牌加密保存，提交后不再展示。特殊情况可在账号行生成一次性登记链接。',
  'add-claude-heading': '录入 Claude Code 团队账号',
  'add-claude-help': '只需登记预期的账号所有者邮箱。所有者之后在该账号的固定授权页面自行完成 OAuth，无需把 token 交给管理员。',
  'account-alias': '账号别名',
  'account-email': '账号邮箱标签',
  'register-account': '登记账号',
  'owner-authorization': '账号所有者授权',
  'owner-login-required': '账号所有者完成授权后才能登记成员设备。',
  'owner-auth-heading': '账号所有者授权',
  'owner-auth-account': '预期账号',
  'owner-page-permanent': '这个控制页网址长期有效。账号所有者有空时再打开即可；只有点击“开始授权”后才会创建临时 OAuth 会话。',
  'copy-owner-link': '复制所有者页面链接',
  'start-authorization': '开始一次新的授权',
  'temporary-session-ready': '新的 15 分钟授权会话已准备好。',
  'owner-auth-step-1': '打开下面的 Claude 页面，并使用预期账号登录。',
  'owner-auth-step-2': '同意推理与用量查看权限，然后复制完整 code，包括 # 以及后面的全部内容。',
  'owner-auth-step-3': '返回本页粘贴 code 并提交；服务器会自动兑换和保存凭据。',
  'open-claude-authorization': '打开 Claude 授权页面',
  'authorization-code': '完整 authorization code',
  'complete-authorization': '完成授权',
  'owner-auth-security': '密码、浏览器 Cookie、authorization code 和上游 token 都不会展示给管理员；账号邮箱不匹配时会在保存前拒绝。',
  'codex-authorization': 'Codex 账号授权',
  'codex-auth-heading': 'Codex 账号授权',
  'codex-target-seed': '完成后凭据会直接写入下方的 Codex 凭据目录，不在页面上展示。',
  'codex-target-manual': '未配置 Codex 凭据目录，因此生成的 auth.json 只展示一次供你复制或下载。控制台不写入任何文件。',
  'codex-localhost-expected': '最后一步浏览器打不开是正常的。OpenAI 把这个客户端注册在 http://localhost:1455，会把浏览器跳到那里，而本机并没有程序在监听。出现“无法访问”正是成功的表现，不是故障——此时地址栏里就是 authorization code。',
  'codex-auth-step-1': '打开下面的 OpenAI 页面，使用拥有 Codex 订阅的 ChatGPT 账号登录。',
  'codex-auth-step-2': '等浏览器跳到打不开的 localhost 地址，然后从地址栏复制整条地址。',
  'codex-auth-step-3': '粘贴回本页并提交；只粘 code 也可以。服务器会直接与 OpenAI 兑换。',
  'open-codex-authorization': '打开 OpenAI 授权页面',
  'codex-redirect-label': '打不开的 localhost 地址，或仅 code',
  'codex-auth-security': '授权会话一次性使用、15 分钟过期，并在开始新会话时作废。粘贴整条地址时会校验本控制台签发的 state；只粘 code 时没有 state，依赖 PKCE 和「同时只有一个存活会话」。PKCE verifier 加密保存，生成的凭据不会写入 state.json、审计记录或日志。',
  'session-still-open': '这个授权会话仍然有效，你手上的 code 可以再粘贴一次。开始新的授权会让它作废。',
  'codex-account-authorized': '该 Codex 账号已授权',
  'codex-seeded-ok': '凭据已写入配置的 Codex 凭据目录，不在此展示。',
  'continue': '继续',
  'codex-copy-now': '立即复制或下载此凭据',
  'codex-one-time-json': '这是完整的 auth.json，含一个可用的一次性 refresh token。只展示一次，控制台不保留副本，本页无法再次生成。请限制为仅自己可读，凭据中心播种完成后删除。',
  'download-auth-json': '下载 auth.json',
  'copy-auth-json': '复制 auth.json',
  'codex-seed-command': '用它给凭据中心播种',
  'codex-seed-stale': '播种是交接，不是备份：中心第一次轮换就会换掉 refresh token，这个文件当场失效。用完请删除，不要留存。',
  'add-codex-heading': '录入 Codex 团队账号',
  'add-codex-help': '先登记别名，再在该账号自己的页面完成 ChatGPT 订阅授权，不需要另一台机器上的 codex login。',
  'account-email-optional': '账号邮箱标签（可选，授权时校验）',
  'member-flow': '成员实际流程',
  'member-step-1': '成员加入 tailnet 后打开本页。',
  'member-step-2': '在上方成员自助区选择工具和账号，并填写设备名。',
  'member-step-3': '复制或下载只显示一次的本机安装脚本并运行。',
  'member-step-4': '设备丢失或停用时，只撤销该设备。',
  'same-self-service': '管理员和成员看到的是同一个自助区，不再需要人工分发授权凭证。',
  'machines': '机器',
  'machines-intro': '每台机器一行，其持有的全部凭据折叠在下方。机器由一个不透明的随机句柄标识——由机器上的代理上报，或者在机器没有代理可上报时，由本控制台为该次签发生成。这个句柄不说明使用者是谁，旁边的成员标签是自己填写的、不做校验。',
  'no-machines': '还没有任何机器持有凭据。',
  'unattributed-credential': '无法归属的凭据',
  'unattributed-credentials': '未归属到机器的凭据',
  'unattributed-intro': '这些凭据签发于机器句柄出现之前，或者来自不会上报句柄的路径——浏览器不是代理，没有句柄可报。这里不会根据设备名或成员标签相同就自动合并；把某条凭据归入一台机器后，它才会计入那台机器。',
  'legacy-no-handle': '没有机器句柄',
  'count-active': '个有效',
  'count-revoked': '个已撤销',
  'credential': '凭据',
  'credential-type': '类型',
  'credential-status': '凭据状态',
  'credential-active': '有效',
  'credential-revoked': '已撤销',
  'unknown-account': '未知账号',
  'enrolled-at': '登记于',
  'not-reported-here': '不会上报到本控制台',
  'dispenser-managed': '由 dispenser 管理',
  'no-active-credentials': '没有有效凭据。',
  'revoked-credentials': '已撤销的凭据',
  'retired-machines': '没有有效凭据的机器',
  'merge-into-machine': '把这条凭据归入某台机器',
  'merge-credential': '归并',
  'no-merge-targets': '还没有任何机器上报过句柄，因此没有可归入的对象。',
  'codex-legacy-note': '这条 Codex 凭据没有机器句柄：要么它登记于机器句柄出现之前——那台机器上的代理会在下次登记时上报句柄；要么它是本控制台代为签发的——那种凭据永远不会上报，因为生成的安装脚本运行的是 pull.js，不含 enroll.js。无论哪种情况，控制台只读取 dispenser 的注册表，无法把句柄写进去。',
  'codex-inventory-unavailable': '至少有一个凭据目录的 Codex 机器列表读不到，因此只有 dispenser 知道的机器不会出现在这个列表里。',
  'original-account': '原始账号',
  'allowed-accounts': '允许切换的账号',
  'selected-account': '当前所选账号',
  'switch-account': '切换账号',
  'account-switch-working': '正在切换…',
  'account-switch-saved': '已切换到',
  'account-switch-failed': '切换失败，当前页面未刷新；请重试或重新载入页面。',
  'account-selection-invalid': '账号选择配置无效；系统没有擅自猜测账号。',
  'no-claude-accounts': '尚未登记 Claude 账号。',
  'open-account-switch-warning': 'Open 模式没有可验证的操作人：任何能访问控制台的人都可以切换任意有效设备。操作人记录为 anonymous；成员标签不代表操作人。',
  'ai-onboarding-guide': 'AI 接入指引',
  'ai-onboarding-intro': '这是根据当前部署实时生成的内网 Markdown，包含地址、账号状态和配置版本，但绝不包含 token。',
  'open-onboarding-warning': 'Open 模式下，任何能访问本控制台的人都可以读取这份实时指引及其中的部署/账号元数据。请把控制台保持在私有网络内；成员标签未经验证，也不代表操作人身份。',
  'copy-onboarding-link': '复制指引链接',
  'open-onboarding-guide': '打开指引',
  'metrics-dashboard-link': '查看请求指标',
  'metrics-label': '用量洞察',
  'metrics-heading': 'Token 使用量',
  'metrics-intro': '按小时查看 Claude 网关的 Token 消耗、请求健康和设备趋势，并严格区分未知值与零。',
  'metrics-intro-long': '本页只渲染请求元数据，不展示请求正文或回复正文；符合条件的已捕获 API 轮次会在「对话」中展示。',
  'metrics-claude-only': 'Token 核算只覆盖 Claude 网关流量。Codex 客户端直接连接服务商，不在此统计范围内。',
  'metrics-attribution-disclaimer': '使用者标签由本人填写，未经验证；只能用于观察用量趋势，不得作为追责或计费依据。',
  'metrics-status-coverage': '完整覆盖率',
  'metrics-unknown-zero': '— 表示未知，绝不表示零',
  'metrics-filter-toggle': '筛选条件',
  'metrics-filter-heading': '筛选用量',
  'metrics-filter-machine': '机器',
  'metrics-filter-member': '使用者标签',
  'metrics-filter-account': '账号',
  'metrics-filter-model': '模型',
  'metrics-filter-hours': '时间范围',
  'metrics-all-machines': '全部机器',
  'metrics-all-members': '全部使用者',
  'metrics-all-accounts': '全部账号',
  'metrics-all-models': '全部模型',
  'metrics-unattributed-machine': '未归属（没有机器句柄）',
  'metrics-hours-24': '最近 24 小时',
  'metrics-hours-168': '最近 7 天',
  'metrics-hours-720': '最近 30 天',
  'metrics-apply-filters': '应用筛选',
  'metrics-reset-filters': '重置筛选',
  'metrics-unavailable': '请求指标暂时不可用。',
  'metrics-incomplete': '部分请求元数据未能保存，图表可能不完整。',
  'metrics-error': '指标页面无法载入数据。',
  'metrics-total-requests': '全部请求',
  'metrics-consumption-requests': '消耗请求',
  'metrics-known-total': '已知 Token 总量',
  'metrics-known-total-lower-bound': '所选时间范围的下界',
  'metrics-known-total-exact': '完整上报类别的精确总和',
  'metrics-request-outcomes': '成功 / 错误',
  'metrics-request-volume': '请求健康',
  'metrics-request-volume-description': '每小时全部请求、成功请求与错误请求的数量。',
  'metrics-latency': '延迟',
  'metrics-latency-description': '每小时平均首字节时间与请求总耗时，单位为毫秒。',
  'metrics-no-data': '所选时间范围内没有匹配的请求数据。',
  'metrics-series-total': '全部请求',
  'metrics-series-success': '成功请求',
  'metrics-series-error': '错误请求',
  'metrics-series-ttfb': '平均首字节时间（毫秒）',
  'metrics-series-duration': '平均总耗时（毫秒）',
  'metrics-series-input-tokens': '输入 token',
  'metrics-series-cache-creation-input-tokens': '缓存创建输入 token',
  'metrics-series-cache-read-input-tokens': '缓存读取输入 token',
  'metrics-series-output-tokens': '输出 token',
  'metrics-token-input': '输入 token 总量',
  'metrics-token-cache-creation': '缓存创建输入 token 总量',
  'metrics-token-cache-read': '缓存读取输入 token 总量',
  'metrics-token-output': '输出 token 总量',
  'metrics-token-known-count': '已知值条数',
  'metrics-token-coverage-complete': 'Token 总量来自完整的用量记录，可视为精确值。',
  'metrics-token-coverage-complete-with-unknown': '用量记录完整，但 — 类别未由服务商报告。',
  'metrics-token-coverage-lower-bound': 'Token 总量是下界；部分或不可用的用量不会被当作零。',
  'metrics-token-coverage-unavailable': '所选范围的 token 用量不可用；— 表示未知，不是零。',
  'metrics-token-coverage-overflow': '至少一类 token 总量过大，无法精确显示；每请求原始计数仍保留。',
  'metrics-token-coverage-overflow-lower-bound': '至少一类总量过大，无法精确显示；同时部分或不可用记录使可见总和仍只是下界。',
  'metrics-token-complete-count': '完整',
  'metrics-token-partial-count': '部分',
  'metrics-token-unavailable-count': '不可用',
  'metrics-token-trend': '每小时 Token 构成',
  'metrics-token-trend-description': '在真实 UTC 时间轴上堆叠四类已知 Token；未知值保留为空档。',
  'metrics-token-no-data': '所选范围没有可用的 token 用量。',
  'metrics-total-input-tokens': '输入 token',
  'metrics-total-cache-creation-input-tokens': '缓存创建输入 token',
  'metrics-total-cache-read-input-tokens': '缓存读取输入 token',
  'metrics-total-output-tokens': '输出 token',
  'metrics-usage-coverage': '用量覆盖情况',
  'metrics-usage-complete': '完整',
  'metrics-usage-complete-with-unknown': '完整 / 部分类别未知',
  'metrics-usage-partial': '部分 / 下界',
  'metrics-usage-unavailable': '不可用',
  'metrics-usage-not-applicable': '不适用',
  'metrics-usage-overflow': '总量过大，无法精确显示',
  'metrics-hourly-table': '每小时明细',
  'metrics-hour': '小时（UTC）',
  'metrics-request-count': '请求数',
  'metrics-success-count': '成功数',
  'metrics-error-count': '错误数',
  'metrics-request-bytes': '请求字节数',
  'metrics-response-bytes': '响应字节数',
  'metrics-avg-ttfb': '平均首字节时间（毫秒）',
  'metrics-avg-duration': '平均总耗时（毫秒）',
  'tab-overview': '总览',
  'tab-metrics': '用量与指标',
  'tab-conversations': '对话',
  'metrics-conversations-link': '查看对话',
  'metrics-account-breakdown-heading': '按账号查看用量',
  'metrics-account-breakdown-description': '按已知 Token 总量排列用量最高的账号。',
  'metrics-model-breakdown-heading': '按模型查看用量',
  'metrics-model-breakdown-description': '按已知 Token 总量排列用量最高的模型。',
  'metrics-breakdown-no-data': '当前没有可用的 Token 分布数据。',
  'metrics-device-comparison-heading': '设备用量洞察',
  'metrics-device-comparison-description': '比较最活跃设备的已知 Token 总量与每小时趋势；未知值保留为空档，绝不补零。',
  'metrics-device-comparison-scope': '此比较沿用成员、账号、模型和时间筛选；有意忽略单设备机器选择器。',
  'metrics-device-input-comparison-heading': '每小时按设备的输入侧已知 token',
  'metrics-device-input-comparison-description': '仅当 input、缓存创建 input、缓存读取 input 三类都已知时绘制；缺一类就留出空档。',
  'metrics-device-output-comparison-heading': '每小时按设备的输出 token',
  'metrics-device-output-comparison-description': '每条线是 output_tokens；未知输出留空，不当作零。',
  'metrics-device-ranking-heading': '按设备的已知 Token',
  'metrics-device-ranking-description': '所选范围内的输入侧已知 Token 与输出 Token。',
  'metrics-device-trend-heading': '每小时设备趋势',
  'metrics-device-trend-description': '在完整输入侧已知 Token 与输出 Token 之间切换。',
  'metrics-device-toggle-input': '输入侧',
  'metrics-device-toggle-output': '输出',
  'metrics-static-fallback-toggle': '显示静态图表备用视图',
  'metrics-device-comparison-known-sum': '设备趋势线',
  'metrics-device-comparison-known-points': '已知点',
  'metrics-device-comparison-unknown-points': '未知点',
  'metrics-device-comparison-coverage': '覆盖情况',
  'metrics-device-comparison-device': '设备',
  'metrics-device-comparison-complete': '完整',
  'metrics-device-comparison-partial': '部分 / 下界',
  'metrics-device-comparison-unavailable': '不可用',
  'metrics-device-comparison-no-data': '没有可用的跨设备 token 比较数据。',
  'metrics-device-comparison-truncated': '最多显示八台设备；其余设备已省略。',
  'metrics-device-comparison-devices-truncated': '最多显示八台设备；其余设备已省略。',
  'metrics-device-comparison-hours-truncated': '每小时比较有界；部分小时已省略。',
  'metrics-device-comparison-unavailable-devices': '部分设备无法用于比较。',
  'metrics-device-comparison-table-caption': '四类原始 token 值与覆盖情况备用表',
  'metrics-device-comparison-table-toggle': '显示原始比较表',
  'metrics-device-comparison-table-truncated': '原始表只显示最新 200 行；更早的行已省略。',
  'metrics-hourly-table-caption': '每小时请求与 token 明细',
  'metrics-hourly-table-toggle': '显示每小时明细',
  'metrics-hourly-table-truncated': '每小时表只显示最新 200 行；更早的行已省略。',
  'metrics-scroll-table-hint': '可横向滑动查看全部列。',
  'metrics-methodology-toggle': '统计范围、隐私与归因说明',
  'conversations-dashboard-link': '查看对话',
  'conversations-label': 'API 片段诊断',
  'conversations-heading': 'API 片段诊断',
  'conversations-intro': '这里保留按请求捕获的 Claude API 片段用于诊断；它们可能是包装、提醒或工具循环中间态，不是用户回合，也不会被猜测拼成对话。',
  'conversation-subnav-sessions': '对话',
  'conversation-subnav-turns': 'API 片段诊断',
  'conversation-sessions-label': '可靠的 Hook 对话',
  'conversation-sessions-heading': '对话',
  'conversation-sessions-intro': '每一轮把 Claude Code UserPromptSubmit 提交的原始文字与同一 prompt 的最终 Stop 回复配对；工具循环 API 请求不会再伪装成用户轮次。session/prompt 标识只保存设备绑定的 HMAC。',
  'conversation-session-heading': '对话',
  'conversation-session-open': '打开对话',
  'conversation-session-open-turn': '打开本轮',
  'conversation-session-turn-count': '轮次数',
  'conversation-session-first-at': '首次提问',
  'conversation-session-last-at': '最近活动',
  'conversation-session-latest-preview': '轮次预览',
  'conversation-session-total-matches': '个匹配对话',
  'conversation-session-no-results': '没有符合当前筛选条件的可靠对话。',
  'conversation-session-pagination-hint': '对话按最近活动时间从新到旧排列。',
  'conversation-session-filter-hint': '筛选只匹配 Hook 支持的可靠用户轮次；API 片段请在诊断页单独搜索。',
  'conversation-session-search': '搜索对话',
  'conversation-session-filter-invalid': '一个或多个对话筛选值无效或过长。请清除筛选条件后重试。',
  'conversation-session-search-query-too-short': '搜索词对当前对话归档太短。大库中至少输入连续 3 个中文字符或更多可检索文字；请去掉单独特殊标点，并拆开查询。',
  'conversation-session-search-requires-indexed-terms': '对话搜索需要可建立索引的词。大库中请输入至少连续 3 个中文字符，去掉特殊标点，或拆开查询。',
  'conversation-session-search-error': '对话搜索无法完成。',
  'conversation-session-read-error': '对话无法载入。',
  'conversation-session-not-found': '找不到这个对话。',
  'conversation-session-back': '返回对话列表',
  'conversation-session-detail-intro': '以下轮次按同一 Claude Code session 的提问顺序排列；每个面板把 UserPromptSubmit 与同一 prompt 的 Stop 终态配对。原始标识不入库，设备上报也不等于真人身份认证。',
  'conversation-session-turn': '轮',
  'conversation-session-incomplete-turn': '这个 API 轮次结束时，尚未捕获到完整的助手回复。',
  'conversation-session-truncated-turn': '助手正文达到有界上限，当前捕获内容并不完整。',
  'conversation-session-empty-assistant': '未捕获助手正文。这个轮次可能包含工具活动，或者回复正文当时不可用。',
  'conversation-session-timeline-clipped': '时间线会缩短过长的助手正文；请打开对应单轮查看完整的已捕获文本。',
  'conversation-session-truncated': '此对话超过时间线的有界预算；仅显示最早的连续前缀（最多 200 轮、8 MiB 已存文本），完整正文可逐轮打开查看。',
  'conversation-session-empty': '这个对话中没有可显示的可靠轮次。',
  'conversation-legacy-fragments-heading': '保留用于诊断的旧 API 片段',
  'conversation-legacy-fragments-notice': '这些旧行来自单个 API 请求，不是用户回合，系统绝不会按时间把它们猜测成对话。',
  'conversation-legacy-fragments-link': '打开 API 片段诊断',
  'conversation-round-privacy-heading': '可靠对话隐私告知',
  'conversation-round-privacy-notice': '启用 Hook 的 Claude Code profile 会把客户端提交的原始提问与最终显示的助手回复永久发送到本控制台，并向所有控制台成员公开。Hook 不会拒绝或终止 Claude，但同步命令 Hook 失败时可能产生有界延迟。数据由设备上报，网关不认证真人身份；Codex 流量不在范围内。',
  'conversation-round-empty-heading': '还没有可靠的用户轮次',
  'conversation-round-empty-copy': '安装 Claude Code 对话采集更新后，UserPromptSubmit 与 Stop 才会组成可靠对话。现有 API 片段只保留在诊断页，绝不会被猜测归组。',
  'conversation-round-install-hooks': '安装对话采集更新',
  'conversation-user-message': '用户提交的消息',
  'conversation-final-response': '最终回复',
  'conversation-hook-prompt-disclaimer': '直接取自 Claude Code UserPromptSubmit，是客户端提交的原始文字；但设备上报不等于真人身份认证。',
  'conversation-prompt-source-hook': '来源：Claude Code UserPromptSubmit Hook',
  'conversation-round-prompt-at': '提问时间',
  'conversation-round-pending': '已收到提问，正在等待最终 Stop Hook。',
  'conversation-round-failed': 'Claude Code 报告本轮失败。',
  'conversation-round-unavailable': '提问已保留，但 session 结束前没有收到最终回复 Hook。',
  'conversation-round-response-pending': '正在等待最终回复。',
  'conversation-round-empty-response': '本轮没有上报最终助手文字。',
  'conversation-round-prompt-truncated': '提问超过存储上限；仅保留完整 UTF-8 前缀。',
  'conversation-round-response-truncated': '最终回复超过存储上限；仅保留完整 UTF-8 前缀。',
  'conversation-round-not-found': '找不到这条可靠对话轮次。',
  'conversation-round-read-error': '对话轮次无法载入。',
  'conversation-round-label': '可靠用户轮次',
  'conversation-failure-rate-limit': '受到速率限制',
  'conversation-failure-overloaded': '服务商负载过高',
  'conversation-failure-authentication-failed': '认证失败',
  'conversation-failure-oauth-org-not-allowed': '当前组织不允许使用',
  'conversation-failure-billing-error': '计费状态错误',
  'conversation-failure-invalid-request': '请求无效',
  'conversation-failure-model-not-found': '找不到模型',
  'conversation-failure-server-error': '服务商服务器错误',
  'conversation-failure-max-output-tokens': '已达到最大输出长度',
  'conversation-failure-session-end': 'Session 在最终回复前结束',
  'conversation-failure-unavailable': '回复不可用',
  'conversation-failure-unknown': '未知失败',
  'conversation-standalone-heading': '未归组的已捕获轮次',
  'conversation-standalone-notice': '这些旧轮次或无法关联的 API 轮次没有格式校验通过的会话标识，系统绝不会按时间猜测归组。',
  'conversation-standalone-link': '查看未归组轮次和全部已捕获 API 轮次',
  'conversation-privacy-heading': 'API 片段隐私告知',
  'conversation-privacy-notice': '此诊断归档会永久保存有界的 Claude API 请求/响应片段。它们可能包含客户端包装、提醒或工具中间态，不是经过验证的人类对话；所有控制台成员都可读取。Codex 流量不在范围内。',
  'conversation-open-warning': 'Open 模式：tailnet 中任何能访问本控制台的人都可以读取所有对话与 API 片段；没有身份识别，也没有阅读审计。成员标签不代表操作人身份。',
  'conversation-search': '搜索已捕获 API 轮次',
  'conversation-search-submit': '搜索',
  'conversation-search-clear': '清除',
  'conversation-next-page': '下一页',
  'conversation-filters-heading': '筛选条件',
  'conversation-filter-hint': '输入文字可搜索成员建议；留空表示全部成员。',
  'conversation-filter-period-label': '时间范围',
  'conversation-filter-member-label': '成员',
  'conversation-filter-device-label': '设备',
  'conversation-filter-account-label': '账号',
  'conversation-filter-model-label': '模型',
  'conversation-filter-state-label': '回复状态',
  'conversation-filter-limit-label': '每页行数',
  'conversation-period-all': '全部时间',
  'conversation-period-24': '最近 24 小时',
  'conversation-period-168': '最近 7 天',
  'conversation-period-720': '最近 30 天',
  'conversation-all-members': '全部成员',
  'conversation-all-devices': '全部设备',
  'conversation-all-accounts': '全部账号',
  'conversation-all-models': '全部模型',
  'conversation-all-states': '全部回复状态',
  'conversation-total-matches': '条匹配 API 片段',
  'conversation-pagination-hint': 'API 片段按最新时间优先排列。',
  'conversation-facets-truncated': '部分筛选值未列出；当前选中的值仍然可用。',
  'conversation-filter-query': '查询',
  'conversation-filter-period': '时间',
  'conversation-filter-member': '成员',
  'conversation-filter-device': '设备',
  'conversation-filter-account': '账号',
  'conversation-filter-model': '模型',
  'conversation-filter-state': '状态',
  'conversation-device': '设备',
  'conversation-open': '打开 API 片段',
  'conversation-no-results': '没有符合此搜索条件的 API 片段。',
  'conversation-search-error': 'API 轮次搜索无法完成。',
  'conversation-search-query-too-short': '搜索词对当前 API 轮次归档太短。大库中至少输入连续 3 个中文字符或更多可检索文字；请去掉单独特殊标点，并拆开查询。',
  'conversation-search-requires-indexed-terms': 'API 轮次搜索需要可建立索引的词。大库中请输入至少连续 3 个中文字符，去掉特殊标点，或拆开查询。',
  'conversation-filter-invalid': '一个或多个 API 轮次筛选值无效或过长。请清除筛选条件后重试。',
  'conversation-read-error': '已捕获 API 轮次无法载入。',
  'conversation-not-found': '找不到这条已捕获 API 轮次。',
  'conversation-detail-heading': 'API 片段',
  'conversation-back': '返回 API 片段诊断',
  'conversation-unknown-id': 'API 片段',
  'conversation-captured-at': '捕获时间',
  'conversation-member-label': '成员标签',
  'conversation-account': '账号',
  'conversation-model': '模型',
  'conversation-prompt': '已捕获的 API 用户文本',
  'conversation-prompt-disclaimer': '文本取自 API 最后一条 user 消息，可能包含 Claude Code 或其他客户端包装，不保证就是用户原话。',
  'conversation-prompt-source-captured': '来源：捕获的 API 用户文本',
  'conversation-prompt-source-wrapper': '来源：已去除可识别的客户端包装',
  'conversation-prompt-source-fallback': '来源：捕获原文（未识别包装，采用安全备用显示）',
  'conversation-prompt-source-empty': '来源：不可用',
  'conversation-prompt-suffix-omitted': '当前显示已省略有界尾部；被省略的文本不会显示。',
  'conversation-response': '回复',
  'conversation-empty-prompt': '未捕获 API 用户文本',
  'conversation-empty-response': '未捕获回复正文',
  'conversation-queue-dropped': '有 API 轮次采集任务被有界队列丢弃。',
  'conversation-round-dropped': '有可靠对话轮次未能写入持久化存储。',
  'conversation-response-complete': '回复完整',
  'conversation-response-pending': '等待回复',
  'conversation-response-failed': '本轮失败',
  'conversation-response-incomplete': '回复不完整',
  'conversation-response-truncated': '回复已截断',
  'conversation-response-unavailable': '回复不可用',
  'conversation-hook-upgrade-heading': '为现有 Claude profile 启用可靠对话',
  'conversation-hook-upgrade-copy': '这个不含 Token 的更新器会保留现有设置并安装同步 Claude Code 命令 Hook。它只在发送事件时读取 profile 已有的 mode-600 设备 Token；不会登录、轮换、打印或替换任何凭证。',
  'conversation-hook-upgrade-privacy': '安装后，本控制台会永久保存 Claude 用户提交的提示词与最终可见助手回复，并向所有控制台成员公开。Hook 不会拒绝或终止 Claude，但同步命令 Hook 失败时可能产生有界延迟。',
  'conversation-hook-version-note': '可靠配对要求 Claude Code 2.1.196 或更高版本；旧版本没有形成可靠轮次所需的 prompt ID。',
  'conversation-hook-download': '下载 Hook 更新器',
  'conversation-hook-copy': '复制更新器源码',
  'conversation-hook-run-heading': '在本机对每个已安装 profile 各运行一次',
  'conversation-hook-restart-note': '更新完成后重启 Claude Code。Hook 失败不会拒绝或终止 Claude，但同步命令 Hook 失败时可能增加有界延迟；其他投递失败会静默退出。',
  'conversation-hook-installer-privacy': '此 profile 会在控制台永久保存 Claude 用户提交的提示词与最终可见助手回复，所有控制台成员均可读取。Hook 不会拒绝或终止 Claude，也不会修改设备 Token，但同步命令 Hook 失败时可能产生有界延迟。',
  'choose-codex-platform': '选择这台设备的操作系统',
  'codex-profile-ready': '此安装器会新增一个隔离的 Codex profile，不会修改默认的 ~/.codex 账号。',
  'one-platform-only': '请只在刚登记的这台设备上选择一种安装器使用，不要把这些脚本复用到其他机器。',
  'view-script': '查看脚本',
  'one-time-token': '此单文件脚本包含仅属于当前设备的 token，只显示一次；运行时不需要访问内网控制台。请限制为仅自己可读，并在安装成功后删除。',
  'download-installer': '下载安装脚本',
  'copy-installer': '复制安装脚本',
  'run-instructions': '运行方法',
  'back-dashboard': '返回控制台',
  'claude-copy-now': '立即复制或下载此配置',
  'claude-one-time-token': '此设备 token 只显示一次，之后无法从控制台恢复。启动器只会将它注入 Claude Code 的显式网关模式，并由 Claude Code 从子进程环境中清除，因此不要求本机安装沙箱软件。丢失时请重新登记，并在使用后删除下载的安装器。',
  'download-unix-setup': '下载 macOS/Linux 配置',
  'copy-unix-setup': '复制 macOS/Linux 配置',
  'download-windows-setup': '下载 PowerShell 配置',
  'copy-windows-setup': '复制 PowerShell 配置',
  'closing-hides-token': '关闭或刷新本页后，凭据将永久隐藏。',
  'do-not-codex-login': '安装后不要运行 codex login。代理会写入订阅凭据并自动更新。',
  'enroll-heading': '登记设备',
  'create-device-credential': '创建设备凭据',
  'device-scope-note': '生成的凭据仅属于此设备，可单独撤销而不影响其他人。',
  // Read by name from the copy button below, not through a data-i18n attribute.
  'copied': '已复制',
  'revoke': '撤销',
  'enroll-device': '登记设备',
  'delete-account': '删除账号',
  'existing-codex-agent': '现有 Codex 代理',
  'status-healthy': '健康',
  'status-unhealthy': '异常',
  'status-expired': '已过期',
  'status-invalid': '无效',
  'status-unavailable': '不可用',
  'status-stored': '已保存',
  'status-login-required': '需要登录',
  'status-pending': '等待中',
  'credential-health-heading': '凭据健康度',
  'credential-health-intro': '来自安全公开元数据的实时凭据状态。',
  'credential-critical-label': '个严重问题',
  'credential-warning-label': '个警告',
  'credential-all-clear-badge': '一切正常',
  'credential-all-clear': '没有活跃的凭据警报。',
  'credential-no-accounts': '尚未登记提供商账号。',
  'credential-alert-more': '更多凭据警报见下方账号表。',
  'credential-severity-critical': '严重',
  'credential-severity-warning': '警告',
  'credential-severity-neutral': '处理中',
  'credential-severity-ok': '正常',
  'credential-alert-current-invalid': '当前 Codex 凭据元数据无效。',
  'credential-alert-current-unavailable': '当前 Codex 凭据无法读取。',
  'credential-alert-access-expired': '凭据已过期。',
  'credential-alert-access-expires-24h': '凭据将在 24 小时内过期。',
  'credential-alert-access-expires-3d': '凭据将在 3 天内过期。',
  'credential-alert-access-expires-7d': '凭据将在 7 天内过期。',
  'credential-alert-credential-unavailable': '凭据当前不可用。',
  'credential-alert-health-missing': '刷新健康快照缺失。',
  'credential-alert-health-invalid': '刷新健康快照无效。',
  'credential-alert-health-unavailable': '刷新健康快照暂时无法读取。',
  'credential-alert-health-stale': '刷新健康快照已过时。',
  'credential-alert-refresh-failed': '最近一次凭据刷新失败。',
  'credential-alert-refresh-quarantined': '凭据刷新已进入隔离状态。',
  'credential-alert-refresh-stuck': '凭据刷新周期运行时间过长。',
  'credential-alert-refreshing': '凭据刷新正在进行中。',
  'credential-alert-persist': '凭据刷新持久化失败。',
  'credential-alert-persist-failed': '凭据刷新持久化失败。',
  'credential-alert-publish': '凭据发布失败。',
  'credential-alert-publish-failed': '凭据发布失败。',
  'credential-alert-read-failed': '凭据状态读取失败。',
  'credential-alert-unreadable': '凭据状态不可读。',
  'credential-alert-unhandled': '凭据刷新发生未处理故障。',
  'credential-alert-operation-blocked': '凭据刷新操作被阻止。',
  'credential-alert-configuration-invalid': '凭据刷新配置无效。',
  'credential-alert-quarantine': '凭据刷新已隔离。',
  'credential-alert-provider-rejected': '提供商拒绝了凭据刷新。',
  'credential-alert-timeout': '凭据刷新超时。',
  'credential-alert-pre-mint-rejected': '凭据刷新在签发前被拒绝。',
  'credential-alert-account-unhealthy': '账号当前不健康。',
  'credential-alert-login-required': '需要完成账号登录。',
  'credential-alert-pending': '账号仍在等待授权。',
  'expires-unknown': '不可用',
  'expires-in': '将在',
  'expires-ago': '已过期',
  'last-successful-check': '最近成功凭据检查',
  'last-rotation': '最近轮换',
  'credential-history': '凭证历史',
  'accounts-table-caption': '账号及安全健康元数据'
};

const LANGUAGE_STORAGE_KEY = 'credential_console_language';
const LANGUAGE_UPDATED_STORAGE_KEY = 'credential_console_language_updated_at';
const LANGUAGE_COOKIE = 'credential_console_language';

function languageCookie() {
  try {
    for (const entry of document.cookie.split(';')) {
      const index = entry.indexOf('=');
      if (index < 1 || entry.slice(0, index).trim() !== LANGUAGE_COOKIE) continue;
      const value = decodeURIComponent(entry.slice(index + 1).trim());
      const parts = value.split('.');
      if (parts.length > 2 || (parts[0] !== 'zh' && parts[0] !== 'en')) return null;
      if (parts[1] !== undefined && !/^[0-9]{1,16}$/.test(parts[1])) return null;
      const updatedAt = Number(parts[1] ?? 0);
      return {
        language: parts[0],
        updatedAt: Number.isSafeInteger(updatedAt) && updatedAt >= 0 ? updatedAt : 0,
      };
    }
  } catch {
    // Cookies can be unavailable in sandboxed or hardened browser contexts.
  }
  return null;
}

function localLanguage() {
  try {
    const language = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (language !== 'zh' && language !== 'en') return null;
    const updatedAt = Number(localStorage.getItem(LANGUAGE_UPDATED_STORAGE_KEY) ?? 0);
    return {
      language,
      updatedAt: Number.isSafeInteger(updatedAt) && updatedAt >= 0 ? updatedAt : 0,
    };
  } catch {
    return null;
  }
}

function storedLanguage() {
  const local = localLanguage();
  const cookie = languageCookie();
  if (local && cookie) {
    // Timestamped writes resolve partial/silently ignored browser storage. A
    // tie keeps the legacy localStorage preference for backward compatibility.
    return cookie.updatedAt > local.updatedAt ? cookie.language : local.language;
  }
  if (local) return local.language;
  if (cookie) return cookie.language;
  return String(navigator.language ?? '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

function persistLanguage(language) {
  const updatedAt = Date.now();
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
    localStorage.setItem(LANGUAGE_UPDATED_STORAGE_KEY, String(updatedAt));
  } catch {
    // Cookie fallback still applies.
  }
  try {
    document.cookie = LANGUAGE_COOKIE + '=' + encodeURIComponent(language + '.' + updatedAt)
      + '; Path=/; Max-Age=31536000; SameSite=Strict';
  } catch {
    // A language preference is optional; never break the rest of the UI.
  }
}

function currentLanguage() {
  return document.documentElement.lang === 'zh-CN' ? 'zh' : 'en';
}

// Translate one subtree. Needed as a unit because results are re-rendered in
// place: freshly inserted nodes carry data-i18n and would otherwise stay English
// on a Chinese page.
function translateSubtree(root, selected) {
  root.querySelectorAll('[data-i18n]').forEach((element) => {
    if (!element.dataset.i18nEn) element.dataset.i18nEn = element.textContent;
    element.textContent = selected === 'zh'
      ? (translations[element.dataset.i18n] ?? element.dataset.i18nEn)
      : element.dataset.i18nEn;
  });
  root.querySelectorAll('[data-placeholder-en]').forEach((element) => {
    element.placeholder = selected === 'zh'
      ? (element.dataset.placeholderZh ?? element.dataset.placeholderEn)
      : element.dataset.placeholderEn;
  });
}
function applyLanguage(language) {
  const selected = language === 'zh' ? 'zh' : 'en';
  document.documentElement.lang = selected === 'zh' ? 'zh-CN' : 'en';
  translateSubtree(document, selected);
  translateElementsIn(document, selected);
  document.querySelectorAll('[data-language]').forEach((button) => {
    button.classList.toggle('active', button.dataset.language === selected);
    button.setAttribute('aria-pressed', button.dataset.language === selected ? 'true' : 'false');
  });
  persistLanguage(selected);
  document.documentElement.removeAttribute('data-language-pending');
  window.dispatchEvent(new CustomEvent('credential-console-language', { detail: { language: selected } }));
}

/**
 * Element-level translation that is not a plain data-i18n text swap.
 *
 * Split out because navigation re-renders a page inside the live document: a
 * pass scoped to the whole document at load time leaves anything arriving later
 * in English, which is how account status labels reverted after a tab switch.
 */
function translateElementsIn(root, selected) {
  root.querySelectorAll('[data-account-option], [data-account-label]').forEach((element) => {
    const alias = element.dataset.accountAlias ?? '';
    const status = element.dataset.accountStatus ?? '';
    const key = 'status-' + status.replaceAll('_', '-');
    const englishStatus = status.replaceAll('_', ' ');
    element.textContent = alias + ' · '
      + (selected === 'zh' ? (translations[key] ?? englishStatus) : englishStatus);
  });

  root.querySelectorAll('[data-metric-point-title]').forEach((element) => {
    if (!element.dataset.metricPointTitleEn) element.dataset.metricPointTitleEn = element.textContent;
    const key = element.dataset.metricSeriesKey ?? '';
    const tail = element.dataset.metricPointTail ?? '';
    element.textContent = selected === 'zh'
      ? (translations[key] ?? element.dataset.metricPointTitleEn.split(' · ')[0]) + ' · ' + tail
      : element.dataset.metricPointTitleEn;
  });

  root.querySelectorAll('[data-account-switch-status][data-account-switch-result]').forEach((node) => {
    renderAccountSwitchStatus(node, node.dataset.accountSwitchResult, node.dataset.accountAlias ?? '');
  });
}

applyLanguage(storedLanguage());

function sessionStateGet(key) {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function sessionStateSet(key, value) {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // State restoration is progressive enhancement only.
  }
}

function sessionStateRemove(key) {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // State restoration is progressive enhancement only.
  }
}

// Recomputed per access: navigation changes the page without reloading, and a
// key captured at load time anchored every scroll position, draft and details
// state to whichever page happened to be opened first.
function pageStateKeyFor() {
  const url = new URL(location.href);
  url.searchParams.delete('draft_completed');
  return url.pathname + url.search;
}
const conversationFilterMedia = window.matchMedia?.('(max-width: 800px)');
const metricsFilterMedia = window.matchMedia?.('(max-width: 640px)');

function detailsStateKey(details) {
  return 'credential_console_details:' + pageStateKeyFor() + ':' + details.dataset.persistDetails;
}

function forcedDesktopFilter(details) {
  return (details.classList.contains('conversation-filter-details')
      && conversationFilterMedia && !conversationFilterMedia.matches)
    || (details.classList.contains('metrics-filter-details')
      && metricsFilterMedia && !metricsFilterMedia.matches);
}

function mobileFilterDefault(details) {
  return (details.classList.contains('conversation-filter-details')
      && conversationFilterMedia?.matches)
    || (details.classList.contains('metrics-filter-details')
      && metricsFilterMedia?.matches);
}

function restoreDetails(details) {
  const stored = sessionStateGet(detailsStateKey(details));
  if (forcedDesktopFilter(details)) details.open = true;
  else if (stored === 'open' || stored === 'closed') details.open = stored === 'open';
  else if (mobileFilterDefault(details)) details.open = false;
}

document.querySelectorAll('details[data-persist-details]').forEach((details) => {
  restoreDetails(details);
  details.addEventListener('toggle', () => {
    // Desktop filter rails are forced open by layout. Do not let that
    // temporary presentation overwrite the member's mobile preference.
    if (!forcedDesktopFilter(details)) {
      sessionStateSet(detailsStateKey(details), details.open ? 'open' : 'closed');
    }
  });
});

function syncResponsiveDetails(selector) {
  document.querySelectorAll(selector).forEach(restoreDetails);
}
conversationFilterMedia?.addEventListener?.('change', () => {
  syncResponsiveDetails('.conversation-filter-details[data-persist-details]');
});
metricsFilterMedia?.addEventListener?.('change', () => {
  syncResponsiveDetails('.metrics-filter-details[data-persist-details]');
});

const SAFE_DRAFT_FIELDS = new Set([
  'account_id',
  'alias',
  'device_name',
  'email_label',
  'member_label',
]);
const SAFE_DRAFT_KEYS = new Set([
  'claude-self-service',
  'codex-self-service',
  'register-claude-account',
  'register-codex-account',
]);

const completedDraft = document.documentElement.dataset.completedDraft ?? '';
if (SAFE_DRAFT_KEYS.has(completedDraft)) {
  sessionStateRemove('credential_console_draft:/:' + completedDraft);
  try {
    const canonical = new URL(location.href);
    if (canonical.searchParams.get('draft_completed') === completedDraft) {
      canonical.searchParams.delete('draft_completed');
      history.replaceState(history.state, '', canonical.pathname + canonical.search + canonical.hash);
    }
  } catch {
    // The draft is already cleared; URL cleanup is cosmetic.
  }
}

function formDraftKey(form) {
  return 'credential_console_draft:' + location.pathname + ':' + form.dataset.persistDraft;
}

function formDraftFields(form) {
  return [...form.querySelectorAll('[data-draft-field][name]')]
    .filter((field) => SAFE_DRAFT_FIELDS.has(field.name));
}

function saveFormDraft(form) {
  const values = {};
  formDraftFields(form).forEach((field) => {
    values[field.name] = String(field.value ?? '').slice(0, 256);
  });
  sessionStateSet(formDraftKey(form), JSON.stringify(values));
}

function restoreFormDraft(form) {
  const stored = sessionStateGet(formDraftKey(form));
  if (!stored || stored.length > 4096) return;
  let values;
  try {
    values = JSON.parse(stored);
  } catch {
    return;
  }
  if (!values || typeof values !== 'object' || Array.isArray(values)) return;
  formDraftFields(form).forEach((field) => {
    if (typeof values[field.name] !== 'string') return;
    const value = values[field.name].slice(0, 256);
    if (field instanceof HTMLSelectElement
      && ![...field.options].some((option) => option.value === value)) return;
    field.value = value;
  });
}

function bindFormDrafts(root) {
  root.querySelectorAll('form[data-persist-draft]').forEach((form) => {
    restoreFormDraft(form);
    // Idempotent: hydrate runs again on every navigation, and a form that
    // survived one would otherwise accumulate a listener per visit.
    if (form.dataset.draftBound === 'true') return;
    form.dataset.draftBound = 'true';
    form.addEventListener('input', () => saveFormDraft(form));
    form.addEventListener('change', () => saveFormDraft(form));
  });
}

bindFormDrafts(document);

const scrollStateKeyFor = () => 'credential_console_scroll:' + pageStateKeyFor();
const skipScrollStateKeyFor = () => 'credential_console_skip_scroll:' + pageStateKeyFor();
const skipScrollRestore = sessionStateGet(skipScrollStateKeyFor()) === 'true';
if (skipScrollRestore) {
  sessionStateRemove(skipScrollStateKeyFor());
  sessionStateSet(scrollStateKeyFor(), '0');
}
const navigationType = performance.getEntriesByType?.('navigation')?.[0]?.type;
if (!skipScrollRestore && navigationType !== 'back_forward') {
  const savedScroll = Number(sessionStateGet(scrollStateKeyFor()));
  if (Number.isFinite(savedScroll) && savedScroll > 0) {
    requestAnimationFrame(() => requestAnimationFrame(() => window.scrollTo({ top: savedScroll })));
  }
}
window.addEventListener('pagehide', () => {
  sessionStateSet(scrollStateKeyFor(), String(Math.max(0, Math.round(window.scrollY))));
});

document.addEventListener('submit', (event) => {
  const form = event.target.closest?.('form[data-reset-scroll]');
  if (!form) return;
  try {
    const destination = new URL(form.action, location.href);
    if (String(form.method).toLowerCase() === 'get') {
      destination.search = new URLSearchParams(new FormData(form)).toString();
    }
    sessionStateSet(
      'credential_console_skip_scroll:' + destination.pathname + destination.search,
      'true',
    );
  } catch {
    // Navigation remains functional without scroll-state enhancement.
  }
});

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // HTTP-only private overlays are not always a secure browser context.
      // Fall through to a user-gesture copy that does not need Clipboard API.
    }
  }
  const fallback = document.createElement('textarea');
  fallback.value = text;
  fallback.setAttribute('readonly', '');
  fallback.style.position = 'fixed';
  fallback.style.opacity = '0';
  fallback.style.pointerEvents = 'none';
  document.body.appendChild(fallback);
  let copied = false;
  try {
    fallback.focus();
    fallback.select();
    copied = document.execCommand('copy');
  } finally {
    fallback.remove();
  }
  if (!copied) throw new Error('copy failed');
}

function translatedText(key, english) {
  return currentLanguage() === 'zh' ? (translations[key] ?? english) : english;
}

function safeAccountStatus(value) {
  const status = String(value ?? 'unavailable');
  return /^[a-z][a-z0-9_]{0,31}$/.test(status) ? status : 'unavailable';
}

function accountStatusText(status) {
  const key = 'status-' + status.replaceAll('_', '-');
  return translatedText(key, status.replaceAll('_', ' '));
}

function renderAccountSwitchStatus(node, state, alias = '') {
  if (!node) return;
  node.dataset.accountSwitchResult = state;
  node.dataset.accountAlias = alias;
  node.className = 'tiny account-switch-status';
  if (state === 'saved') {
    node.classList.add('success');
    node.textContent = translatedText('account-switch-saved', 'Switched to') + ' ' + alias;
  } else if (state === 'failed') {
    node.classList.add('error');
    node.textContent = translatedText(
      'account-switch-failed',
      'Switch failed without refreshing this page. Try again or reload.',
    );
  } else {
    node.textContent = translatedText('account-switch-working', 'Switching…');
  }
}

function updateAllowedAccounts(form, accounts) {
  const target = form.closest('[data-device-row]')?.querySelector('[data-allowed-account-list]');
  if (!target || !Array.isArray(accounts)) return;
  const fragment = document.createDocumentFragment();
  accounts.forEach((account, index) => {
    if (index > 0) fragment.append(document.createTextNode(', '));
    const span = document.createElement('span');
    const status = safeAccountStatus(account?.status);
    span.dataset.accountLabel = '';
    span.dataset.accountAlias = String(account?.alias ?? account?.id ?? '');
    span.dataset.accountStatus = status;
    span.textContent = span.dataset.accountAlias + ' · ' + accountStatusText(status);
    fragment.append(span);
  });
  if (!accounts.length) fragment.append(document.createTextNode('—'));
  target.replaceChildren(fragment);
}

function updateAccountOptions(form, accounts) {
  if (!Array.isArray(accounts)) return;
  const byId = new Map(accounts.map((account) => [String(account?.id ?? ''), account]));
  form.querySelectorAll('[data-account-option]').forEach((option) => {
    const account = byId.get(option.value);
    if (!account) return;
    option.dataset.accountAlias = String(account.alias ?? account.id ?? '');
    option.dataset.accountStatus = safeAccountStatus(account.status);
    option.textContent = option.dataset.accountAlias + ' · ' + accountStatusText(option.dataset.accountStatus);
  });
}

function updateAccountCounts(counts) {
  if (!Array.isArray(counts)) return;
  counts.forEach((entry) => {
    const id = String(entry?.id ?? '');
    const count = Number(entry?.active_devices);
    if (!id || !Number.isSafeInteger(count) || count < 0) return;
    document.querySelectorAll('[data-account-row]').forEach((row) => {
      if (row.dataset.accountRow !== id) return;
      const target = row.querySelector('[data-account-device-count]');
      if (target) target.textContent = String(count);
    });
  });
}

document.addEventListener('submit', async (event) => {
  const form = event.target.closest?.('form[data-account-switch]');
  if (!form || typeof fetch !== 'function' || typeof FormData !== 'function') return;
  event.preventDefault();
  if (form.dataset.submitting === 'true') return;
  const row = form.closest('[data-device-row]');
  const select = form.elements.selected_account_id;
  const button = form.querySelector('button[type="submit"]');
  const statusNode = form.querySelector('[data-account-switch-status]');
  const committedAccountId = row?.dataset.selectedAccountId ?? '';
  form.dataset.submitting = 'true';
  form.setAttribute('aria-busy', 'true');
  renderAccountSwitchStatus(statusNode, 'working');
  try {
    const submittedForm = new FormData(form);
    if (button) button.disabled = true;
    if (select) select.disabled = true;
    const body = new URLSearchParams();
    for (const [key, value] of submittedForm) body.append(key, String(value));
    const response = await fetch(form.action, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'X-Credential-Console-Async': 'account-switch',
      },
      body,
    });
    const contentType = response.headers.get('content-type') ?? '';
    const result = contentType.includes('application/json') ? await response.json() : null;
    if (!response.ok || result?.ok !== true || !result.account) throw new Error('account switch failed');
    const accountId = String(result.selected_account_id ?? '');
    const alias = String(result.account.alias ?? '');
    const accountStatus = safeAccountStatus(result.account.status);
    if (!accountId || !alias || accountId !== String(result.account.id ?? '')) {
      throw new Error('account switch response invalid');
    }
    if (row) row.dataset.selectedAccountId = accountId;
    if (select) select.value = accountId;
    const cell = row?.querySelector('[data-selected-account-cell]');
    if (cell) {
      cell.dataset.accountStatus = accountStatus;
      const aliasNode = cell.querySelector('[data-selected-account-alias]');
      if (aliasNode) aliasNode.textContent = alias;
      const statusTarget = cell.querySelector('[data-selected-account-status]');
      if (statusTarget) {
        const badge = document.createElement('span');
        badge.className = 'badge ' + accountStatus;
        badge.dataset.i18n = 'status-' + accountStatus.replaceAll('_', '-');
        badge.textContent = accountStatus.replaceAll('_', ' ');
        statusTarget.replaceChildren(badge);
      }
    }
    updateAllowedAccounts(form, result.allowed_accounts);
    updateAccountOptions(form, result.account_options);
    updateAccountCounts(result.account_device_counts);
    applyLanguage(currentLanguage());
    renderAccountSwitchStatus(statusNode, 'saved', alias);
  } catch {
    if (select && committedAccountId) select.value = committedAccountId;
    renderAccountSwitchStatus(statusNode, 'failed');
  } finally {
    form.dataset.submitting = 'false';
    form.removeAttribute('aria-busy');
    if (button) button.disabled = false;
    if (select) select.disabled = false;
  }
});

document.addEventListener('click', async (event) => {
  const languageButton = event.target.closest('[data-language]');
  if (languageButton) {
    applyLanguage(languageButton.dataset.language);
    return;
  }
  const button = event.target.closest('[data-copy-target]');
  if (button) {
    const target = document.getElementById(button.dataset.copyTarget);
    if (!target) return;
    await copyText(target.textContent);
    const previous = button.textContent;
    button.textContent = currentLanguage() === 'zh' ? translations.copied : 'Copied';
    setTimeout(() => { button.textContent = previous; }, 1600);
    return;
  }
  const download = event.target.closest('[data-download-target]');
  if (download) {
    const target = document.getElementById(download.dataset.downloadTarget);
    if (!target) return;
    const blob = new Blob([target.textContent], { type: 'text/plain;charset=utf-8' });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = download.dataset.downloadName;
    anchor.click();
    URL.revokeObjectURL(href);
  }
});

// ---------------------------------------------------------------------------
// Boosted navigation
//
// Tabs, sub-nav and detail links were full document loads. Over a ~207 ms round
// trip that means re-downloading and re-parsing the shell, the styles and the
// script to change the part of the page that actually differs.
//
// A click now fetches only the page region and swaps it into the existing
// document. Progressive enhancement throughout: anything unexpected falls back
// to the navigation the browser would have done anyway.
// ---------------------------------------------------------------------------

function navigationSupported() {
  return typeof window.fetch === 'function'
    && typeof window.AbortController === 'function'
    && typeof history.pushState === 'function';
}

/** Scripts the shell loads lazily, e.g. the metrics bundle on /metrics only. */
function ensureScripts(descriptors) {
  const present = new Set(
    Array.from(document.querySelectorAll('script[src]')).map((s) => s.src),
  );
  return Promise.all(descriptors
    .filter((d) => d && d.src && !present.has(new URL(d.src, location.href).href))
    .map((d) => new Promise((resolve) => {
      const script = document.createElement('script');
      script.src = d.src;
      if (d.integrity) script.integrity = d.integrity;
      if (d.crossorigin) script.crossOrigin = d.crossorigin;
      script.defer = true;
      // Never block navigation on an asset that fails to load.
      script.onload = resolve;
      script.onerror = resolve;
      document.head.appendChild(script);
    })));
}

/**
 * Re-run everything the document sets up once, against freshly inserted markup.
 *
 * Navigation swaps a page in without reloading, so anything bound at load time
 * simply stops existing for the new content. Picking initialisers by hand is
 * what silently broke form drafts, collapsed-filter memory and account status
 * translation after a tab switch; this is the single place to add to.
 */
function hydrate(root, activeTab) {
  const language = currentLanguage();
  translateSubtree(root, language);
  translateElementsIn(root, language);
  stampTableCardLabels(root);
  bindFormDrafts(root);
  root.querySelectorAll('details[data-persist-details]').forEach(restoreDetails);
  if (activeTab) markActiveTab(activeTab);
}

let navigationRequest = null;

async function navigateTo(url, { push = true, samePage: samePageOverride = null } = {}) {
  const region = document.querySelector('[data-page-content]');
  if (!region) return false;

  // Explicit when the caller knows: on popstate `location` has already moved to
  // the destination, so inferring from it always says "same page" and the
  // focus, scroll and announcement branches never run for Back/Forward.
  const samePage = samePageOverride ?? (new URL(url, location.href).pathname === location.pathname);

  navigationRequest?.abort();
  const controller = new AbortController();
  navigationRequest = controller;

  document.documentElement.setAttribute('data-navigating', '');
  try {
    const response = await fetch(url, {
      headers: { 'X-Fragment': 'page' },
      credentials: 'same-origin',
      signal: controller.signal,
      redirect: 'follow',
    });
    // A redirect to a different page (login, error) is a real navigation.
    if (!response.ok || new URL(response.url).pathname !== new URL(url, location.href).pathname) {
      return false;
    }
    const html = await response.text();
    const title = decodeURIComponent(response.headers.get('X-Page-Title') ?? '');

    region.innerHTML = html;
    if (title) document.title = title;
    if (push) history.pushState({ boosted: true }, '', url);

    // The shell stays, so anything the shell set up for the old page has to be
    // re-applied to the new one.
    hydrate(region, response.headers.get('X-Active-Tab') || '');

    let scripts = [];
    try {
      scripts = JSON.parse(decodeURIComponent(response.headers.get('X-Page-Scripts') ?? '[]'));
    } catch {
      scripts = [];
    }
    await ensureScripts(scripts);
    // Tell page-specific scripts (the metrics dashboard) to bind to the new DOM.
    window.dispatchEvent(new CustomEvent('credential-console-navigated', {
      detail: { url: String(url) },
    }));

    // Only a real change of page starts at the top. Re-running a filter on the
    // page you are already reading is not a new page, and throwing the reader
    // back to the top is exactly what made the old full reload unpleasant.
    if (!samePage) {
      window.scrollTo({ top: 0 });
      const heading = document.querySelector('[data-page-content] h1');
      if (heading) {
        heading.setAttribute('tabindex', '-1');
        heading.focus({ preventScroll: true });
      }
    }
    return true;
  } catch (error) {
    return Boolean(error && error.name === 'AbortError');
  } finally {
    // Only the newest navigation clears the indicator: a superseded one used to
    // switch it off while its replacement was still in flight, so the page sat
    // looking idle on stale content.
    if (navigationRequest === controller) {
      navigationRequest = null;
      document.documentElement.removeAttribute('data-navigating');
    }
  }
}

const TAB_HREF_BY_NAME = { overview: '/', metrics: '/metrics', conversations: '/conversations' };

function markActiveTab(activeTab) {
  // The server names the section; the client does not infer it. /conversations
  // and /conversation-turns are siblings, so no path rule relates them, and an
  // exact-match guess silently removed a highlight that was already correct.
  const href = TAB_HREF_BY_NAME[activeTab];
  const nav = document.querySelector('.page-tabs');
  if (!nav) return;
  // The bar lives outside the swapped region, so a page the server renders
  // without one — an enrolment landing page, say — would otherwise inherit the
  // bar from wherever the reader came from and disagree with its own reload.
  nav.hidden = !href;
  if (!href) return;
  nav.querySelectorAll('a').forEach((link) => {
    if (link.getAttribute('href') === href) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
}

function boostableLink(event) {
  if (event.defaultPrevented) return null;
  // Let the browser handle anything the user asked to open differently.
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  const link = event.target.closest?.('a[href]');
  if (!link) return null;
  if (link.target && link.target !== '_self') return null;
  if (link.hasAttribute('download') || link.dataset.noBoost !== undefined) return null;
  let url;
  try {
    url = new URL(link.getAttribute('href'), location.href);
  } catch {
    return null;
  }
  if (url.origin !== location.origin) return null;
  // A same-page anchor is the browser's job.
  if (url.pathname === location.pathname && url.hash) return null;
  return url;
}

if (navigationSupported()) {
  document.addEventListener('click', (event) => {
    const url = boostableLink(event);
    if (!url) return;
    event.preventDefault();
    navigateTo(url.href).then((handled) => {
      if (!handled) location.assign(url.href);
    });
  });

  // A GET form is a navigation with a query string, so it goes through the same
  // path as a link. This is what makes /metrics filtering cost one fragment
  // instead of a document, its script and its chart payload in series.
  document.addEventListener('submit', (event) => {
    if (event.defaultPrevented) return;
    const form = event.target.closest?.('form');
    if (!form || String(form.method).toLowerCase() !== 'get') return;
    if (form.dataset.noBoost !== undefined) return;
    let action;
    try {
      action = new URL(form.action, location.href);
    } catch {
      return;
    }
    if (action.origin !== location.origin) return;
    if (!document.querySelector('[data-page-content]')) return;

    const submitter = event.submitter;
    const params = new URLSearchParams(new FormData(form));
    if (submitter && submitter.name) params.set(submitter.name, submitter.value ?? '');
    action.search = params.toString();

    event.preventDefault();
    navigateTo(action.href).then((handled) => {
      if (!handled) location.assign(action.href);
    });
  });

  window.addEventListener('popstate', (event) => {
    if (!event.state?.boosted && !document.querySelector('[data-page-content]')) return;
    navigateTo(location.href, { push: false, samePage: false }).then((handled) => {
      if (!handled) location.reload();
    });
  });

  // So the first Back after a boosted navigation returns here rather than
  // leaving the console.
  history.replaceState({ boosted: true }, '', location.href);
}

// ---------------------------------------------------------------------------
// In-place conversation results
//
// Filtering and paging used to be full navigations. Over the ~207 ms round trip
// to a remote console that meant re-sending and re-parsing the entire document
// for a list that is a few KB. The same request now asks for just the results
// region and swaps it in.
//
// Strictly progressive enhancement: without scripting, or if anything here
// fails, the form performs its normal POST and the server returns a full page
// from the identical code path.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Card labels for wide tables on narrow screens
//
// Below 720px the account and metrics tables render as cards, one labelled row
// per cell. The label is copied from the header cell rather than written into
// the markup, so it is whatever the header currently says — which means it
// follows the language switch instead of being frozen in English at render
// time. Setting display:block on table elements also drops their implicit
// semantics, so the roles are restored explicitly.
// ---------------------------------------------------------------------------

const CARD_TABLE_SELECTOR = '.table-wrap table, .metrics-table';

function stampTableCardLabels(root) {
  root.querySelectorAll?.(CARD_TABLE_SELECTOR).forEach((table) => {
    const headers = Array.from(table.querySelectorAll('thead th'))
      .map((cell) => cell.textContent.trim());
    if (!headers.length) return;

    table.setAttribute('role', 'table');
    table.querySelectorAll('thead, tbody').forEach((group) => group.setAttribute('role', 'rowgroup'));
    table.querySelectorAll('tr').forEach((row) => row.setAttribute('role', 'row'));
    table.querySelectorAll('thead th').forEach((cell) => cell.setAttribute('role', 'columnheader'));

    table.querySelectorAll('tbody tr').forEach((row) => {
      Array.from(row.children).forEach((cell, index) => {
        cell.setAttribute('role', 'cell');
        // A colspan cell (the empty-state row) spans every column, so no single
        // header describes it.
        const spans = Number(cell.getAttribute('colspan') ?? 1) > 1;
        const label = headers[index];
        if (spans || !label) {
          cell.removeAttribute('data-label');
          return;
        }
        cell.dataset.label = label;
      });
    });
  });
}

stampTableCardLabels(document);
// Re-stamp after a language switch so the labels are translated too.
window.addEventListener('credential-console-language', () => stampTableCardLabels(document));

const CONVERSATION_RESULT_ACTIONS = new Set(['/conversations', '/conversation-turns']);

function conversationFragmentSupported() {
  return typeof window.fetch === 'function'
    && typeof window.FormData === 'function'
    && typeof window.URLSearchParams === 'function'
    && typeof window.AbortController === 'function';
}

// A live region that survives every swap, so announcements are content changes
// inside a node the screen reader is already watching.
function conversationAnnouncer() {
  let node = document.getElementById('conversation-live-status');
  if (node) return node;
  node = document.createElement('p');
  node.id = 'conversation-live-status';
  node.className = 'visually-hidden';
  node.setAttribute('role', 'status');
  node.setAttribute('aria-live', 'polite');
  document.body.appendChild(node);
  return node;
}

function announceConversationResults(region) {
  const summary = region.querySelector('.conversation-result-summary strong');
  // Direct child only: every row also carries a `.empty tiny` placeholder for a
  // missing response, and `.conversation-list .empty` matched those first — so a
  // successful search announced "Not captured" instead of its result count.
  const empty = region.querySelector('.conversation-list > .empty');
  const raw = (empty ?? summary)?.textContent?.trim().replace(/\s+/g, ' ');
  if (!raw) return;
  // The count alone. Reading the whole summary bar dragged in the rows-per-page
  // options and the dashboard link, which is noise in a screen reader.
  const text = empty ? raw : `${raw} matches`;
  const node = conversationAnnouncer();
  // Re-setting identical text is not a change; nudge it so a repeat search
  // with the same result count is still announced.
  node.textContent = node.textContent === text ? text + ' ' : text;
}

let conversationRequest = null;

async function swapConversationResults(form, submitter) {
  const region = document.querySelector('.conversation-results');
  if (!region) return false;

  const action = new URL(form.action, location.href);
  if (!CONVERSATION_RESULT_ACTIONS.has(action.pathname)) return false;

  const body = new URLSearchParams(new FormData(form));
  // A submit button can carry the cursor for the next page; FormData omits it.
  if (submitter && submitter.name) body.set(submitter.name, submitter.value ?? '');

  // Only the newest filter matters; abandon whatever is still in flight.
  conversationRequest?.abort();
  const controller = new AbortController();
  conversationRequest = controller;

  region.setAttribute('aria-busy', 'true');
  region.classList.add('is-loading');
  try {
    const response = await fetch(action.pathname, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Fragment': 'conversation-results',
      },
      body: body.toString(),
      credentials: 'same-origin',
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const html = await response.text();

    const holder = document.createElement('div');
    holder.innerHTML = html;
    const replacement = holder.querySelector('.conversation-results');
    if (!replacement) return false;

    translateSubtree(replacement, currentLanguage());

    // Remember whether focus was inside the region we are about to remove.
    const paging = Boolean(submitter && submitter.closest('.conversation-pagination'));
    const hadFocus = region.contains(document.activeElement);

    // Put the applied filter in the address bar so it survives a refresh, is
    // reachable with Back, and can be shared. Replace rather than push: typing
    // into a search box should not bury the previous page under history
    // entries, one per keystroke.
    try {
      // A tab click may have landed while this filter was in flight. Writing the
      // filter URL then would replace that page's history entry and leave the
      // address bar describing a page the user is no longer on.
      if (location.pathname !== action.pathname) throw new Error('navigated away');
      const filtered = new URL(action.pathname, location.href);
      for (const [key, value] of body.entries()) {
        if (value !== '') filtered.searchParams.set(key, value);
      }
      const target = filtered.pathname + filtered.search;
      // Paging is a discrete decision and belongs in history, so Back returns to
      // the previous page of results. Filter edits replace, because otherwise a
      // search box would push one entry per keystroke.
      if (paging) history.pushState({ boosted: true }, '', target);
      else history.replaceState({ boosted: true }, '', target);
    } catch {
      // The address bar is a convenience; never fail the update over it.
    }

    region.replaceWith(replacement);

    // A live region only announces changes that happen *inside* it. Replacing
    // the region wholesale inserts a node with its content already present,
    // which screen readers treat as initial content and stay silent about — so
    // the announcement goes through a region that is never replaced.
    announceConversationResults(replacement);

    if (paging) {
      // The control that was clicked has just been removed from the document,
      // so focus would otherwise fall back to <body> and a keyboard user would
      // restart the tab order from the top of the page on every page turn.
      const next = replacement.querySelector('.conversation-pagination button')
        ?? replacement.querySelector('[id$="results-heading"]');
      if (next) {
        if (!next.hasAttribute('tabindex') && next.tagName !== 'BUTTON') {
          next.setAttribute('tabindex', '-1');
        }
        next.focus({ preventScroll: true });
      }
      replacement.scrollIntoView({ block: 'start', behavior: 'smooth' });
    } else if (hadFocus) {
      const heading = replacement.querySelector('[id$="results-heading"]');
      if (heading) {
        heading.setAttribute('tabindex', '-1');
        heading.focus({ preventScroll: true });
      }
    }
    return true;
  } catch (error) {
    // An aborted request was superseded on purpose; do not fall back to a
    // navigation that would undo the newer one.
    return error && error.name === 'AbortError';
  } finally {
    if (conversationRequest === controller) conversationRequest = null;
    region.removeAttribute('aria-busy');
    region.classList.remove('is-loading');
  }
}

// A discrete choice is a decision already made: applying it needs no second
// click. Free text is different — it is still being typed — so it settles
// briefly first. Either way an in-flight request is superseded, not queued.
let conversationFilterTimer = null;

function conversationFilterForm(node) {
  const form = node.form ?? node.closest?.('form');
  if (!form) return null;
  let action;
  try {
    action = new URL(form.action, location.href);
  } catch {
    return null;
  }
  return CONVERSATION_RESULT_ACTIONS.has(action.pathname) ? form : null;
}

function applyConversationFilter(form) {
  swapConversationResults(form, null).then((handled) => {
    if (!handled) form.submit();
  });
}

if (conversationFragmentSupported()) {
  document.addEventListener('change', (event) => {
    const node = event.target;
    if (!node?.matches?.('[data-autoapply]')) return;
    const form = conversationFilterForm(node);
    if (!form || !document.querySelector('.conversation-results')) return;
    clearTimeout(conversationFilterTimer);
    applyConversationFilter(form);
  });

  document.addEventListener('input', (event) => {
    const node = event.target;
    if (!node?.closest?.('.conversation-filters')) return;
    if (!node.matches('input[name="q"], input[name="member_label"]')) return;
    const form = conversationFilterForm(node);
    if (!form || !document.querySelector('.conversation-results')) return;
    clearTimeout(conversationFilterTimer);
    conversationFilterTimer = setTimeout(() => applyConversationFilter(form), 400);
  });
}

if (conversationFragmentSupported()) {
  document.addEventListener('submit', (event) => {
    if (event.defaultPrevented) return;
    const form = event.target.closest?.('form');
    if (!form) return;
    let action;
    try {
      action = new URL(form.action, location.href);
    } catch {
      return;
    }
    if (String(form.method).toLowerCase() !== 'post') return;
    if (!CONVERSATION_RESULT_ACTIONS.has(action.pathname)) return;
    if (!document.querySelector('.conversation-results')) return;

    event.preventDefault();
    swapConversationResults(form, event.submitter).then((handled) => {
      // Anything unexpected: let the browser do what it would have done.
      if (!handled) form.submit();
    });
  });
}
