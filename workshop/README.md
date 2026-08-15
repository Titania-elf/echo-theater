# 回声工坊 v0

回声剧场插件的指令投稿站。Cloudflare Pages + Pages Functions + D1，全部跑在免费额度内。

```
public/              静态前端（纯 HTML + 原生 JS，无构建步骤）
functions/api/       Pages Functions（就是 Worker，同域，无 CORS 问题）
schema.sql           D1 表结构
```

网页端会先要求使用 Discord 登录；插件内浏览仍通过公开只读接口完成，不依赖网页 cookie。

## 部署

### 1. 建库

```bash
npm i -g wrangler
wrangler login
wrangler d1 create echo-workshop
# 把输出的 database_id 填进 wrangler.toml
wrangler d1 execute echo-workshop --remote --file=./schema.sql
```

### 2. 建 Discord 应用

到 https://discord.com/developers/applications 新建应用，在 **OAuth2** 页：

- 记下 **Client ID** 和 **Client Secret**
- Redirects 添加：`https://<你的项目>.pages.dev/api/auth/callback`

本地开发要额外加一条 `http://localhost:8788/api/auth/callback`。

### 3. 部署 + 配密钥

```bash
wrangler pages deploy public

wrangler pages secret put DISCORD_CLIENT_ID
wrangler pages secret put DISCORD_CLIENT_SECRET
wrangler pages secret put SESSION_SECRET     # 随便一串长随机字符串
```

`SESSION_SECRET` 用这个生成：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**这三个必须走 secret，不能进 wrangler.toml。** Client Secret 泄露了要重置整个 Discord 应用。

### 4. 本地开发

```bash
wrangler pages dev public --d1=DB=echo-workshop
```

## 日常维护

举报走网页端的 `#/admin/reports`（顶栏「内容管理」→「举报」标签页，有未处理时会带红色角标）。
按被举报对象聚合，能直接下架投稿 / 隐藏评论并把该对象的举报标记为已处理。

剩下的杂事一个人运营直接跑 SQL 更快：

```bash
# 下架一条
wrangler d1 execute echo-workshop --remote --command \
  "UPDATE scripts SET status='removed' WHERE id='ws_xxx'"

# 封人（他的全部投稿会立刻从列表消失）
wrangler d1 execute echo-workshop --remote --command \
  "UPDATE authors SET banned=1 WHERE discord_id='xxx'"

# 看未处理举报（网页端打不开时的后备）
wrangler d1 execute echo-workshop --remote --command \
  "SELECT r.id, r.script_id, s.name, r.reason FROM reports r
   LEFT JOIN scripts s ON s.id=r.script_id WHERE r.handled=0 ORDER BY r.created_at DESC"

# 评论举报
wrangler d1 execute echo-workshop --remote --command \
  "SELECT r.id, r.comment_id, c.body, r.reason FROM comment_reports r
   LEFT JOIN comments c ON c.id=r.comment_id WHERE r.handled=0 ORDER BY r.created_at DESC"
```

被管理端隐藏的评论是 `status='removed'`，跟作者自删的 `'deleted'` 分开：
前者仍然占着 `idx_comment_once`，被隐藏的人不能换一条重发。

## 备份

D1 免费版的 Time Travel 只有 7 天回滚窗口，**不能当备份用**。定期导出：

```bash
wrangler d1 export echo-workshop --remote --output=backup-$(date +%F).sql
```

建议至少每周一次，存到本地 + 另一个地方。免费平台要按「随时会消失」来设计。

## 免费额度会先撞到哪

| 限制 | 免费额度 | 风险 |
|---|---|---|
| Worker 请求 | 10 万/天 | 低。索引接口有 5 分钟边缘缓存，下载计数是批量的 |
| D1 读取行 | 500 万/天 | 低，只要 `schema.sql` 里的索引都建了 |
| D1 写入行 | 10 万/天 | 几乎不可能 |
| D1 单库 | 500 MB | 不可能。400 条纯文本约 800KB |

## 内容管理升级

已有数据库部署新版前，需要先执行一次迁移：

```bash
wrangler d1 execute echo-workshop --remote --file=./migrate-content-management.sql
```

迁移后，历史投稿会统一成为“待审核”；管理员批量导入的新投稿会直接标记为已审核。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/list` | 公开索引，不含 prompt，带 CORS + 5 分钟缓存 |
| GET | `/api/script/:id` | 详情，含 prompt |
| POST | `/api/downloads` | 批量上报下载量 `{ids:[...]}` |
| POST | `/api/report` | 举报投稿，允许匿名 |
| POST | `/api/comment/:id/report` | 举报评论，允许匿名 |
| GET | `/api/auth/login` | 跳 Discord 授权 |
| GET | `/api/auth/callback` | OAuth 回调 |
| GET | `/api/auth/me` | 当前登录状态 |
| POST | `/api/auth/logout` | 退出 |
| GET | `/api/my/scripts` | 我的投稿 |
| POST | `/api/my/scripts` | 新建 |
| PUT | `/api/my/script/:id` | 编辑（version+1） |
| DELETE | `/api/my/script/:id` | 下架（软删除） |
| GET | `/api/admin/reports` | 举报列表，按对象聚合；`?count=1` 只回未处理数 |
| POST | `/api/admin/reports` | 处理举报 `{type, target_id, action?, handled?}` |

读接口开 CORS 是给插件面板用的（SillyTavern 跑在 localhost）。带 cookie 的私有接口不开跨域。

## v0 已知限制

- 编辑走的是公开详情接口，所以**已下架的投稿无法编辑**。要改的话得加一个 `/api/my/script/:id` 的 GET
- 下载计数按点击计，没有去重，同一个人多次点会重复计数
- 没有分页。超过 2000 条要改 `list.js` 的 LIMIT 和前端渲染策略
- 举报没有频率限制也不去重：同一个人可以对同一条投稿反复提交，匿名举报无法追溯。
  这是「门槛越低越好」换来的代价 —— 处理台按对象聚合并回传「几个登录用户 + 几条匿名」，
  就是为了让刷举报在列表里一眼能看出来
