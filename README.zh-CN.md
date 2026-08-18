# claude-codex-gateway

[English](README.md) | **简体中文**

> **遥测告知 / 对话告知：** `credential-console` 会记录每个经代理转发的 Claude 网关请求元数据
> （包括服务商报告的四类 token 数），并把这些指标向所有能够访问控制台的成员公开。P6 会
> 永久保存符合条件的 Claude API 轮次，并把捕获到的 API user/assistant 正文公开给所有能够访问控制台的人；
> 在 `open` 模式下就是 tailnet 中任何能访问控制台的人，没有身份识别，也没有阅读审计。成员
> 标签由本人填写且未经验证。捕获到的 API user 文本可能含客户端包装，不保证是用户原话。
> 只有存在有界且格式校验通过的 Claude Code 会话标识时才会关联成对话；数据库只保存其 HMAC，
> 这种关联不代表用户身份认证。Codex 流量不在轮次采集范围内。

面向 **Codex**（ChatGPT 订阅）与 **Claude Code** 订阅的自托管凭证分发中心（credential
distribution centre）。

一个人只登录一次。此后每台机器、每位团队成员都能拿到可用的访问能力，既没有人拿到可复用的
服务商 OAuth 凭证，各份副本之间也不会互相挤掉。

## 问题

**Codex。** Codex 订阅凭证（`~/.codex/auth.json`）里带有一个 `refresh_token`，服务商以
**一次性**（single-use）的方式轮换它：只要有一台机器刷新，该 token 的其他所有副本立刻永久
失效——而且是静默失效，没有任何可诊断的信号。因此把同一份 `auth.json` 复制到每台机器等于
自毁；预先存下的种子凭证也会以同样方式失效，于是新配置出来的机器拿到的同样是一份死凭证。

**Claude Code。** 成员真正需要的凭证是一个长期有效的服务商 OAuth token。把它发出去等同于
把账号发出去：无法只针对一台设备吊销，无法限定权限范围，并且在它接触过的任何机器上都会
继续留存。

两种情况需要同一种形态的答案：把真正的凭证只保存在唯一一个地方，发给其他所有人的东西在
预期用途上可用，做别的一概无用。

## 机制

`codex-credential` 让可用的 `refresh_token` 有且只有**一个**持有者，对外分发的凭证
*在结构上就不具备刷新能力*——因此任何客户端都不可能把中心的 token 轮换掉。

多个 Codex 账号分别使用独立的凭证目录、刷新进程、dispenser 与证书。客户端把它们安装成
隔离的 `CODEX_HOME` profile；选择只影响下一次新启动的 `codex-gateway` 进程，不覆盖默认
`~/.codex` 登录，也不会热切已经运行的会话。
profile 底层可以同时保存多个域，但当前一个 `credential-console` 进程只有一套全局 Codex
dispenser 配置，也没有 Codex 账号选择器；在控制面支持多域路由前，第二个真实账号仍需单独配置域。

`credential-console` 把 Claude OAuth token 加密存放在磁盘上（encrypted at rest），并且不让
它们离开这台主机。设备用每设备独立的 token 向网关认证；网关剥掉该 token，再向上游附上服务商
当前为该设备选择、并保存在服务端的凭证。设备可以查看自己的状态，并在管理员已允许的账号之间
切换；不需要新凭证，也不能查看或修改其他设备。

```
                              ┌──────────────────────────────────────────┐
                              │  provider                                │
                              │  auth.openai.com/oauth/token             │
                              │  chatgpt.com/backend-api/codex/responses │
                              │  api.anthropic.com                       │
                              └───────▲───────────────────▲──────────────┘
                                      │                   │
  ═════ centre host (direct egress) ══╪═══════════════════╪═══════════════════════
                                      │                   │
   ┌──────────────────────────┐       │       ┌───────────┴──────────────────┐
   │ refresh-center           ├───────┘       │ credential-console           │
   │ sole holder of a working │               │ encrypted Claude OAuth store │
   │ refresh_token; persists  │               │ + admin UI + enrollment      │
   │ each rotation atomically │               │ + /claude gateway            │
   └───────────┬──────────────┘               └────┬──────────────────┬──────┘
               │ access_token only                 │                  │
   ┌───────────▼──────────────┐                    │ read-only import │
   │ token-dispenser          │◄───────────────────┘ (expiry, client  │
   │ POST /enroll  → machine  │  server-side mint     count; never the│
   │                  token   │                       refresh token)  │
   │ GET  /credential → never │                                       │
   │        a refresh_token   │                                       │
   └───────────┬──────────────┘                                       │
               │                                                      │
  ═════════════╪══════════════════════════════════════════════════════╪═════════
               │ pull before expiry                    device token    │
   ┌───────────▼──────────────┐                     ┌─────────────────▼────────┐
   │ client-agent             │                     │ member device            │
   │ writes ~/.codex/auth.json│                     │ claude → gateway → API   │
   │ refresh_token = INVALID  │                     │ holds only a per-device  │
   │ value (never absent)     │                     │ token, never provider    │
   └──────────────────────────┘                     └──────────────────────────┘
```

控制平面（control plane）的入口——管理 UI、注册（enrollment）页面——应当留在私有网络里。
只有经过 token 认证的数据平面（data plane），也就是 Codex dispenser 和 `/claude` 网关，
才面向公网。

## 组件

| 组件族 | 内容 | 文档 |
|---|---|---|
| [`codex-credential/`](codex-credential/) | `refresh-center`、`token-dispenser`、`client-agent`。把一份 Codex 凭证分发给多台机器，且各台机器之间不会互相挤掉。 | [README](codex-credential/README.md) · [DEPLOY](codex-credential/DEPLOY.md) |
| [`credential-console/`](credential-console/) | 多账号控制平面、按设备注册与账号切换、加密的 Claude OAuth 存储、隔离凭证的 Claude 网关。以只读方式导入已有的 `codex-credential` home 目录，也可以自己完成 Codex 账号授权。 | [README](credential-console/README.md) · [DEPLOY](credential-console/DEPLOY.md) |

两个组件族相互独立。只部署 `codex-credential` 本身就是一套完整方案；`credential-console`
在其之上增加 Claude 账号、一套 UI 和自助注册。

## 环境要求

- 运行 `credential-console` 的中心主机需要 **Node ≥ 22.5**；只运行 Codex 组件的中心主机和
  客户端 agent 需要 **Node ≥ 20**。没有任何运行时 npm 依赖。
- 中心主机需要能**直接出网**（direct egress）访问 `auth.openai.com`——有些网络在这里会
  返回 `403`，这样的主机不能充当中心。在正式选定一台主机之前，先用一次故意构造的无效刷新
  请求来验证。
- 每台客户端机器都需要直接出网访问 `chatgpt.com/backend-api/`。凭证不能替代网络可达性，
  而且这是两项互不相同的出网要求。
- 若要使用 Claude 账号：中心主机需要能访问 Anthropic API。
- 建议：使用私有 overlay 网络（例如 Tailscale），这样控制平面完全不需要公网监听端口。
  Serve/Funnel 拓扑见部署文档。

## 从这里开始

1. 如果由 AI 协助配置成员机器，先读公开的
   [`AI 接入指引`](AI-ONBOARDING.md)。它要求先加入 tailnet 再打开私有控制台，且不包含部署密钥。
2. 再读 [`QUICKSTART.md`](QUICKSTART.md)，这是从零到一个可用客户端的最短路径。
3. 然后读 [`codex-credential/DEPLOY.md`](codex-credential/DEPLOY.md)——服务端、一次性的
   人工登录，以及每台机器上的 agent。
4. 如果还想要 Claude 账号和 UI，再读
   [`credential-console/DEPLOY.md`](credential-console/DEPLOY.md)——网络拓扑、管理员认证、
   成员自助，以及备份/恢复/回滚流程。

在你还没有值得丢失的东西之前，就先读完备份与恢复那几节。丢掉中心的 `refresh_token`，
意味着要请人重新登录一次。丢掉 console 的 `master.key`，则所有已存储的 Claude OAuth 凭证
都无法恢复。

## 安全模型简述

- **唯一持有者。** 有且只有一个进程持有可用的 Codex `refresh_token`。Claude 的服务商 OAuth
  token 在磁盘上以 AES-256-GCM 加密，密钥是一把独立的 mode-600 主密钥，提交之后永不回显。
- **结构性保证，而非过滤。** dispenser 根本不读 `refresh_token` 字段，因此经过它的
  任何代码路径都不可能返回 `refresh_token`。注册处理逻辑从不打开已发布的凭证，所以注册密钥
  （enrollment key）即便泄露，也只能签发机器 token，别的什么都做不了。
- **每设备独立凭证。** 每台机器、每个成员设备都有自己的 bearer token，只以 SHA-256 摘要形式
  存储，可以单独吊销，并在每次请求时校验。同一 token 也用于只能操作自身的控制 API，不能查看
  或切换其他设备。
- **平面分离。** 控制平面私有；只有经过 token 认证的数据平面对外公开。Claude 网关按白名单
  放行路径，在附上服务商凭证之前先剥掉设备的 authorization 头，按来源 IP 对认证失败限流，
  并对每个设备施加请求量和并发额度。
- **分离的请求遥测与 API 轮次。** Claude 网关会持久化请求元数据，以及输入、缓存创建输入、缓存读取
  输入和输出四类 token 数，用于共享指标。不展示正文的指标页会在服务端备用视图之上渐进增强：使用
  本地打包并带 SRI 的 Apache ECharts 展示 Token 构成、账号/模型排行与跨设备每小时趋势，不请求 CDN。
  P6 会另外永久保存符合条件、
  已捕获的 Claude API 轮次，供控制台全员浏览。未来带合法会话标识的轮次使用 HMAC 隐藏后关联成
  多轮时间线；旧记录或无标识轮次保持 standalone，绝不按时间猜测归组。API user 文本也可能包含
  客户端包装。Codex 流量不在这条采集边界内。
- **中心主机在设计上就是高价值主机。** 中心主机一旦被攻破到 root 权限，攻击者就能恢复出所有
  仍然有效的服务商凭证。请收窄操作系统层面的访问权限、及时打补丁，并准备好紧急停服和吊销
  服务商 token 的流程。

成员机器上的每设备客户端隔离并不是操作系统级别的安全边界：以同一个本地用户身份运行的命令
照样能读到那个 mode-600 的 token 文件。它换来的是：影响面（blast radius）是一份可吊销的
设备凭证，而不是整个账号。

## 现状 / 哪些没有验证

本设计所依赖的 codex-cli 行为都是直接实测的，不是假设出来的；
[`codex-credential/README.md`](codex-credential/README.md) 中的表格逐条列出了每个事实及其
证据。其中最关键的一条——分发出去的凭证形态能够驱动一次真实的对话轮次，同时让 `auth.json`
保持逐字节不变——是端到端观察到的。

未经验证的部分：

- **多台机器共用一个订阅是否会引起服务商注意。** 同一个 access token 的并发使用是成功的，但
  测试来自同一台主机、同一个 IP，这并不能探测服务商侧的共享检测。这种做法是否与你和服务商
  之间的协议相容，由你自己判断，本仓库并不确立这一点。
- **服务商变更之后的长期行为。** 这些接口都没有公开文档。服务商的一次改动随时可能让某条
  实测事实失效；请重新验证，而不是无限期地信任那张表。
- **任何性能或规模上的说法。** 这里没有做出任何此类说法。本仓库中的任何部分都没有做过压力
  测试。

`codex-cli` 的版本号很重要：这些测量是针对某个特定版本做的，该版本记录在对应组件族的
README 中。

## 许可证

MIT。见 [`LICENSE`](LICENSE)。
