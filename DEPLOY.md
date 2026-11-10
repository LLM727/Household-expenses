# 上线清单（照着点就行，大约 15 分钟）

整个方案只用两个免费服务：**Supabase**（数据库 + 账号）和 **GitHub Pages**（放网页）。都不花钱，也不用买服务器和域名。

---

## 第 0 步：先在本机看一眼（可跳过）

```bash
node tools/serve.js
```

打开 <http://127.0.0.1:8080>。现在是**演示模式**，有现成数据，可以随便点。看完 `Ctrl+C` 关掉。

---

## 第 1 步：建 Supabase 项目

1. 打开 <https://supabase.com>，点 **Start your project**，选 **Continue with GitHub**（用你的 GitHub 账号登录，不用另外注册）。
2. 点 **New project**：
   - **Name**：`household-expenses`（随便填）
   - **Database Password**：点旁边的 **Generate a password**，然后**复制保存到一个安全的地方**（后面基本用不到，但别丢）
   - **Region**：选 **Southeast Asia (Singapore)** —— 离国内最近，速度最快
   - **Plan**：Free
3. 点 **Create new project**，等 1～2 分钟建好。

---

## 第 2 步：建表（关键一步，别漏）

1. 左侧栏点 **SQL Editor**（图标像一张纸带 `>_`）。
2. 点 **New query**。
3. 用记事本打开项目里的 `supabase/schema.sql`，**全选、复制、粘贴**到编辑器里。
4. 点右下角 **Run**（或按 `Ctrl+Enter`）。
5. 看到 **Success. No rows returned** 就对了。

> 这段 SQL 建了 6 张表、开了行级权限、建了两个函数（建家 / 邀请码入家）。
> 想确认成功，可以再粘这一句运行，应看到 6 行 `rowsecurity = true`：
> ```sql
> select tablename, rowsecurity from pg_tables where schemaname='public' order by tablename;
> ```

---

## 第 3 步：关掉邮箱确认（强烈建议）

Supabase 默认要求点邮件里的链接才能登录。家里的老人小孩用起来会卡住，建议关掉。

1. 左侧栏 **Authentication** → **Sign In / Providers**（有的版本叫 **Providers**）
2. 找到 **Email**，点开
3. 把 **Confirm email** 的开关**关掉**（变成灰色）
4. 点 **Save**

> 代价：任何知道网址的人理论上能拿任意邮箱注册。但注册后必须**有邀请码才能进你家账本**，
> 而且数据库有行级权限兜底，别人看不到你家的账。对家庭自用足够了。

---

## 第 4 步：拿到地址和 key

1. 左侧栏最下面 **Project Settings**（齿轮）→ **API**（有的版本叫 **Data API**）
2. 复制两样东西：
   - **Project URL**：形如 `https://abcdefghijkl.supabase.co`
   - **anon / public** 那个 key：一长串 `eyJ...` 开头的字符串

> ⚠️ 只复制 **anon public**，**不要**复制 `service_role`。service_role 是管理员密钥，泄露等于把数据库交出去。

> 补充一句免得你担心：这个 anon key **会随代码一起公开**，这是正常的。它只是「匿名访客」的身份牌，
> 能读什么、能写什么完全由数据库的行级权限决定（第 2 步那段 SQL 已经设好：谁都只能看自己家的账）。
> 真正不能泄露的是 `service_role`，它绕过所有权限检查。

3. 打开项目里的 `src/config.js`，把这两个值填进去：

```js
export const CONFIG = {
  appName: '家庭记账本',
  supabaseUrl: 'https://abcdefghijkl.supabase.co',
  supabaseAnonKey: 'eyJhbGciOi...（很长一串）',
  ...
};
```

保存。此时再 `node tools/serve.js`，页面就会变成**登录页**，说明连上了。

---

## 第 5 步：跑一次自检（30 秒，强烈建议）

填完地址和 key 之后，先别急着推代码，跑这个：

```bash
node tools/check-config.js
```

它会真的去问 Supabase 几件事，然后逐条告诉你结果：

- ✅ 项目地址有效 / ❌ anon key 不对 / ❌ 地址写错
- ✅ 6 张表建好了且**行级权限生效**（匿名读不到任何数据）
- ❌ 表不存在 → 回第 2 步跑 schema.sql
- ❌ **匿名能读到数据** → 行级权限没开，**先别上线**，重跑 schema.sql
- ✅ 建家/邀请码函数就位 / ❌ 函数缺失 → schema.sql 没跑完
- ✅ 注册后可直接登录 / ⚠️ 邮箱确认还开着 → 回第 3 步关掉

全绿就可以往下走了。这个脚本只读，不会写任何数据、也不会建账号。

再跑一句资源检查（10 秒），专治「本地能开、Pages 白屏」：

```bash
node tools/check-assets.js
```

它会确认所有引用的文件和 import 都真实存在，而且**大小写完全一致**——Windows 不区分大小写，GitHub Pages 是 Linux，
`Utils.js` 写成 `utils.js` 在你电脑上没事，推上去就白屏。这一句能提前 15 分钟发现它。

---

## 第 6 步：推到 GitHub

在项目目录里执行（把 `你的用户名` 换成你的 GitHub 用户名）：

```bash
git remote add origin https://github.com/你的用户名/Household-expenses.git
git branch -M main
git push -u origin main
```

第一次推送会弹窗让你登录 GitHub，点授权即可。

> 如果还没建仓库：去 <https://github.com/new>，**Repository name** 填 `Household-expenses`，
> 选 **Public**（Pages 免费版需要公开仓库），**不要**勾选 Add a README，点 **Create repository**。

---

## 第 7 步：打开 GitHub Pages

1. 进入仓库页面 → **Settings**（顶部）→ 左侧 **Pages**
2. **Source** 选 **Deploy from a branch**
3. **Branch** 选 `main`，目录选 `/ (root)`，点 **Save**
4. 等 1～2 分钟，页面上方会出现网址：

```
https://你的用户名.github.io/Household-expenses/
```

**这就是你家的记账本地址。** 手机浏览器打开，建议：
- iPhone Safari：分享 → **添加到主屏幕**
- 安卓 Chrome：右上角 ⋮ → **添加到主屏幕**

之后就像 App 一样，一点就开。

---

## 第 8 步：家人各就各位

1. **你自己**：打开网址 → 注册（邮箱 + 密码 + 称呼）→ 选「创建家庭」→ 填家庭名、你的称呼、身份（爸爸 / 妈妈 / 孩子）
2. 建好后去 **我的** 页，能看到 **6 位邀请码**，点「复制」
3. **家人**：各自打开同一个网址 → 注册自己的账号 → 选「邀请码加入」→ 输入那 6 位码 + 自己的称呼和身份
4. 从此大家记的账进同一本，**流水里能看到是谁记的**，统计里能按人看

---

## 以后改了代码怎么更新

改完 `git push` 就行，GitHub Pages 会自动重新发布，一两分钟后刷新页面即生效。

---

## 常见问题

| 现象 | 原因与处理 |
|---|---|
| 打开是演示模式，不是登录页 | `src/config.js` 里的地址或 key 没填对，检查有没有多余空格 |
| 注册后提示「需要点邮件链接」 | 第 3 步没关掉 Confirm email，回去关掉再注册（已注册的账号可直接登录试试） |
| 提示「邀请码不对」 | 邀请码是 6 位大写字母数字，注意别把 `0/O`、`1/I` 看错（生成时已避开这几个字符） |
| 记账后家人看不到 | 检查两件事：① 家人用的是同一个网址 ② 家人确实输邀请码加入了（我的页应该显示同一个家庭名） |
| 页面 404 | Pages 还没构建完，等两分钟；或分支/目录选错了，回第 7 步重选 |
| 语音按钮提示不支持 | 用 Chrome / Edge（安卓可用）；iPhone 的 Safari 对网页语音识别支持不稳定，建议直接打字 |
| 数据想备份 | 「流水」页底部有「导出这个月的 Excel（CSV）」，也可在 Supabase 的表编辑器里导出 CSV |

---

## 关于费用的实话

| 项目 | 费用 |
|---|---|
| Supabase Free | 0 元。含 500MB 数据库、每月 5GB 流量、无限 API 请求。一家三口的账，一年也就几 MB |
| GitHub Pages | 0 元（公开仓库） |
| 域名 | 不需要，用 `*.github.io` 的子路径 |
| 手机 App | 不需要，加到桌面即可 |

唯一的隐性成本：Supabase 免费项目**连续 7 天完全没访问会被暂停**，下次打开会自动唤醒（有点慢）。
天天记账的话不会遇到；真遇到点一下网页等一下就好。
