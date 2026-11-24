# HYE Freight OMS · WARP Gateway API V2 询价 Demo

保留原 OMS 页面，默认查价来源改为 Gateway API V2 **staging**。也可在表单内明确选择原演示模拟报价。WARP 返回失败、无价或超时，界面显示错误，不回退生成模拟价格。

## 本地运行

需要 Node.js 22.9+。无运行时第三方依赖。

1. 将 `.env.example` 复制为 `.env`，仅在本机服务端填入 `WARP_V2_SANDBOX_KEY`。`.env` 已忽略，不能提交。
2. 执行 `npm start`。
3. 打开 `http://127.0.0.1:8787/oms/#quote`。

也可以从仓库以外读取密钥文件：`node --env-file=/absolute/path/to/private.env server/local.mjs`。

V2 Sandbox 密钥通过 `apikey` 请求头，仅发送到固定的 `https://stg.wearewarp.com/api/v1/freights/quote`。不是 V1 Bearer 密钥。前端不收集、不保存、不发送 WARP 密钥。

## 已接入

- LTL 托盘询价，以及单辆 53ft 干柜、26ft Box Truck、Cargo Van 的请求映射。
- 每行 `totalWeight = 单件重量 × 件数`，保留每行尺寸和数量；公制输入沿用原 OMS 转换为 lb/in 的能力。
- 住宅、尾板、室内、限制进入、预约送货、展会等可映射附加服务。
- API 总价、真实费用行、时效、有效期、报价编号和获取时间。费用分项经过分币核对，不从演示费率推算。
- 明确拒绝暂无法映射的 CFS、亚马逊预约、到货通知、温控及特殊监管货物。没有完整支持的条件不会被悄悄丢弃。
- 报价过期或日期、货物、服务改变后须重新询价。原有模拟报价不会混入 V2 报价列表。

`/freights/quote` 返回一个最低报价，当前页面不是多承运商比价。多承运商接口 `/freights/freight-quote` 尚未接入。当前阶段只开放托盘包装和单车，未验证所有线路及服务组合。

## 资金与下单边界

WARP 报价只是供应商成本参考，并非 HYE 销售价；未加入 HYE 加价。Sandbox/staging 参考报价不能表述为生产账户正式协议价。

HYE 客户演示余额继续属于原 Demo。WARP 供应商余额未对外开放，也没有映射到客户钱包。V2 报价不进入原 Demo 下单或余额扣减流程。后端只接受一个固定询价路由，拒绝 `/booking`、`/book`、充值、余额等其他操作，且没有通用转发接口。

本次没有调用任何真实或测试下单、扣款、绑卡、充值接口。

## GitHub Pages 上线

GitHub Pages 仅托管静态前端，无法保管 WARP 私钥。当前原始线上页面未修改。要在线使用：

1. 将 `server/gateway.mjs` 部署至可信后端。仓库附 Cloudflare Worker 配置 `wrangler.jsonc`，部署前在用户自己的账户中准备 Worker。
2. 用托管平台的 secret manager 配置 `WARP_V2_SANDBOX_KEY`（Cloudflare: `wrangler secret put WARP_V2_SANDBOX_KEY`，交互输入，不能放入配置或命令参数）。
3. 在 `oms/warp-config.js` 的 `gatewayUrl` 设置该 Worker 的 HTTPS origin。这只是公开后端地址，不是密钥。
4. 验证 Pages → 后端 → WARP staging 的端到端链路后再发布前端。

Worker 配置按 IP 提供近似速率限制；本地服务限每小时 30 次。CORS 允许当前站点和 `https://zefanlong.github.io`，但 CORS 不是身份验证。此配置适合 Sandbox Demo；生产密钥上线前需用户认证、客户隔离、全局配额和服务端加价。当前代码固定 staging，不接受客户端选择生产地址或密钥。

## 验证

`npm test` 需要 Postman CLI 1.70+。测试会自动启动本地 Postman simulation，并在结束时关闭，不需要登录 Postman，也不读取真实 WARP 密钥。

9 个检查覆盖真实 HTTP 请求序列化、V2 apikey 认证、总重量和附加服务映射、429、上游 HTML/502、400、无效价格、模式替代、禁止下单、钱包隔离及日期变更。模拟上游是根据官方合同构建的本地替身，不等于 WARP Sandbox。Postman 未登录，未搜索所有者托管 mock。

2026-11-24 使用用户提供的 V2 Sandbox 密钥，对 WARP 官方 staging 进行了实际询价：

- LTL：90001 → 94105，2026-11-25，1 托 × 500 lb，48×40×48 in：HTTP 200，约 $188.65，3 天；界面测试含预约送货 $0.00。
- FTL：同线路和日期，1 辆 53ft 干柜、20 托 × 500 lb：HTTP 200，约 $2,498.85，1 天。

这些只是当次测试响应，不保证其他线路、时点或正式账户同价。浏览器验证了桌面与 390px 移动布局，真实询价 → 报价列表，控制台无错误。生产接口、Sandbox 下单、Cloudflare 实际部署未验证。

## 官方依据

- V2 完整规范：<https://developer.wearewarp.com/docs/freight/>
- V2/V1 环境及认证说明：<https://www.wearewarp.com/freight-api>
- `contracts/warp-v2.openapi.json` 为 2026-11-24 从官方 Swagger UI 提取的快照；其内部 info.version 为 1.0.0，与“Gateway API V2”产品名不是同一版本编号。已去除顶部公开 Postman 下载访问参数。
- 用户此前的 V1 1.19.0 规范也已在官网核对；本次最终实现以 V2 为准，未混用 V1 字段、Bearer 密钥或报价响应。
