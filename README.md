# HYE Freight OMS · WARP Gateway API V2 测试接入

保留原 OMS 查价入口与承运商报价卡片。点击一次“查看报价”，LTL 从 WARP Gateway V2 **staging** 多承运商接口获取所有可用报价，使用原卡片、排序和筛选，不再选择报价来源。成功返回的卡片均为 API 选项，不混入原模拟价格；失败时提示原因，报价列表留空。历史演示记录仍保留且标识为模拟。

## 本地运行

需要 Node.js 22.9+。无运行时第三方依赖。

1. 将 `.env.example` 复制为 `.env`，仅在本机服务端填入 `WARP_V2_SANDBOX_KEY`。`.env` 已忽略，不能提交。
2. 执行 `npm start`。
3. 如需沙盒下单，在服务端环境设置 `WARP_SANDBOX_BOOKING_ENABLED=true`，默认关闭。
4. 打开 `http://127.0.0.1:8787/oms/#quote`。下单需重新询价以取得当前会话的服务端报价快照。

也可以从仓库以外读取密钥文件：`node --env-file=/absolute/path/to/private.env server/local.mjs`。

V2 Sandbox 密钥通过 `apikey` 请求头，仅发送到固定的 `https://stg.wearewarp.com/api/v1` 主机；询价使用两个固定路径，启用本地沙盒下单后另允许两个对应下单路径。不是 V1 Bearer 密钥。前端不收集、不保存、不发送 WARP 密钥。

## 已接入

- LTL 多承运商托盘询价，以及单辆 53ft 干柜、26ft Box Truck、Cargo Van 的请求映射。
- 每行 `totalWeight = 单件重量 × 件数`，保留每行尺寸和数量；公制输入沿用原 OMS 转换为 lb/in 的能力。
- 住宅、尾板、室内、限制进入、预约送货、展会等可映射附加服务。
- API 总价、真实费用行、时效、有效期、报价编号和获取时间。费用分项经过分币核对，不从演示费率推算。
- 明确拒绝暂无法映射的 CFS、亚马逊预约、到货通知、温控及特殊监管货物。没有完整支持的条件不会被悄悄丢弃。
- 报价过期或日期、货物、服务改变后须重新询价。所有 API 承运商选项同列展示，并在卡片级保留 Sandbox 与供应商来源标识。

LTL 调用 `/freights/freight-quote`：请求使用 `items` 和 stop `serviceOptions`，返回 `options[]`，每项 `expirationTs` 为毫秒、`transitTime` 为秒。单车 FTL/Box Truck/Cargo Van 继续调用 `/freights/quote`：请求使用 `listItems` 与服务对象数组，响应的到期时间为秒、时效为天。两个接口分别适配，避免单位及字段混用。当前只支持托盘包装和单车，未验证所有线路/服务；多承运商端点官方标记 Experimental，返回数量取决于账号、线路与启用渠道。

## 资金与下单边界

WARP 报价只是供应商成本参考，并非 HYE 销售价；未加入 HYE 加价。Sandbox/staging 参考报价不能表述为生产账户正式协议价。

HYE 客户演示余额继续属于原 Demo。WARP 供应商余额没有读取或映射到客户钱包；沙盒订单不生成 HYE 客户账单、不扣 HYE 客户余额。历史模拟订单保留原演示行为。

本地服务可明确启用 Sandbox 下单：市场报价 option ID 调用 `/freights/book`，单报价 ID 调用 `/freights/booking`。保留原完善订单、核对和订单卡片流程，补充实际当地时区和送货日期。服务端保存报价金额、到期时间及货物/服务快照，核对邮编、联系人和未来时间窗口；不接受浏览器提供任意供应商 quote ID 或价格。

本地 SQLite 数据位于忽略目录 `.local/`，仅供单个本机服务实例使用；包含会话、报价、订单意图、结果及独立虚拟测试账本。请备份且不要公开、提交或删除后重试未知订单。启动中断后的提交记为结果未知，禁止自动重试；相同报价并发只提交一次，完成结果可重放。会话 cookie 为 HttpOnly / SameSite=Strict，下单还核对本机 Origin 和 CSRF。单笔测试上限 $5,000，每会话虚拟测试资金 $10,000，提交中/未知订单预留预算。**此虚拟金额不是 WARP 余额，也不是供应商已付款凭证。**

WARP 支付结果分别处理：

- 返回 `paymentLink`：订单已创建但待付款；不记测试扣款，不重新下单。原始链接可能指向正式客户门户，故不会转发或自动跳转。订单页另提供固定 `stg-customer.wearewarp.com` 的测试付款入口（2026-11-24 已从 WARP 设置页及测试订单列表确认），只携带订单编号；测试门户付款结果尚未自动同步。
- 返回 `payment`：保存脱敏的测试支付记录；测试卡尾号可见。WARP 支付费用可能与原报价不同。
- 无支付记录且无待付款链接：只确认已创建，不能据此认定供应商扣款；独立虚拟测试账本记录报价成本。
- 402 拒付不记账；409、5xx、超时或缺失订单 ID 视为结果未知，须在供应商侧核对，禁止盲目重试。结果未知的预算继续预留。

2026-11-24 已在实际 WARP staging 提交一次 LTL 沙盒订单：90021 → 90036，2026-11-27，1 托 × 500 lb，48×40×48 in，报价 $96.99。返回订单 `01M86H8S5FNRPXJ41WAWNDEJK8`、PRO `P-00447-2647`、shipment `S-00452-2647`，**待付款**。WARP 未返回成功扣款凭证；本地测试账本和 HYE 客户余额均未扣减。尚未配置或操作 WARP 测试卡、充值，也没有完成实际供应商测试扣款。

要实测 WARP 卡支付，账户管理员需先在独立测试门户 `https://stg-customer.wearewarp.com/` 登录 **staging 测试账户**（正式门户设置 > API 访问 > 打开测试环境门户；首次可按页面提示通过测试账户邮箱“忘记密码”设置密码），并配置测试余额，或测试卡并开启 Pay by card for API bookings。现有 API key 足以下单，但不会自动建立付款方式。公开 V2 合同没有直接余额充值/已创建订单付款接口，因此当前不能从 OMS 自动支付这笔待付款订单。只用测试环境和官方测试卡；不能通过修改生产 URL 或打开未知付款链接绕过此步骤。

本次实测的 17 个报价选项均匹配本地 Logo。新增 WARP、CCFS、Daylight 官方图片，复用已有 Estes、R+L、XPO、Forward Air、ABF、AAA Cooper、FedEx、Saia、Old Dominion 图片；另补齐历史 Echo 与 Custom Companies 卡片。来源见 `assets/carriers/SOURCES.md`。

## GitHub Pages 上线

GitHub Pages 仅托管静态前端，无法保管 WARP 私钥。当前原始线上页面未修改。要在线使用：

1. 将 `server/gateway.mjs` 部署至可信后端。仓库附 Cloudflare Worker 配置 `wrangler.jsonc`，部署前在用户自己的账户中准备 Worker。
2. 用托管平台的 secret manager 配置 `WARP_V2_SANDBOX_KEY`（Cloudflare: `wrangler secret put WARP_V2_SANDBOX_KEY`，交互输入，不能放入配置或命令参数）。
3. 在 `oms/warp-config.js` 的 `gatewayUrl` 设置该 Worker 的 HTTPS origin。这只是公开后端地址，不是密钥。
4. 验证 Pages → 后端 → WARP staging 的端到端链路后再发布前端。

Worker 仍仅开放询价，不包含本地 SQLite 下单服务。当前沙盒下单仅在本机运行，未部署到线上。Worker 配置按 IP 提供近似速率限制；本地服务限每小时 30 次 POST。CORS 允许当前站点和 `https://zefanlong.github.io`，但 CORS 不是身份验证。此配置适合 Sandbox Demo；生产密钥上线前需用户认证、客户隔离、全局配额和服务端加价。当前代码固定 staging，不接受客户端选择生产地址或密钥。

## 验证

`npm test` 需要 Postman CLI 1.70+。测试会自动启动本地 Postman simulation，并在结束时关闭，不需要登录 Postman，也不读取真实 WARP 密钥。

21 个检查覆盖 HTTP 请求序列化、V2 apikey、计价映射、异常报价、只读网关禁止下单，以及本地沙盒下单、待付款、拒付、重复/并发、预算预留、超时未知、服务重启及 HYE 钱包隔离。成功支付与拒付分支通过本地合同替身验证，不能冒充实际 WARP 扣款。模拟上游是根据官方合同构建的本地替身，不等于 WARP Sandbox。Postman 未登录，未搜索所有者托管 mock。

2026-11-24 使用用户提供的 V2 Sandbox 密钥，对 WARP 官方 staging 进行了实际询价：

- LTL：90001 → 94105，2026-11-25，1 托 × 500 lb，48×40×48 in：HTTP 200，约 $188.65，3 天；界面测试含预约送货 $0.00。
- FTL：同线路和日期，1 辆 53ft 干柜、20 托 × 500 lb：HTTP 200，约 $2,498.85，1 天。

多承运商 LTL 同线路 2 托 × 400 lb、预约送货实测返回 17 个选项，包括 WARP、Estes、R+L、XPO、Forward Air、ABF、CCFS、AAA Cooper、FedEx、Saia、Daylight、Old Dominion。

这些只是当次测试响应，不保证其他线路、时点或正式账户同价。浏览器验证了桌面与 390px 移动布局，真实询价 → 报价列表，控制台无错误。生产接口、实际供应商成功扣款、Cloudflare 部署未验证；实际 Sandbox 下单结果见上文。

兼容原 OMS 的 LTL 草稿：`mode` 缺省时按 LTL 处理；显式未知类型仍拒绝。回归测试直接使用原表单的 `exampleShipment` 数据，避免只验证人工构造的请求。

## 官方依据

- V2 完整规范：<https://developer.wearewarp.com/docs/freight/>
- V2/V1 环境及认证说明：<https://www.wearewarp.com/freight-api>
- `contracts/warp-v2.openapi.json` 为 2026-11-24 从官方 Swagger UI 提取的快照；其内部 info.version 为 1.0.0，与“Gateway API V2”产品名不是同一版本编号。已去除顶部公开 Postman 下载访问参数。
- 用户此前的 V1 1.19.0 规范也已在官网核对；本次最终实现以 V2 为准，未混用 V1 字段、Bearer 密钥或报价响应。
