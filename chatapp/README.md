# 轻聊 · 免费在线聊天网页

手机号注册、手机号加好友、实时收发文字 / 图片 / 视频 / 文件。
前端托管在 GitHub Pages，后端用 Supabase 免费额度，**全程零费用、不需要短信通道**。

---

## 目录结构

```
index.html              页面结构
assets/style.css        样式（自适应手机 / 电脑）
assets/config.js        ★ 唯一需要你修改的文件
assets/app.js           全部业务逻辑
supabase/schema.sql     ★ 需要在 Supabase 里执行一次
```

---

## 部署步骤（约 10 分钟）

### 第 1 步 · 创建 Supabase 项目

1. 打开 https://supabase.com ，用 GitHub 账号登录，点 **New project**。
2. 项目名随意，数据库密码自己保存好，区域选 **Singapore** 或 **Tokyo**（国内访问相对快）。
3. 等待 1–2 分钟初始化完成。

### 第 2 步 · 建表和权限

1. 左侧菜单 **SQL Editor** → **New query**。
2. 把 `supabase/schema.sql` 全文复制进去，点 **Run**。
3. 看到 `Success. No rows returned` 即成功。这一步建好了三张表、行级安全策略、实时推送和文件桶。

### 第 3 步 · 关闭邮箱验证（关键）

本项目把手机号在内部映射成一个虚拟邮箱来复用免费的密码登录，所以必须关掉邮件确认：

**Authentication** → **Sign In / Providers** → **Email** → 关闭 **Confirm email** → 保存。

> 不关的话，注册后会卡在"等待邮件确认"，而那个虚拟邮箱收不到任何邮件。

### 第 4 步 · 填配置

**Project Settings** → **API**，复制两个值，填进 `assets/config.js`：

```js
SUPABASE_URL: 'https://xxxxxxxx.supabase.co',
SUPABASE_ANON_KEY: 'eyJhbGciOi....'
```

> `anon key` 是设计上就可以公开在前端的。真正的安全边界是数据库的 RLS 策略——
> 别人拿到这个 key 也只能读到自己的数据。
> **千万不要**把 `service_role` key 放进来。

### 第 5 步 · 推到 GitHub 并开启 Pages

```bash
git init
git add .
git commit -m "轻聊：在线聊天网页"
git branch -M main
git remote add origin https://github.com/你的用户名/仓库名.git
git push -u origin main
```

然后在仓库页面：**Settings** → **Pages** → Source 选 **Deploy from a branch**
→ 分支 `main`、目录 `/ (root)` → Save。

一两分钟后访问 `https://你的用户名.github.io/仓库名/` 即可。

### 第 6 步 · 试一试

用两个浏览器（或手机 + 电脑）分别注册两个手机号，互相搜索、加好友、发消息。

---

## 功能说明

| 功能 | 实现方式 |
|---|---|
| 手机号注册 | 手机号作为唯一账号 + 自设密码，**不发短信、不花钱** |
| 手机号加好友 | 精确搜索手机号 → 发送申请 → 对方同意后才能互发消息 |
| 文字消息 | 存 PostgreSQL，WebSocket 实时推送，秒级到达 |
| 图片 / 视频 | 上传到私有存储桶，用 1 小时有效的签名链接展示 |
| 任意文件 | 同上，以文件卡片形式展示，点击下载 |
| 手机适配 | 窄屏自动切换为单栏 + 返回按钮 |

## 安全边界

- 三张表全部开启 RLS：**你只能读到自己收发的消息、自己相关的好友关系**。
- 发消息前数据库会校验双方是否已成为好友，绕过前端也发不出去。
- 文件桶是私有的，只有该文件的上传者或聊天对方能生成访问链接。
- 手机号在好友申请列表里做了脱敏显示（`138****8000`）。

## 免费额度与注意事项

| 项目 | Supabase 免费版 |
|---|---|
| 数据库 | 500 MB（纯文字消息约可存百万条） |
| 文件存储 | 1 GB ← **视频最吃这个** |
| 每月流量 | 5 GB |
| 实时连接 | 200 并发 |
| 项目休眠 | 连续 7 天无任何请求会暂停，登录控制台点一下即可恢复 |

默认单文件上限：图片 5 MB、视频 50 MB、其他文件 20 MB，在 `config.js` 里可改。
建议定期清理旧的媒体文件，1 GB 大约只够几十条手机短视频。

## 常见问题

**注册时提示 "Email address is invalid"**
把 `config.js` 里的 `EMAIL_DOMAIN` 从 `chatapp.local` 改成 `example.com`，重新注册。

**注册后没有自动登录**
第 3 步的 "Confirm email" 没关。关掉后，把该用户在 Authentication → Users 里删掉再重新注册。

**消息不实时，刷新才看得到**
`schema.sql` 第 7 节没执行成功。到 Database → Replication，确认 `messages` 和 `friendships`
已加入 `supabase_realtime` 发布。

**加好友后发消息报"没有权限"**
好友申请还是 pending 状态，需要对方在「新的好友」里点同意。

**打开页面提示"还没配置后端"**
`config.js` 里还是占位符，回到第 4 步。

## 使用范围提醒

本项目适合自己和朋友的小范围使用。如果要面向公众开放注册运营即时通讯服务，
国内需要 ICP 备案、用户实名认证等资质，那是另一套合规流程。
