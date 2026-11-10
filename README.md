# 家庭记账本 · Household-expenses

一家人的账记在一起。手机浏览器打开就能用，可加到桌面像 App 一样。

- **语音或文字记账**：「今天给孩子报补习班花了3000」→ 自动识别金额、日期、类型、分类、人员，确认一下入账
- **自动分类**：收支 / 人员（父、母、孩子）/ 二级类别（餐饮·买菜、教育·补习培训…），类别可自己加
- **特殊类型不计收支**：转账、借出、收回、借入、归还、报销回款只调整账户与债权，不会把家庭总收支算错
- **账户余额**：现金 / 微信 / 支付宝 / 银行卡，转账自动扣转出、加转入，余额按账目推算
- **支持补录**：发生日期和记录时间分开，报表按发生日期算
- **共享账本**：家人各注册一个账号，用 6 位邀请码加入同一本账，谁记的账在列表里可见
- **图表统计**：支出构成环形图、近 6 个月收支柱状图、按人员排行、分类趋势表（哪一类在涨一眼看出）、环比上一月
- **报销闭环**：垫付时标记「待报销」，报销回款时选那笔垫付，自动冲减同一分类的支出，不算收入
- **预算提醒**：总预算与按分类预算，用到 80% 提醒、超支标红
- **导出 Excel**：真正的 `.xlsx` 文件（含「明细」+「分类汇总」两个工作表，表头冻结、列宽自适应），
  另附 CSV（带 BOM）作为纯文本备份。两种都是自己手写的浏览器端生成，不依赖任何库

技术上是**零依赖**的静态网页：没有框架、没有打包、没有 npm 依赖。改一行字推上去，GitHub Pages 自动生效。

---

## 目录结构

```
index.html              入口页面
styles.css              样式（手机优先，支持深色模式）
manifest.json           加到手机桌面的配置（用 .json 后缀，Pages 才会以 application/json 提供）
.nojekyll               让 GitHub Pages 别过 Jekyll，原样发布文件
icon.svg                图标

src/
  config.js             ★ 要你填 Supabase 地址和 key
  app.js                界面与交互（四个标签页）
  store.js              数据层（Supabase 远程 / 本机演示 两套实现）
  supabase.js           极简 Supabase 客户端（Auth + REST + RPC）
  parse.js              自然语言记账解析（金额/日期/类型/分类/人员/备注）
  analytics.js          统计聚合（合计、分类、人员、月度、预算、环比）
  charts.js             手写 SVG 图表
  xlsx.js               手写 .xlsx 导出（存储式 ZIP + 最小 OOXML，零依赖）
  defaults.js           默认分类与关键词词典
  utils.js              日期/金额/字符串工具

supabase/schema.sql     数据库结构（表 + 行级权限 + 邀请码函数）
supabase/validate-schema.mjs  用真 Postgres 验证 schema 的可选脚本
test/                   Node 单元测试（无需安装依赖）
test/e2e/               端到端：真 Postgres 上跑真实数据层（需临时装 PGlite）
tools/serve.js          本地预览服务器
tools/check-config.js   上线自检：填完配置跑一下，逐条告诉你哪里没弄好
tools/check-assets.js   部署前资源检查：大小写、缺失文件、裸导入
tools/check-pages.js    模拟 GitHub Pages 子路径托管，验证推上去不会白屏
```

---

## 推送前跑三个检查

```bash
node tools/check-config.js    # Supabase 那边：地址/key/表/行级权限/函数/注册
node tools/check-assets.js    # 这边：文件都在、大小写对、没有 Node 专有 API
node tools/check-pages.js     # 托管那边：子路径 /Household-expenses/ 下每个引用都能取到
```

第二个专治「本地能开、Pages 白屏」：Windows 不区分大小写，GitHub Pages 是 Linux。
`import './Utils.js'` 在你电脑上跑得好好的，推上去就是 404 白屏。

第三个专治另一种「本地能开、Pages 白屏」：Pages 把仓库放在**子路径**下
（`https://用户名.github.io/Household-expenses/`），不是域名根目录。所以 `href="/styles.css"`
这种绝对路径在本地根路径预览时完全正常，推上去就 404。这个脚本会把仓库复制到临时目录的
`Household-expenses/` 子目录里，起一个和 Pages 行为一致的服务器，从首页开始把 14 个引用
逐个请求一遍，同时检查 manifest 的 `start_url` 是否落在子路径内、`.nojekyll` 是否就位。

---

## 填完配置先自检

```bash
node tools/check-config.js
```

它会真的去问 Supabase：地址对不对、key 对不对、表建了没、**行级权限开没开**（这条最关键，匿名能读到数据就是没开）、建家函数在不在、注册能不能直接用。只读脚本，不写任何数据。
---

## 现在就能看一眼（不用注册任何东西）

```bash
node tools/serve.js
```

浏览器打开 <http://127.0.0.1:8080>，会进入**演示模式**：有现成的三个月账目，可以试记账、看图表、导 Excel。
数据只存在这台设备的浏览器里，不上传任何东西。

## 跑测试

```bash
npm test
```

或逐个跑（不用 `node --test`，某些受限环境下它会因子进程受限而失败）：

```bash
node test/parse.test.mjs      # 自然语言解析 16 项
node test/analytics.test.mjs  # 统计聚合与分类趋势 12 项
node test/accounts.test.mjs   # 账户识别与余额 8 项
node test/remote.test.mjs     # Supabase 请求构造 + 列名与 schema 一致 + 两实现接口一致 10 项
node test/check.test.mjs      # 上线自检的判断逻辑 9 项
node test/xlsx.test.mjs       # .xlsx 生成（独立实现的解包器 + CRC32 校验）9 项
node test/ui.test.mjs         # 界面渲染、业务闭环、标签配对、交互接线、导出、语音 19 项
```

共 83 项，全部离线可跑，不需要真实 Supabase 项目。

## 改了数据库结构怎么验

`supabase/schema.sql` 有个用真 Postgres（PGlite，跑在 WASM 里）的验证脚本，会伪造 Supabase 的
`auth.users` / `auth.uid()` / `anon` 角色，然后把建家、邀请码入家、行级权限、触发器逐项断言一遍：

```bash
npm i --no-save @electric-sql/pglite    # 只是本地临时装，不进 package.json
node supabase/validate-schema.mjs
```

当前 15 项全过，覆盖「外人读不到别人家的账」「伪造 family_id 写入被挡」「匿名读不到任何家庭」
「同月预算不能重复」等。平时不用跑，改完 SQL 再跑一次就行。

## 端到端：让真实代码跑在真 Postgres 上

`test/e2e/` 里有个「假 Supabase」：用 PGlite 跑真 schema.sql，再用 Node 内置 http 复刻
Supabase 用到的三条路径（注册登录、表的增删改查、RPC）。这样 `src/store.js` 的 RemoteStore
和 `src/supabase.js` 是**原封不动地**跑在真 SQL 上，而不是对着假 fetch 猜。

```bash
npm i --no-save @electric-sql/pglite
npm run test:e2e
```

共 20 项，分三个文件：

- `remote-store.test.mjs`（13 项）：直接打数据层。建家→默认分类与账户、按月区间查询、改/删、
  转账双账户、预算覆盖与清零、自定义分类、邀请码加入、错码被拒、外人读不到、两个家庭互相隔开、
  越家改 family_id 被挡、刷新后登录态仍在、真实数据算统计与图表（合计/分类/账户余额/超支/SVG 不含 NaN）。
- `app-flow.test.mjs`（4 项）：从界面入口进去，走用户第一次使用的真实路径。注册 → 停在建家页 →
  建家（自动得到默认分类和账户）→ 说一句「今天买菜35.5元」→ 保存 → 流水页看得到 → 统计页出图 →
  我的页拿到邀请码；第二个人注册后用邀请码加入，看到同一本账并能记账；密码错和邀请码错都给中文提示。
- `pagination.test.mjs`（3 项）：一次塞 1205 笔，断言全部取回、id 不重复、金额合计对得上。

**这套测试抓到过一个致命 bug**：建家时往 `accounts` 写了不存在的 `sort` 列，
真实 Supabase 会整批拒绝——等于「新用户第一次建家必然失败」。假 fetch 什么都收，永远发现不了。
现在 `test/remote.test.mjs` 会从 schema.sql 里读出每张表的列名，逐条比对写入字段，
这类错误在离线测试阶段就会拦下来。

**还抓到过一个不会报错的 bug**：Supabase（PostgREST）单次响应最多 1000 行，超出的**静默截断**，
HTTP 200 照旧。家里记到第 1001 笔之后，账户余额和统计就会悄悄变少，而且没有任何错误提示。
现在 `fetchTransactions` 自己翻页（用「直到空页」作为结束条件，所以服务端 max-rows 配成更小也不会漏），
排序末尾带 `id` 保证翻页稳定。假 Supabase 也刻意实现了这个 1000 行上限，让这类问题能被复现出来。

---

## 上线三步

详见 [DEPLOY.md](DEPLOY.md)。简版：

1. 在 Supabase 建一个免费项目，把 `supabase/schema.sql` 整段粘进 SQL Editor 执行
2. 把项目的 URL 和 anon key 填进 `src/config.js`，跑 `node tools/check-config.js` 自检
3. 推送到 GitHub，在仓库 Settings → Pages 里选 `main` 分支根目录

---

## 数据安全

- 每个家庭的数据靠 Postgres 行级权限（RLS）隔离，**别人拿到 anon key 也读不到你家的账**
- 加入家庭只能靠邀请码，且「查码 + 建成员」在数据库函数里完成，无法绕过
- 成员表有触发器守着 `family_id`：**谁也不能把自己的账号挪到别人家里**（只能走邀请码函数）
- 前端不保存任何密钥；登录令牌存在浏览器本地，过期自动刷新

---

## 已确认的业务口径

| 场景 | 处理 |
|---|---|
| 收入 / 支出 | 计入家庭收支合计 |
| 转账（卡→微信等） | **不计入**合计，只影响账户 |
| 借出 / 收回 | **不计入**，记债权 |
| 借入 / 归还 | **不计入**，记债务 |
| 报销回款 | **不算收入**，冲减对应分类的支出 |
| 垫付待报销 | 记支出并标记「待报销」 |
| 补录过去的账 | 按发生日期归属，跨年自动归到去年 |
