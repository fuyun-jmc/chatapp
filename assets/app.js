/* ============================================================
 *  轻聊 · 前端逻辑
 *  手机号注册登录 / 按手机号加好友 / 实时收发文字、图片、视频、文件
 * ============================================================ */
(function () {
  'use strict';
  console.log('[chatapp] app.js build v219 loaded');

  var CFG = window.CHAT_CONFIG || {};
  var PHONE_RE = /^1[3-9]\d{9}$/;
  var AVATAR_COLORS = ['#4f7cf7', '#1d9e75', '#d85a30', '#7f77dd', '#d4537e', '#ba7517', '#378add'];

  var $ = function (id) { return document.getElementById(id); };

  /* 原生 <dialog> 弹窗开关（安全：重复打开/关闭不抛异常） */
  function showModal(id) { var m = $(id); if (m) { m.classList.add('open'); m.removeAttribute('hidden'); } }
  function hideModal(id) { var m = $(id); if (m) { m.classList.remove('open'); m.setAttribute('hidden', ''); } if (id === 'admin-panel') state.adminPanelOpen = false; }

  /* ---------- 配置检查 ---------- */
  var configured = CFG.SUPABASE_URL && CFG.SUPABASE_URL.indexOf('YOUR_') === -1 &&
                   CFG.SUPABASE_ANON_KEY && CFG.SUPABASE_ANON_KEY.indexOf('YOUR_') === -1;
  if (!configured) {
    $('config-warning').hidden = false;
    return;
  }

  // 兜底：若 supabase 库（本地 vendor 或 CDN）未加载成功，明确报错而非卡在“正在登录…”
  if (typeof window.supabase === 'undefined' || !window.supabase || !window.supabase.createClient) {
    var bw = document.getElementById('boot');
    if (bw) { bw.querySelector('.boot-text').textContent = '前端依赖加载失败：supabase 库未就绪'; }
    var cw = document.getElementById('config-warning');
    if (cw) {
      cw.hidden = false;
      cw.querySelector('span').textContent = '核心依赖 supabase.js 未能加载，请检查网络或刷新重试（建议硬刷新 Ctrl/Cmd+Shift+R）。';
    }
    console.error('[chatapp] supabase global missing — vendor script failed to load');
    return;
  }

  var sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
  });

  // Supabase JS 的 sb.rpc() 在某些环境下返回 thenable 而非完整 Promise，
  // 直接链式 .catch() 会报 "is not a function"。统一包装成真正 Promise。
  (function () {
    var orig = sb.rpc;
    sb.rpc = function () {
      return Promise.resolve(orig.apply(sb, arguments));
    };
  })();

  var BUCKET = CFG.BUCKET || 'chat-files';
  var LIMIT = CFG.HISTORY_LIMIT || 300;

  var state = {
    uid: null,
    profile: null,
    friends: [],        // { id, phone, nickname }
    incoming: [],       // 待我处理的好友申请
    groups: [],         // { id, name, ownerId, memberIds, memberCount, iAmOwner }
    groupRemarks: {},    // { groupId: remark }  我给各群设置的个人备注（仅自己可见）
    groupNicknames: {},  // { groupId: { userId: nickname } }  群内昵称（对全群成员可见）
    drafts: {},          // { draftKey: { text, ts } }  聊天草稿缓存（服务端为准，跨设备同步）
    profilesById: {},   // uid -> { nickname, avatar_path, phone }
    active: null,       // 当前会话：好友对象或群组对象（type==='group'）
    chatVisible: false, // 聊天面板是否真正显示在眼前（openChat 设 true、返回列表/收起设 false）；
                        // 仅 state.active 不足以判断“正在看”，因为返回列表后 active 仍保留，
                        // 会导致误判“已打开该会话”而漏记未读 / 不浮顶
    unread: {},         // { peerId: number }  未读消息计数（好友或群）
    convTs: {},          // { convId: number }  会话“浮顶”时间戳；收到新消息或查看后设为 Date.now()，用于排序让它停留前置
    recallTimer: null,  // 定时刷新“撤回/删除”按钮的定时器
    urlCache: {},       // file_path -> signed url
    channel: null,
    deviceToken: null,  // 本机设备会话 token（持久在 localStorage）
    heartbeat: null,    // 心跳定时器
    forceChangePwd: false, // 账号找回后强制改密码
    recPhone: '',
    recCode: '',
    lastActive: {},     // uid -> last_active ISO 时间（好友在线状态）
    onlineTimer: null,  // 在线状态轮询定时器
    presenceChannel: null, // 在线状态 Realtime 广播频道
    titlesMap: {},       // uid -> { primary:{titleId,titleName,frameColor,frameStyle}|null, primary2:{...}|null, admin:{...}|null, dev:{...}|null }
                         // primary=自选展示称号；admin=强制佩戴的「管理员」；dev=强制佩戴的「开发者」（专属头像框）
    gmAdminUid: null,    // 后端 gm_admin_uid() 返回的管理员 uid；未取到时回退到 GM_ADMIN_UID 常量
    forbiddenWords: [],  // 违禁词（小写），登录后从 forbidden_words 表拉取，发送消息时检测
    isAdmin: false,      // 是否持有「管理员」称号（侧边栏显示违禁接收入口的开关）
    isDev: false,        // 是否持有「开发者」称号（专属头像框）
    ownedTitles: [],     // 当前用户已拥有的全部称号名称
    adminTitleId: null,  // 「管理员」称号在 titles 表里的真实 id（按 id 判断强制佩戴，最可靠）
    devTitleId: null,    // 「开发者」称号在 titles 表里的真实 id
    hideDevTitle: false, // 是否隐藏「开发者」称号（仅影响展示，权限不变；管理员称号不可隐藏）
    devTitleRow: null,   // 最近一次查到的「开发者」称号行，用于隐藏开关即时切换展示
    profileTitleSig: {}, // uid -> 称号列签名（实时通道过滤用：仅称号变化才刷新）
    titleReloadTimer: {}, // uid -> 节流定时器，避免同一用户高频刷新
    devHiddenMap: {},    // uid -> boolean，记录每位用户的 hide_dev_title（影响所有 viewer）
    activeSenderIds: {}, // uid -> 1：当前会话（群聊含发言者）/ 群资料成员，称号变化需实时同步的人
    gmPollTimer: null    // GM 看板轮询定时器
  };

  // 超过该时长未活跃即视为离线（与心跳 30s 间隔匹配，留足余量）
  var ONLINE_WINDOW_MS = 2 * 60 * 1000;

  /* ============================================================
   *  工具函数
   * ============================================================ */
  function toast(msg, ms) {
    var el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.hidden = true; }, ms || 2600);
  }

  function colorOf(seed) {
    var s = String(seed || ''), n = 0;
    for (var i = 0; i < s.length; i++) n = (n * 31 + s.charCodeAt(i)) >>> 0;
    return AVATAR_COLORS[n % AVATAR_COLORS.length];
  }

  function initialOf(name) { return (name || '?').trim().charAt(0).toUpperCase(); }

  /* 显示名：有备注时“备注名（对方昵称）”，否则显示昵称 */
  function displayName(peer) {
    if (peer.remark && peer.remark !== peer.nickname) {
      return peer.remark + '（' + peer.nickname + '）';
    }
    return peer.remark || peer.nickname || '用户';
  }

  /* 群聊显示名：有备注时「备注（群名）」，否则显示群名 */
  function groupDisplayName(g) {
    if (!g) return '群聊';
    return g.remark ? g.remark + '（' + g.name + '）' : (g.name || '未命名群聊');
  }

  /* 拉取我的所有群备注（后端 SQL 未执行时静默降级，不影响主流程） */
  function loadGroupRemarks() {
    return sb.rpc('get_my_group_remarks')
      .then(function (r) {
        if (r.error) throw r.error;
        state.groupRemarks = {};
        (r.data || []).forEach(function (row) {
          if (row.group_id && row.remark != null) state.groupRemarks[row.group_id] = row.remark;
        });
      })
      .catch(function () { state.groupRemarks = state.groupRemarks || {}; });
  }

  /* 取某群内某成员的群昵称（优先），取不到则回退到全局昵称 */
  function groupNicknameOf(gid, uid) {
    if (gid && uid && state.groupNicknames[gid] && state.groupNicknames[gid][uid]) {
      return state.groupNicknames[gid][uid];
    }
    var p = state.profilesById[uid];
    return p ? p.nickname : null;
  }

  /* 拉取某群所有成员的群昵称（后端 SQL 未执行时静默降级，不影响主流程） */
  function loadGroupNicknames(gid) {
    if (!gid) return Promise.resolve();
    return sb.rpc('get_group_nicknames', { p_group_id: gid })
      .then(function (r) {
        if (r.error) throw r.error;
        if (!state.groupNicknames[gid]) state.groupNicknames[gid] = {};
        (r.data || []).forEach(function (row) {
          if (row.user_id && row.nickname != null) state.groupNicknames[gid][row.user_id] = row.nickname;
        });
      })
      .catch(function () { state.groupNicknames[gid] = state.groupNicknames[gid] || {}; });
  }

  /* 群昵称数据到位后，刷新当前群聊的消息发送者名与（打开的）成员列表 */
  function refreshGroupNicknameDisplays(gid) {
    if (!gid) return;
    var box = $('messages');
    if (box && state.active && state.active.type === 'group' && state.active.id === gid) {
      var nodes = box.querySelectorAll('.msg.group-in');
      Array.prototype.forEach.call(nodes, function (n) {
        var uid = n.dataset.sender;
        if (!uid) return;
        var senderEl = n.querySelector('.msg-sender');
        var nm = groupNicknameOf(gid, uid) || '成员';
        if (senderEl) senderEl.textContent = nm;
      });
    }
    var modal = $('group-info-modal');
    if (modal && modal.classList.contains('open') && state.active && state.active.id === gid) {
      renderMemberList(state.active);
    }
  }

  /* ============================================================
   *  聊天草稿：存于服务端，跨设备 / 退出网页不丢失
   * ============================================================ */
  function draftKey(peerId, isGroup) { return (isGroup ? 'g:' : 'u:') + peerId; }

  function getDraft(peerId, isGroup) {
    var d = state.drafts[draftKey(peerId, isGroup)];
    return (d && d.text) ? d.text : '';
  }

  function setDraftCache(peerId, isGroup, text) {
    var k = draftKey(peerId, isGroup);
    if (text && text.trim()) state.drafts[k] = { text: text, ts: Date.now() };
    else delete state.drafts[k];
  }

  /* 拉取我的全部草稿（登录后一次性加载到本地缓存，供列表标记与打开会话恢复） */
  function loadMyDrafts() {
    return sb.rpc('get_my_drafts')
      .then(function (r) {
        if (r.error) throw r.error;
        state.drafts = {};
        (r.data || []).forEach(function (row) {
          if (row.peer_id) setDraftCache(row.peer_id, row.is_group, row.text || '');
        });
      })
      .catch(function () { state.drafts = state.drafts || {}; });
  }

  var pendingDraft = null;   // { peerId, isGroup, text }  等待 debounce 落库的草稿
  var draftSaveTimer = null;

  function doSaveDraft(peerId, isGroup, text) {
    if (!peerId) return;
    var k = draftKey(peerId, isGroup);
    var existed = !!state.drafts[k];
    setDraftCache(peerId, isGroup, text);
    var nowExists = !!state.drafts[k];
    // 本地先写好，保证离线/断网也即时恢复；再尝试落库
    sb.rpc('save_my_draft', { p_peer: peerId, p_is_group: isGroup, p_text: text || '' })
      .catch(function () {});
    // 仅当“有无草稿”状态变化时才重绘会话列表（避免打字时反复重渲染）
    if (existed !== nowExists) renderConversations();
  }

  function scheduleSaveDraft(peerId, isGroup, text) {
    pendingDraft = { peerId: peerId, isGroup: isGroup, text: text };
    if (draftSaveTimer) clearTimeout(draftSaveTimer);
    draftSaveTimer = setTimeout(function () {
      draftSaveTimer = null;
      if (pendingDraft) {
        doSaveDraft(pendingDraft.peerId, pendingDraft.isGroup, pendingDraft.text);
        pendingDraft = null;
      }
    }, 600);
  }

  /* 立即把待保存的草稿落库（切换会话 / 页面隐藏前调用，防止丢失最后一次输入） */
  function flushDraft() {
    if (draftSaveTimer) { clearTimeout(draftSaveTimer); draftSaveTimer = null; }
    if (pendingDraft) {
      doSaveDraft(pendingDraft.peerId, pendingDraft.isGroup, pendingDraft.text);
      pendingDraft = null;
    }
  }

  /* 发送成功后清空草稿（本地 + 服务端） */
  function clearDraft(peerId, isGroup) {
    if (!peerId) return;
    var k = draftKey(peerId, isGroup);
    var existed = !!state.drafts[k];
    delete state.drafts[k];
    sb.rpc('save_my_draft', { p_peer: peerId, p_is_group: isGroup, p_text: '' })
      .catch(function () {});
    if (existed) renderConversations();
  }

  /* textarea 自适应高度：空内容保底一行高度，防止 box-sizing 下 scrollHeight 为 0 塌缩 */
  function fitTextarea(ta) {
    if (!ta) return;
    ta.style.height = 'auto';
    var minH = 40; // 一行 + padding + border 的保底高度
    ta.style.height = Math.max(minH, Math.min(ta.scrollHeight, 120)) + 'px';
  }

  /* 其他设备（或本设备回声）的草稿变更：更新缓存并同步到输入框（非编辑态时） */
  function applyRemoteDraft(row, isDelete) {
    if (!row || !row.user_id || row.user_id !== state.uid) return;
    var k = draftKey(row.peer_id, row.is_group);
    var existed = !!state.drafts[k];
    setDraftCache(row.peer_id, row.is_group, isDelete ? '' : (row.text || ''));
    var nowExists = !!state.drafts[k];
    if (existed !== nowExists) renderConversations();
    var inp = $('msg-input');
    if (state.active && state.active.id === row.peer_id &&
        state.active.type === (row.is_group ? 'group' : 'friend') &&
        document.activeElement !== inp) {
      var t = getDraft(row.peer_id, row.is_group);
      inp.value = t || '';
      fitTextarea(inp);
    }
  }

  /* 统一渲染头像：有自定义头像图则显示图片，否则显示首字母色块 */
  function setAvatar(node, opts) {
    opts = opts || {};
    var name = opts.nickname || opts.phone || '?';
    var seed = opts.phone || name;
    // 保留右下角在线状态点：清空头像内容时跳过 .online-dot，
    // 否则（尤其带图片头像）图片加载完成或重渲染会把状态点连带删掉，
    // 表现为「隐藏称号后列表头像不显示在线状态圆点」
    var dot = node.querySelector('.online-dot');
    removeChildrenExcept(node, dot);
    node.style.background = colorOf(seed);
    if (opts.avatarPath) {
      signedUrl(opts.avatarPath).then(function (url) {
        if (!url) { setAvatarText(node, dot, initialOf(name)); return; }
        var im = new Image();
        im.className = 'avatar-img';
        im.alt = name;
        im.onload = function () {
          var cur = node.querySelector('.online-dot');
          removeChildrenExcept(node, cur);
          node.style.background = 'transparent';
          if (cur && cur.parentNode === node) node.insertBefore(im, cur);
          else node.appendChild(im);
          if (cur && cur.parentNode !== node) node.appendChild(cur);
        };
        im.onerror = function () { setAvatarText(node, node.querySelector('.online-dot'), initialOf(name)); };
        im.src = url;
      });
    } else {
      setAvatarText(node, dot, initialOf(name));
    }
  }

  // 清空 node 的全部子节点，但保留 except（在线状态点）；若 except 被提前摘下则放回
  function removeChildrenExcept(node, except) {
    var c = node.childNodes, i;
    for (i = c.length - 1; i >= 0; i--) {
      if (c[i] === except) continue;
      node.removeChild(c[i]);
    }
    if (except && except.parentNode !== node) node.appendChild(except);
  }
  function setAvatarText(node, dot, txt) {
    removeChildrenExcept(node, dot);
    node.appendChild(document.createTextNode(txt));
    if (dot && dot.parentNode !== node) node.appendChild(dot);
  }

  // 群聊图标：有自定义图标则显示图片，否则回退到「群名首字 + 紫底」
  function setGroupAvatar(node, g) {
    if (!node) return;
    g = g || {};
    // 群图标不应带任何个人称号头像框（开发者/管理员/称号环），无论来自哪个调用点都先清除
    node.style.boxShadow = '';
    node.style.border = '';
    if (node.classList) {
      node.classList.remove('dev-frame');
      node.classList.remove('avatar-admin');
    }
    node.title = '';
    var name = g.remark || g.name || '群聊';
    node.textContent = '';
    node.style.background = '#7f77dd';
    var old = node.querySelector('img');
    domRemove(old);
    if (g.avatar) {
      signedUrl(g.avatar).then(function (url) {
        if (!url) { node.textContent = name.charAt(0); return; }
        var im = new Image();
        im.className = 'avatar-img';
        im.alt = name;
        im.onload = function () {
          node.textContent = '';
          node.style.background = 'transparent';
          node.appendChild(im);
        };
        im.onerror = function () { node.textContent = name.charAt(0); };
        im.src = url;
      });
    } else {
      node.textContent = name.charAt(0);
    }
  }

  function maskPhone(p) {
    return p && p.length === 11 ? p.slice(0, 3) + '****' + p.slice(7) : (p || '');
  }

  function fmtSize(bytes) {
    if (!bytes && bytes !== 0) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  function fmtTime(iso) {
    var d = new Date(iso);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function dayKey(iso) {
    var d = new Date(iso);
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }

  function dayLabel(iso) {
    var d = new Date(iso), now = new Date();
    var today = dayKey(now.toISOString());
    var yest = new Date(now.getTime() - 86400000);
    if (dayKey(iso) === today) return '今天';
    if (dayKey(iso) === dayKey(yest.toISOString())) return '昨天';
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  function emailFor(phone) {
    return phone + '@' + (CFG.EMAIL_DOMAIN || 'chatapp.local');
  }

  function friendlyError(err) {
    var m = (err && (err.message || err.error_description)) || '操作失败，请重试';
    if (/Invalid login credentials/i.test(m)) return '手机号或密码不正确';
    if (/User already registered|already been registered/i.test(m)) return '该手机号已注册，请直接登录';
    if (/Password should be at least/i.test(m)) return '密码至少需要 6 位';
    if (/Email address .* is invalid|Email address is invalid/i.test(m))
      return '注册被邮箱格式校验拦截：请把 config.js 里的 EMAIL_DOMAIN 改成 example.com 再试';
    if (/duplicate key|profiles_phone_key/i.test(m)) return '该手机号已被占用';
    if (/row-level security|violates row-level/i.test(m)) return '没有权限执行该操作（可能还不是好友）';
    if (/rate limit|too many/i.test(m)) return '操作太频繁，请稍后再试';
    if (/CANNOT_MUTE_SELF/.test(m)) return '不能禁言自己';
    if (/CANNOT_UNMUTE_SELF/.test(m)) return '不能解除自己的禁言';
    if (/ONLY_DEV_CAN_UNMUTE_ADMIN/.test(m)) return '该用户为管理员，仅开发者可解除其禁言';
    if (/Failed to fetch|NetworkError/i.test(m)) return '网络连接失败，检查网络或 Supabase 地址是否正确';
    return m;
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // 聊天区「空会话」占位文案（清空聊天记录后也用它），统一常量避免各处硬编码写歪
  var EMPTY_TIP = '还没有消息，打个招呼吧';

  // 老 WebView（微信/QQ 内置浏览器）不支持 ChildNode.remove() / replaceWith()，
  // 直接调用会抛 TypeError 并中断整个回调，统一走 parentNode 兼容写法。
  function domRemove(node) {
    if (node && node.parentNode) node.parentNode.removeChild(node);
  }
  function domReplace(oldNode, newNode) {
    if (!oldNode || !oldNode.parentNode) return;
    if (newNode) oldNode.parentNode.replaceChild(newNode, oldNode);
    else oldNode.parentNode.removeChild(oldNode);
  }

  function fmtDateTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
           ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /* ============================================================
   *  登录设备管理（查看 / 注销设备）
   * ============================================================ */
  function detectDeviceName() {
    var ua = navigator.userAgent || '';
    var os = '未知系统';
    if (/iPhone/.test(ua)) os = 'iPhone';
    else if (/iPad/.test(ua)) os = 'iPad';
    else if (/Android/.test(ua)) os = 'Android 设备';
    else if (/Windows Phone/.test(ua)) os = 'Windows Phone';
    else if (/Windows/.test(ua)) os = 'Windows';
    else if (/Mac OS X|Macintosh/.test(ua)) os = 'Mac';
    else if (/Linux/.test(ua)) os = 'Linux';
    var br = '浏览器';
    if (/Edg\//.test(ua)) br = 'Edge';
    else if (/OPR\//.test(ua)) br = 'Opera';
    else if (/Chrome\//.test(ua)) br = 'Chrome';
    else if (/Firefox\//.test(ua)) br = 'Firefox';
    else if (/Safari\//.test(ua)) br = 'Safari';
    return os + ' · ' + br;
  }

  function getDeviceToken() {
    try {
      var k = 'chatapp_device_token';
      var t = localStorage.getItem(k);
      if (!t) {
        t = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
            : Date.now() + '-' + Math.random().toString(36).slice(2);
        localStorage.setItem(k, t);
      }
      return t;
    } catch (e) { return 'anon-' + Math.random().toString(36).slice(2); }
  }

  /* ============================================================
   *  记住上次登录的手机号（用于自动预填，降低重新登录成本）
   *  说明：Supabase 已开启 persistSession，会话未过期时打开网页会
   *  自动恢复 session 直接登录（见 getSession 逻辑）。此处仅在
   *  WebView 清缓存导致 session 丢失时，帮助用户省去重输手机号。
   *  出于安全考虑，不保存密码，密码仍需手动输入。
   * ============================================================ */
  var ACCOUNTS_KEY = 'chatapp.accounts';          // JSON 数组，最新在前，保存登录过的账号
  var LAST_PHONE_KEY = 'chatapp.lastLoginPhone';  // 标记上次登录的账号（用于高亮/默认选中）

  // 记住一个登录过的账号：去重并放到列表最前，最多保留 8 个
  function rememberAccount(phone) {
    phone = (phone || '').trim();
    if (!phone) return;
    var list = getAccounts().filter(function (p) { return p !== phone; });
    list.unshift(phone);
    if (list.length > 8) list = list.slice(0, 8);
    try { localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(list)); } catch (e) {}
    try { localStorage.setItem(LAST_PHONE_KEY, phone); } catch (e) {}
  }
  function getAccounts() {
    try {
      var raw = localStorage.getItem(ACCOUNTS_KEY);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.filter(function (p) { return typeof p === 'string' && p; }) : [];
    } catch (e) { return []; }
  }
  function removeAccount(phone) {
    var list = getAccounts().filter(function (p) { return p !== phone; });
    try { localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(list)); } catch (e) {}
  }
  function getLastPhone() {
    try { return localStorage.getItem(LAST_PHONE_KEY) || ''; } catch (e) { return ''; }
  }

  // 被其他设备注销时，清掉本机「该账号」的登录痕迹：从账号列表移除、清除上次登录标记、
  // 清除本机设备令牌，使目标设备回到干净登录页且不再自动登录。仅作用于当前账号，不影响同机其他账号。
  function clearCurrentAccountLocal() {
    try {
      var phone = (state.profile && state.profile.phone) || getLastPhone();
      if (!phone) return;
      removeAccount(phone);
      if (getLastPhone() === phone) {
        try { localStorage.removeItem(LAST_PHONE_KEY); } catch (e) {}
      }
      try { localStorage.removeItem('chatapp_device_token'); } catch (e) {}
    } catch (e) {}
  }

  // 渲染登录页的「已登录账号」列表：点击账号自动填入手机号并聚焦密码框，
  // 密码需用户自行输入（出于安全不保存密码）。
  function renderAccountList() {
    var wrap = $('account-list');
    if (!wrap) return;
    var list = getAccounts();
    wrap.innerHTML = '';
    if (!list.length) { wrap.hidden = true; return; }
    wrap.hidden = false;
    wrap.appendChild(el('div', 'account-list-title', '选择账号'));
    var last = getLastPhone();
    list.forEach(function (phone) {
      var chip = el('button', 'account-chip' + (phone === last ? ' is-last' : ''), '');
      chip.type = 'button';
      chip.setAttribute('data-phone', phone);
      chip.appendChild(el('span', 'account-phone', phone));
      var del = el('span', 'account-del', '×');
      del.setAttribute('data-del', phone);
      del.title = '移除该账号';
      chip.appendChild(del);
      wrap.appendChild(chip);
    });
    var other = el('button', 'account-chip account-chip-other', '使用其他账号');
    other.type = 'button';
    other.setAttribute('data-other', '1');
    wrap.appendChild(other);
  }

  // 页面切回登录态时刷新账号列表，并默认填好“上次登录”的手机号
  function initLoginRemembered() {
    renderAccountList();
    var phone = getLastPhone() || getAccounts()[0] || '';
    if (phone) {
      $('login-phone').value = phone;
      try { $('login-password').focus(); } catch (e) {}
    }
  }

  // 登录页账号列表点击委托：删除账号 / 选中账号填入 / 使用其他账号
  function onAccountListClick(e) {
    function up(node, sel) {
      while (node && node.nodeType === 1) {
        if (node.matches && node.matches(sel)) return node;
        node = node.parentNode;
      }
      return null;
    }
    var del = up(e.target, '.account-del');
    if (del) {
      e.preventDefault();
      removeAccount(del.getAttribute('data-del'));
      renderAccountList();
      return;
    }
    var chip = up(e.target, '.account-chip');
    if (!chip) return;
    if (chip.getAttribute('data-other')) {
      $('login-phone').value = '';
      $('login-password').value = '';
      try { $('login-phone').focus(); } catch (e2) {}
      return;
    }
    var phone = chip.getAttribute('data-phone') || '';
    if (!phone) return;
    $('login-phone').value = phone;
    $('login-password').value = '';
    try { $('login-password').focus(); } catch (e2) {}
  }

  // 登录时记录本机设备；表不存在（未跑迁移）时静默失败，不影响登录
  function registerDeviceSession() {
    if (!state.uid) return;
    var token = getDeviceToken();
    state.deviceToken = token;
    sb.from('device_sessions').upsert({
      token: token,
      user_id: state.uid,
      device_name: detectDeviceName(),
      user_agent: navigator.userAgent || '',
      last_seen: new Date().toISOString()
    }, { onConflict: 'token' })
      .then(function (r) { if (r.error) console.warn('registerDeviceSession:', r.error.message); })
      .catch(function (e) { console.warn('registerDeviceSession failed:', e && e.message); });
    // 登录即标记在线
    touchLastActive();
  }

  // 每 15s 保活 + 检测本机行是否被注销（被踢则自动登出），并广播在线状态
  function startHeartbeat() {
    if (state.heartbeat) clearInterval(state.heartbeat);
    state.heartbeat = setInterval(function () {
      if (!state.uid || !state.deviceToken) return;
      var token = state.deviceToken;
      // 保活自己的在线状态
      touchLastActive();
      broadcastPresence();
      sb.from('device_sessions').update({ last_seen: new Date().toISOString() })
        .eq('token', token)
        .then(function (r) {
          if (r.error && /does not exist|relation/.test(r.error.message || '')) return;
          return sb.from('device_sessions').select('token').eq('token', token).maybeSingle();
        })
        .then(function (r) {
          if (r && r.data === null) {
            // 心跳兜底：本机设备行已不存在 → 立即下线并清除登录信息
            forceLogoutByRemote('你的账号已在其他设备被注销');
          } else if (r && r.error) {
            console.warn('heartbeat check:', r.error.message);
          }
        })
        .catch(function () {});
      // 群资料弹窗打开时，周期性刷新群成员在线状态
      if (state.active && state.active.type === 'group' &&
          $('group-info-modal') && $('group-info-modal').classList.contains('open')) {
        refreshGroupMembersOnline(state.active);
      }
    }, 15000);
  }

  // 上报自己的活跃时间（写入 profiles.last_active，仅自己的行受策略允许）
  function touchLastActive() {
    if (!state.uid) return;
    sb.from('profiles').update({ last_active: new Date().toISOString() })
      .eq('id', state.uid)
      .then(function (r) { if (r.error) console.warn('touchLastActive:', r.error.message); })
      .catch(function () {});
  }

  // 某 uid 当前是否在线（last_active 在窗口内）
  function isOnline(uid) {
    var t = state.lastActive[uid];
    if (!t) return false;
    var ms = Date.parse(t);
    if (isNaN(ms)) return false;
    return (Date.now() - ms) < ONLINE_WINDOW_MS;
  }

  // 在头像右下角追加在线状态点：在线绿点，离线灰点（始终显示）
  function addOnlineDot(av, uid) {
    if (!av) return;
    var old = av.querySelector('.online-dot');
    domRemove(old);
    var dot = el('span', 'online-dot');
    dot.classList.add(isOnline(uid) ? 'online' : 'offline');
    av.appendChild(dot);
  }

  // 根据 last_active 字符串判断在线（用于非 state.lastActive 来源的数据，如 GM 后台成员列表）
  function onlineFromIso(iso) {
    if (!iso) return false;
    var ms = Date.parse(iso);
    if (isNaN(ms)) return false;
    return (Date.now() - ms) < ONLINE_WINDOW_MS;
  }

  // 把 last_active 格式化成「在线 / X 分钟前 / X 小时前 / X 天前 / 离线」
  function onlineText(iso) {
    if (!iso) return '离线';
    var ms = Date.parse(iso);
    if (isNaN(ms)) return '离线';
    var diff = Date.now() - ms;
    if (diff < ONLINE_WINDOW_MS) return '在线';
    var mins = Math.floor(diff / 60000);
    if (mins < 60) return mins + ' 分钟前';
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + ' 小时前';
    var days = Math.floor(hrs / 24);
    return days + ' 天前';
  }

  // 拉取所有好友的在线状态：直接查 profiles（全员可读），失败则静默降级为全离线
  function refreshOnline() {
    var ids = state.friends.map(function (f) { return f.id; });
    if (!ids.length) return;
    sb.from('profiles').select('id, last_active').in('id', ids)
      .then(function (r) {
        if (r.error) return;
        var map = {};
        (r.data || []).forEach(function (p) { map[p.id] = p.last_active; });
        state.lastActive = map;
        renderConversations();
        if (state.active && state.active.type === 'friend') updatePeerOnline();
      })
      .catch(function () {});
  }

  // 当前打开的好友聊天里，刷新头部在线指示（绿点 + “在线”文字）
  function updatePeerOnline() {
    if (!state.active || state.active.type !== 'friend') return;
    var av = $('peer-avatar');
    if (av) addOnlineDot(av, state.active.id);
    var ph = $('peer-phone');
    if (ph) ph.textContent = state.active.phone + (isOnline(state.active.id) ? ' · 在线' : '');
  }

  // 批量获取好友/自己/当前会话对象的展示称号（头像框渲染用）
  // 计算某用户称号列的签名（用于实时通道过滤，判断称号是否真的变化）
  // 也包含 hide_dev_title，确保某人切换隐藏开关时其他客户端能刷新
  function titleSigFromRow(t) {
    return [t.title_id, t.title2_id, t.admin_title_id, t.dev_title_id, t.hide_dev_title]
      .map(function (x) { return x == null ? null : x; }).join('|');
  }

  // 判断某用户是否设置了「隐藏开发者称号」（对任何 viewer 都生效）
  function isDevHidden(uid) {
    if (uid === state.uid) return !!state.hideDevTitle;
    return !!(state.devHiddenMap && state.devHiddenMap[uid]);
  }

  // 批量拉取指定用户的 hide_dev_title，写入 devHiddenMap（用于非自己用户的前端过滤兜底）
  function loadDevHiddenFlags(uids) {
    if (!uids || !uids.length) return Promise.resolve();
    var need = [];
    uids.forEach(function (id) { if (id && need.indexOf(id) < 0) need.push(id); });
    if (!need.length) return Promise.resolve();
    return sb.from('profiles')
      .select('id, hide_dev_title')
      .in('id', need)
      .then(function (r) {
        if (r.error) return;
        if (!state.devHiddenMap) state.devHiddenMap = {};
        (r.data || []).forEach(function (row) {
          state.devHiddenMap[row.id] = !!row.hide_dev_title;
        });
      })
      .catch(function () {});
  }

  // 他人（或自己）称号变更后，局部重拉该用户称号并重绘其显示
  function reloadTitleFor(uid) {
    if (!uid) return;
    sb.rpc('get_profiles_titles', { p_ids: [uid] })
      .then(function (r) {
        if (r.error) return;
        (r.data || []).forEach(function (t) {
          if (t.user_id !== uid) return;
          // 用本次 RPC 返回的权威 hide_dev_title 更新缓存（在 isDevHidden 判断之前），
          // 避免用旧缓存误把「取消隐藏」后的开发者框清空
          if (!state.devHiddenMap) state.devHiddenMap = {};
          state.devHiddenMap[uid] = !!t.hide_dev_title;
          var primary = t.title_id ? {
            titleId: t.title_id, titleName: t.title_name,
            frameColor: t.frame_color || '#ffd700', frameStyle: t.frame_style || 'ring'
          } : null;
          var primary2 = t.title2_id ? {
            titleId: t.title2_id, titleName: t.title2_name,
            frameColor: t.title2_color || '#ffd700', frameStyle: t.title2_frame || 'ring'
          } : null;
          var admin = t.admin_title_id ? {
            titleId: t.admin_title_id, titleName: t.admin_title_name,
            frameColor: t.admin_title_color || '#ffd700', frameStyle: t.admin_title_frame || 'ring'
          } : null;
          var dev = t.dev_title_id ? {
            titleId: t.dev_title_id, titleName: t.dev_title_name,
            frameColor: t.dev_title_color || '#7c4dff', frameStyle: 'dev'
          } : null;
          if (isDevHidden(uid)) {
            dev = null;
            if (isDevSlot(primary)) primary = null;
            if (isDevSlot(primary2)) primary2 = null;
          }
          state.titlesMap[uid] = { primary: primary, primary2: primary2, admin: admin, dev: dev };
          if (!state.profileTitleSig) state.profileTitleSig = {};
          state.profileTitleSig[uid] = titleSigFromRow(t);
        });
        // 顺手刷新该用户的 hide_dev_title 缓存，确保即时生效
        loadDevHiddenFlags([uid]).then(function () { refreshTitleUI(uid); });
      })
      .catch(function () {});
  }

  // 打开群资料时，把群成员（含非好友）的称号补拉到本地，再重绘成员列表
  function loadTitlesForGroupMembers(ids) {
    if (!ids || !ids.length) return Promise.resolve();
    var need = [];
    ids.forEach(function (id) { if (need.indexOf(id) < 0) need.push(id); });
    if (!need.length) return Promise.resolve();
    return sb.rpc('get_profiles_titles', { p_ids: need })
      .then(function (r) {
        if (r.error) return;
        (r.data || []).forEach(function (t) {
          var primary = t.title_id ? {
            titleId: t.title_id, titleName: t.title_name,
            frameColor: t.frame_color || '#ffd700', frameStyle: t.frame_style || 'ring'
          } : null;
          var primary2 = t.title2_id ? {
            titleId: t.title2_id, titleName: t.title2_name,
            frameColor: t.title2_color || '#ffd700', frameStyle: t.title2_frame || 'ring'
          } : null;
          var admin = t.admin_title_id ? {
            titleId: t.admin_title_id, titleName: t.admin_title_name,
            frameColor: t.admin_title_color || '#ffd700', frameStyle: t.admin_title_frame || 'ring'
          } : null;
          var dev = t.dev_title_id ? {
            titleId: t.dev_title_id, titleName: t.dev_title_name,
            frameColor: t.dev_title_color || '#7c4dff', frameStyle: 'dev'
          } : null;
          if (!!t.hide_dev_title) {
            dev = null;
            if (isDevSlot(primary)) primary = null;
            if (isDevSlot(primary2)) primary2 = null;
          }
          state.titlesMap[t.user_id] = { primary: primary, primary2: primary2, admin: admin, dev: dev };
          if (!state.profileTitleSig) state.profileTitleSig = {};
          state.profileTitleSig[t.user_id] = titleSigFromRow(t);
        });
      })
      .then(function () {
        return loadDevHiddenFlags(need);
      })
      .then(function () {
        // 若群资料弹窗正打开，补拉后重绘成员列表
        if ($('group-info-modal') && $('group-info-modal').classList.contains('open')) {
          var gid = $('group-info-modal').dataset.gid;
          var g = null;
          if (state.groups) {
            for (var gi = 0; gi < state.groups.length; gi++) {
              if (state.groups[gi].id === gid) { g = state.groups[gi]; break; }
            }
          }
          if (g) renderMemberList(g);
        }
      })
      .catch(function () {});
  }

  // 重绘某个用户的称号显示：侧边栏好友列表 + 自己 + 当前聊天头 + 群资料成员列表
  function refreshTitleUI(uid) {
    if (uid === state.uid) applySelfTitle();
    if (typeof renderConversations === 'function') renderConversations();
    if (state.active && state.active.type === 'friend' && state.active.id === uid) {
      var av = $('peer-avatar');
      if (av) applyTitleFrame(av, uid);
      var nm = $('peer-name');
      if (nm) addTitleBadge(nm, uid);
    }
    if ($('group-info-modal') && $('group-info-modal').classList.contains('open')) {
      var li = document.querySelector('.member-item[data-uid="' + uid + '"]');
      if (li) applyMemberItemTitles(li, uid);
    }
  }

  function applyMemberItemTitles(li, uid) {
    if (!li) return;
    var av = li.querySelector('.avatar');
    if (av) applyTitleFrame(av, uid);
    var nm = li.querySelector('.nm');
    if (nm) addTitleBadge(nm, uid);
  }

  function loadDisplayTitles() {
    var ids = [state.uid];
    state.friends.forEach(function (f) { ids.push(f.id); });
    if (state.active && state.active.type === 'friend') ids.push(state.active.id);
    if (!ids.length) return Promise.resolve();
    // 保留上一次由 refreshAdminStatus 兜底写入的自身强制称号，
    // 以防后端 get_profiles_titles 还是旧签名（无 admin_/dev_ 列）时被清空
    var selfPrev = (state.titlesMap && state.titlesMap[state.uid]) || null;
    return sb.rpc('get_profiles_titles', { p_ids: ids })
      .then(function (r) {
        if (r.error) throw r.error;
        var first = (r.data || [])[0];
        var hasAdminCol = !!first && Object.prototype.hasOwnProperty.call(first, 'admin_title_id');
        var hasDevCol   = !!first && Object.prototype.hasOwnProperty.call(first, 'dev_title_id');
        if (first && (!hasAdminCol || !hasDevCol)) {
          // 提示开发者：数据库函数还是旧版，他人的强制称号无法显示
          try {
            console.warn('[titles] get_profiles_titles 缺少 ' +
              (!hasAdminCol ? 'admin_title_* ' : '') + (!hasDevCol ? 'dev_title_* ' : '') +
              '列，请在 Supabase 执行 20260802_dev_title.sql');
          } catch (e) {}
        }
        state.titlesMap = {};
        (r.data || []).forEach(function (t) {
          var primary = t.title_id ? {
            titleId: t.title_id,
            titleName: t.title_name,
            frameColor: t.frame_color || '#ffd700',
            frameStyle: t.frame_style || 'ring'
          } : null;
          // 第二个自选称号（后端旧签名无此列时自动为 null）
          var primary2 = t.title2_id ? {
            titleId: t.title2_id,
            titleName: t.title2_name,
            frameColor: t.title2_color || '#ffd700',
            frameStyle: t.title2_frame || 'ring'
          } : null;
          var admin = t.admin_title_id ? {
            titleId: t.admin_title_id,
            titleName: t.admin_title_name,
            frameColor: t.admin_title_color || '#ffd700',
            frameStyle: t.admin_title_frame || 'ring'
          } : null;
          var dev = t.dev_title_id ? {
            titleId: t.dev_title_id,
            titleName: t.dev_title_name,
            frameColor: t.dev_title_color || '#7c4dff',
            frameStyle: 'dev'   // 开发者专属头像框，忽略 frame_style
          } : null;
          // 即便后端 get_profiles_titles 还是旧签名没过滤 hide_dev_title，前端也强制不展示
          if (!!t.hide_dev_title) {
            dev = null;
            // 防止开发者称号被错误戴到自选槽位后仍显示
            if (isDevSlot(primary)) primary = null;
            if (isDevSlot(primary2)) primary2 = null;
          }
          state.titlesMap[t.user_id] = { primary: primary, primary2: primary2, admin: admin, dev: dev };
          if (!state.profileTitleSig) state.profileTitleSig = {};
          state.profileTitleSig[t.user_id] = titleSigFromRow(t);
        });
        // 后端还是旧签名时，恢复自身兜底槽位，避免自己的强制称号消失
        if (selfPrev && state.titlesMap[state.uid]) {
          if (!hasAdminCol && selfPrev.admin) state.titlesMap[state.uid].admin = selfPrev.admin;
          if (!hasDevCol   && selfPrev.dev && !isDevHidden(state.uid)) state.titlesMap[state.uid].dev = selfPrev.dev;
        }
        return loadDevHiddenFlags(ids);
      })
      .then(function () {
        // 拉取完每个人的 hide_dev_title 后再统一渲染，确保隐藏状态被所有 viewer 尊重
        if (typeof renderConversations === 'function') renderConversations();
        applySelfTitle();
      })
      .catch(function () {
        // RPC 失败（如函数不存在）时保留已有兜底，不要清空
        state.titlesMap = state.titlesMap || {};
        if (selfPrev) state.titlesMap[state.uid] = selfPrev;
      });
  }

  // 强制佩戴的特殊称号名称（前端按名称精确匹配，不可自行取消佩戴）
  var FORCED_TITLES = ['开发者', '管理员'];
  // 归一化称号名：去掉半角/全角空格、零宽字符、BOM，避免 DB 里名称带隐藏字符导致匹配失败
  function normTitleName(name) {
    return String(name == null ? '' : name)
      .replace(/[\s\u3000\u200b\u200c\u200d\ufeff]/g, '');
  }
  function isForcedTitle(name) { return FORCED_TITLES.indexOf(normTitleName(name)) >= 0; }
  // 同时用「称号 id」兜底判断（id 来自 refreshAdminStatus 实际查到的行，最可靠）
  function isForcedTitleRow(t) {
    if (!t) return false;
    if (t.id && (t.id === state.adminTitleId || t.id === state.devTitleId)) return true;
    return isForcedTitle(t.name);
  }
  // 判断一个展示槽位是否代表「开发者」称号（按 id 优先，按名称兜底）
  function isDevSlot(t) {
    if (!t) return false;
    if (state.devTitleId && t.titleId === state.devTitleId) return true;
    return normTitleName(t.titleName) === '开发者';
  }

  // 把展示槽位合并成有序列表：开发者 > 管理员 > 自选1 > 自选2（按 titleId 去重）
  function titleSlots(uid) {
    var m = state.titlesMap && state.titlesMap[uid];
    if (!m) return [];
    var list = [];
    var seen = {};
    [m.dev, m.admin, m.primary, m.primary2].forEach(function (t) {
      if (!t || !t.titleId || seen[t.titleId]) return;
      seen[t.titleId] = 1;
      list.push(t);
    });
    // 最终兜底：开发者隐藏称号时，任何 viewer 都不展示开发者框/徽标
    //（按 frameStyle 过滤不够，需同时按 titleId / 名称过滤，防止开发者称号被手动戴到自选槽位后仍显示）
    if (isDevHidden(uid)) {
      list = list.filter(function (t) { return !isDevSlot(t); });
    }
    return list;
  }

  // 自选称号可同时佩戴的数量（管理员 / 开发者为强制展示，不占用名额）
  var MAX_CUSTOM_TITLES = 2;

  // 当前自己已佩戴的自选称号 id（有序，去重，不含强制称号）
  function wornTitleIds() {
    var m = state.titlesMap && state.titlesMap[state.uid];
    var ids = [];
    if (!m) return ids;
    [m.primary, m.primary2].forEach(function (t) {
      if (t && t.titleId && ids.indexOf(t.titleId) < 0) ids.push(t.titleId);
    });
    return ids;
  }

  // 用 id 列表就地重建自己的两个自选槽位（详情取自现有槽位，extra 为本次新佩戴的称号）
  function applyWornTitles(ids, extra) {
    state.titlesMap = state.titlesMap || {};
    var m = state.titlesMap[state.uid] || { primary: null, primary2: null, admin: null, dev: null };
    var known = {};
    [m.primary, m.primary2].forEach(function (x) { if (x && x.titleId) known[x.titleId] = x; });
    if (extra && extra.titleId) known[extra.titleId] = extra;
    var slots = [];
    (ids || []).forEach(function (id) { if (known[id]) slots.push(known[id]); });
    m.primary  = slots[0] || null;
    m.primary2 = slots[1] || null;
    state.titlesMap[state.uid] = m;
  }

  // 给头像元素套上称号边框（环 / 发光 / 加粗环 / 开发者专属框）
  // 优先级：开发者专属框 > 管理员（强制佩戴）> 自选称号
  function applyTitleFrame(av, uid) {
    if (!av) return;
    av.style.boxShadow = '';
    av.style.border = '';
    if (av.classList) { av.classList.remove('dev-frame'); av.classList.remove('avatar-admin'); }
    var list = titleSlots(uid);
    if (!list.length) return;
    var t = list[0];
    var c = t.frameColor || '#ffd700';
    if (t.frameStyle === 'dev') {
      // 开发者专属：内白圈 + 彩色渐变环（多色叠加，普通称号无法配置） + 光晕
      av.style.boxShadow = '0 0 0 2px #ffffff, 0 0 0 4px #7c4dff, 0 0 0 6px #22d3ee, 0 0 0 8px #3bff9e, 0 0 6px 1px #b04dff';
      if (av.classList) av.classList.add('dev-frame');
    }
    else if (t.frameStyle === 'solid') av.style.boxShadow = '0 0 0 4px ' + c;
    else if (t.frameStyle === 'glow')  av.style.boxShadow = '0 0 10px 3px ' + c;
    else                               av.style.boxShadow = '0 0 0 3px ' + c; // ring
    // 管理员头像框加「管理员」字样角标
    var m = state.titlesMap && state.titlesMap[uid];
    if (m && m.admin && av.classList) av.classList.add('avatar-admin');
    // tooltip 合并全部称号名
    var names = list.map(function (x) { return x.titleName; });
    if (names.length) av.title = names.join(' · ');
  }

  // 在名字容器后追加称号小徽标（开发者/管理员强制佩戴 + 自选，去重）
  function addTitleBadge(container, uid) {
    if (!container) return;
    // 老 WebView 不支持 ChildNode.remove()，统一用 removeChild
    var olds = container.querySelectorAll('.title-badge');
    for (var i = olds.length - 1; i >= 0; i--) {
      if (olds[i].parentNode) olds[i].parentNode.removeChild(olds[i]);
    }
    titleSlots(uid).forEach(function (t) {
      var isDev = t.frameStyle === 'dev';
      var b = el('span', 'title-badge' + (isDev ? ' badge-dev' : ''), t.titleName);
      // 开发者徽标用 CSS 渐变（专属），其余用称号自身颜色
      if (!isDev) b.style.background = t.frameColor || '#ffd700';
      container.appendChild(b);
    });
  }

  // 给侧边栏“我”的头像与名字加上展示称号
  function applySelfTitle() {
    var av = $('me-avatar');
    if (av) applyTitleFrame(av, state.uid);
    var nm = $('me-name');
    if (nm) addTitleBadge(nm, state.uid);
  }

  // 个人设置：列出当前用户已拥有的称号，并支持切换佩戴
  function loadMyTitles() {
    var box = $('my-titles-list');
    var empty = $('my-titles-empty');
    if (!box) return;
    box.innerHTML = '<div class="title-loading">加载中…</div>';
    if (empty) empty.hidden = true;
    sb.from('user_titles')
      .select('title_id, source, granted_at, titles(id,name,description,frame_color,frame_style)')
      .eq('user_id', state.uid)
      .order('granted_at', { ascending: false })
      .then(function (r) {
        if (r.error) { box.innerHTML = '<div class="title-loading">称号加载失败</div>'; return; }
        var rows = (r.data || [])
          .map(function (u) { return { t: u.titles, granted_at: u.granted_at, source: u.source }; })
          .filter(function (x) { return x.t; });
        var wornIds = wornTitleIds();
        // 先从本次结果里定位强制称号的真实 id（不依赖 refreshAdminStatus 是否已跑完）
        rows.forEach(function (x) {
          var nn = normTitleName(x.t && x.t.name);
          if (nn === '管理员') state.adminTitleId = x.t.id;
          if (nn === '开发者') state.devTitleId  = x.t.id;
        });
        box.innerHTML = '';
        if (!rows.length) {
          if (empty) empty.hidden = false;
          return;
        }
        // 名额提示：自选称号 n / 2
        box.appendChild(el('div', 'title-quota',
          '自选称号 ' + wornIds.length + ' / ' + MAX_CUSTOM_TITLES +
          '（管理员 / 开发者为强制展示，不占名额）'));
        rows.forEach(function (x) {
          var t = x.t;
          var n = normTitleName(t.name);
          var isDevTitle = (n === '开发者') || (t.id && t.id === state.devTitleId); // 开发者：专属头像框
          var forced = isForcedTitleRow(t);         // 开发者 / 管理员：强制佩戴，不可取消
          var worn = forced ? true : (wornIds.indexOf(t.id) >= 0);
          var card = el('div', 'title-card' + (worn ? ' worn' : ''));
          // 边框预览
          var prev = el('div', 'title-prev' + (isDevTitle ? ' dev-frame' : ''));
          prev.style.background = '#fff';
          if (isDevTitle) {
            prev.style.boxShadow = '0 0 0 2px #ffffff, 0 0 0 5px #7c4dff, 0 0 0 8px #22d3ee, 0 0 0 11px #3bff9e, 0 0 14px 5px #b04dff';
          } else {
            prev.style.boxShadow = (t.frame_style === 'solid' ? '0 0 0 4px ' :
                                    t.frame_style === 'glow' ? '0 0 10px 3px ' : '0 0 0 3px ') + (t.frame_color || '#ffd700');
          }
          card.appendChild(prev);
          var info = el('div', 'title-info');
          info.appendChild(el('div', 'title-name', t.name));
          if (t.description) info.appendChild(el('div', 'title-desc', t.description));
          // 获得时间与来源
          var meta = el('div', 'title-meta');
          meta.appendChild(el('span', 'title-time', '获得于 ' + fmtDateTime(x.granted_at)));
          meta.appendChild(el('span', 'title-src', x.source === 'auto' ? '自动获得' : '手动授予'));
          info.appendChild(meta);
          card.appendChild(info);
          if (forced && isDevTitle) {
            // 开发者：可隐藏（仅影响展示，权限不变）
            var hidden = !!state.hideDevTitle;
            card.appendChild(el('span', 'title-forced' + (hidden ? ' title-hidden-tag' : ''),
                                hidden ? '已隐藏' : '强制佩戴'));
            var hb = el('button', 'btn-mini title-hidebtn' + (hidden ? '' : ' btn-outline'),
                        hidden ? '取消隐藏' : '隐藏');
            hb.type = 'button';
            hb.onclick = function () { toggleHideDevTitle(!state.hideDevTitle); };
            card.appendChild(hb);
            // 已隐藏时把预览框变淡，明确告知“当前不会展示”
            if (hidden) {
              prev.style.opacity = '0.4';
              prev.title = '已隐藏，不会在头像/聊天中展示';
            }
          } else if (forced) {
            // 管理员：强制佩戴，不可取消、不可隐藏
            var fsp = el('span', 'title-forced', '强制佩戴');
            fsp.title = '管理员称号不可隐藏';
            card.appendChild(fsp);
          } else {
            var full = !worn && wornIds.length >= MAX_CUSTOM_TITLES;
            var btn = el('button', 'btn-mini' + (worn ? ' btn-outline' : '') + (full ? ' title-btn-full' : ''),
                         worn ? '取消佩戴' : '佩戴');
            btn.type = 'button';
            if (full) btn.title = '已佩戴 ' + MAX_CUSTOM_TITLES + ' 个自选称号，请先取消一个';
            btn.onclick = function () { toggleWearTitle(t, worn); };
            card.appendChild(btn);
          }
          box.appendChild(card);
        });
        refreshAdminStatus();
      })
      .catch(function () { box.innerHTML = '<div class="title-loading">称号加载失败</div>'; });
  }

  // 佩戴 / 取消佩戴自选称号（最多同时 2 个），成功后立即刷新头像框
  function toggleWearTitle(t, worn) {
    if (!t || !t.id) return;
    // 强制称号不可手动佩戴/取消；若 UI 因名称空格等意外出现按钮，也在这里拦截
    if (isForcedTitleRow(t)) {
      toast('「' + t.name + '」为强制称号，已自动展示，无需手动佩戴');
      return;
    }
    var ids = wornTitleIds();
    var next = [];
    if (worn) {
      ids.forEach(function (id) { if (id !== t.id) next.push(id); });
    } else {
      if (ids.indexOf(t.id) >= 0) return;              // 已佩戴，无需重复
      if (ids.length >= MAX_CUSTOM_TITLES) {
        toast('最多同时佩戴 ' + MAX_CUSTOM_TITLES + ' 个自选称号，请先取消一个');
        return;
      }
      next = ids.concat([t.id]);
    }
    // 成功后就地更新自选槽位（保留强制佩戴的 开发者/管理员 称号）并重绘
    function done(ids) {
      applyWornTitles(ids, {
        titleId: t.id,
        titleName: t.name,
        frameColor: t.frame_color || '#ffd700',
        frameStyle: t.frame_style || 'ring'
      });
      toast(worn ? '已取消佩戴：' + t.name : '已佩戴称号：' + t.name);
      applySelfTitle();
      if (typeof renderConversations === 'function') renderConversations();
      loadMyTitles();
    }

    sb.rpc('set_my_titles', { p_ids: next })
      .then(function (r) {
        if (r.error) throw r.error;
        done(next);
      })
      .catch(function (e) {
        var code = (e && e.message) || '';
        // 后端还没执行 20260804_dual_custom_titles.sql：回退到单称号旧接口，功能不中断
        if (code.indexOf('set_my_titles') >= 0 || (e && e.code === 'PGRST202')) {
          var one = worn ? null : t.id;
          sb.rpc('set_my_title', { p_title_id: one })
            .then(function (r2) {
              if (r2.error) throw r2.error;
              done(one ? [one] : []);
              toast('提示：数据库还未启用双称号，本次只佩戴了 1 个');
            })
            .catch(function () { toast('操作失败：请先在 Supabase 执行 20260804_dual_custom_titles.sql'); });
          return;
        }
        var msg = code === 'NOT_OWNED'    ? '你尚未拥有该称号'
                : code === 'SLOT_FULL'    ? '最多同时佩戴 ' + MAX_CUSTOM_TITLES + ' 个自选称号'
                : code === 'FORCED_TITLE' ? '强制称号已自动展示，无需手动佩戴'
                : friendlyError(e);
        toast('操作失败：' + msg);
      });
  }

  function loadDeviceSessions() {
    var box = $('device-list');
    if (!box) return;
    box.innerHTML = '<li class="list-section">加载中…</li>';
    sb.from('device_sessions').select('id,token,device_name,created_at,last_seen')
      .eq('user_id', state.uid).order('last_seen', { ascending: false })
      .then(function (r) {
        if (r.error) { box.innerHTML = '<li class="list-section">设备列表加载失败</li>'; return; }
        var rows = r.data || [];
        if (!rows.length) { box.innerHTML = '<li class="list-section">暂无设备记录</li>'; return; }
        box.innerHTML = '';
        rows.forEach(function (d) {
          var li = el('li', 'device-item');
          var isMe = d.token === state.deviceToken;
          var info = el('div', 'device-info');
          info.appendChild(el('div', 'device-name',
            (isMe ? '📱 ' : '') + d.device_name + (isMe ? '（本机）' : '')));
          info.appendChild(el('div', 'device-meta',
            '登录 ' + fmtDateTime(d.created_at) + ' · 活跃 ' + fmtDateTime(d.last_seen)));
          li.appendChild(info);
          if (!isMe) {
            var btn = el('button', 'del-btn', '注销');
            btn.type = 'button';
            btn.onclick = function () { kickDevice(d.token, li); };
            li.appendChild(btn);
          }
          box.appendChild(li);
        });
      })
      .catch(function () { box.innerHTML = '<li class="list-section">设备列表加载失败</li>'; });
  }

  // 注销单台设备：优先用 security definer RPC 绕开可能的 RLS 缺失；
  // 若该函数不存在（用户没跑迁移 SQL），退回「直删」——device_sessions 的
  // ds_delete 策略允许删除 user_id = 自己的行（含名下其他设备），通常可直接成功。
  function kickDevice(token, li) {
    sb.rpc('kick_device', { p_token: token })
      .then(function (r) {
        if (r.error) throw r.error;
        finishKick(token, li);
      })
      .catch(function () {
        sb.from('device_sessions').delete().eq('token', token)
          .then(function (d) {
            if (d.error) { toast(friendlyError(d.error)); return; }
            finishKick(token, li);
          })
          .catch(function (e) { toast(friendlyError(e)); });
      });
  }

  function finishKick(token, li) {
    toast('已注销该设备');
    // 实时广播：让目标设备秒级下线（心跳作为兜底）
    broadcastKick({ token: token });
    domRemove(li);
  }

  function logoutOtherDevices() {
    if (!state.deviceToken) return;
    sb.rpc('logout_other_devices', { p_keep_token: state.deviceToken })
      .then(function (r) {
        if (r.error) throw r.error;
        finishLogoutOthers();
      })
      .catch(function () {
        sb.from('device_sessions').delete().eq('user_id', state.uid).neq('token', state.deviceToken)
          .then(function (d) {
            if (d.error) { toast(friendlyError(d.error)); return; }
            finishLogoutOthers();
          })
          .catch(function (e) { toast(friendlyError(e)); });
      });
  }

  function finishLogoutOthers() {
    toast('已登出其他所有设备');
    // 实时广播：让其他设备秒级下线（心跳作为兜底）
    broadcastKick({ exceptToken: state.deviceToken });
    loadDeviceSessions();
  }

  // ------------------------------------------------------------
  // Realtime 即时踢人：订阅 kick-{uid} 广播频道，收到针对本机的注销
  // 信号立即下线，避免等 30s 心跳轮询。心跳仍作为最终兜底。
  // ------------------------------------------------------------
  function setupKickChannel() {
    if (!state.uid) return;
    try {
      if (state.kickChannel) { sb.removeChannel(state.kickChannel); state.kickChannel = null; }
      state.kickChannel = sb.channel('kick-' + state.uid, {
        config: { broadcast: { self: false } }
      })
      .on('broadcast', { event: 'kick' }, function (payload) {
        var p = payload && payload.payload;
        if (!p) return;
        // 单台注销：payload.token 命中本机设备令牌
        if (p.token && p.token === state.deviceToken) {
          forceLogoutByRemote('你的账号已在其他设备被注销');
          return;
        }
        // 登出其他所有设备：排除本机令牌之外的全部下线
        if (p.exceptToken !== undefined && p.exceptToken !== state.deviceToken) {
          forceLogoutByRemote('你的账号已在其他设备被注销');
        }
      })
      .subscribe();
    } catch (e) {
      // Realtime 不可用（如项目未开启广播）时静默降级，仍靠心跳兜底
      state.kickChannel = null;
    }
  }

  function broadcastKick(payload) {
    if (!state.kickChannel) return;
    try {
      state.kickChannel.send({ type: 'broadcast', event: 'kick', payload: payload });
    } catch (e) {}
  }

  // ---------- 在线状态实时广播（好友上线/心跳即点亮，正常退出即变灰） ----------
  function setupPresenceChannel() {
    if (!state.uid) return;
    try {
      if (state.presenceChannel) { sb.removeChannel(state.presenceChannel); state.presenceChannel = null; }
      state.presenceChannel = sb.channel('online-presence', {
        config: { broadcast: { self: false } }
      })
      .on('broadcast', { event: 'tick' }, function (payload) {
        var p = payload && payload.payload;
        if (!p || !p.uid || p.uid === state.uid) return;
        // 处理好友，以及当前所在群聊的成员
        var isFriend = state.friends.some(function (f) { return f.id === p.uid; });
        var inGroup = !!(state.active && state.active.type === 'group' &&
                         state.active.memberIds && state.active.memberIds.indexOf(p.uid) >= 0);
        if (!isFriend && !inGroup) return;
        if (p.offline) {
          delete state.lastActive[p.uid];
        } else {
          state.lastActive[p.uid] = p.ts ? new Date(p.ts).toISOString() : new Date().toISOString();
        }
        renderConversations();
        if (state.active && state.active.type === 'friend' && state.active.id === p.uid) updatePeerOnline();
        if (inGroup) updateMemberOnlineDots(state.active);
      })
      .subscribe(function (status) {
        if (status === 'SUBSCRIBED') broadcastPresence(); // 上线即广播一次，让好友秒级看到我
      });
    } catch (e) {
      // Realtime 不可用时静默降级，仍靠轮询兜底
      state.presenceChannel = null;
    }
  }

  function broadcastPresence() {
    if (!state.presenceChannel || !state.uid) return;
    try {
      state.presenceChannel.send({ type: 'broadcast', event: 'tick', payload: { uid: state.uid, ts: Date.now() } });
    } catch (e) {}
  }

  function broadcastOffline() {
    if (!state.presenceChannel || !state.uid) return;
    try {
      state.presenceChannel.send({ type: 'broadcast', event: 'tick', payload: { uid: state.uid, offline: true } });
    } catch (e) {}
  }

  // 被远端注销后的统一本地下线：清本机会话 + 清该账号登录痕迹，不影响其他设备
  function forceLogoutByRemote(reason) {
    if (state.kickChannel) { try { sb.removeChannel(state.kickChannel); } catch (e) {} state.kickChannel = null; }
    if (state.heartbeat) { clearInterval(state.heartbeat); state.heartbeat = null; }
    clearCurrentAccountLocal();
    toast(reason || '你的账号已在其他设备被注销');
    // 仅清本机会话，避免误伤其他设备
    sb.auth.signOut({ scope: 'local' })
      .then(function () { teardown(); initLoginRemembered(); })
      .catch(function () { teardown(); initLoginRemembered(); });
  }

  /* ============================================================
   *  登录 / 注册
   * ============================================================ */
  var tabs = document.querySelectorAll('.tab');
  for (var i = 0; i < tabs.length; i++) {
    tabs[i].addEventListener('click', function () {
      for (var j = 0; j < tabs.length; j++) tabs[j].classList.remove('is-active');
      this.classList.add('is-active');
      var isLogin = this.dataset.tab === 'login';
      $('login-form').hidden = !isLogin;
      $('register-form').hidden = isLogin;
      $('login-error').hidden = true;
      $('reg-error').hidden = true;
    });
  }

  function showErr(id, msg) {
    var e = $(id);
    e.textContent = msg;
    e.hidden = false;
  }

  $('login-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var phone = $('login-phone').value.trim();
    var pwd = $('login-password').value;
    $('login-error').hidden = true;

    if (!PHONE_RE.test(phone)) return showErr('login-error', '请输入正确的 11 位手机号');
    if (pwd.length < 6) return showErr('login-error', '密码至少 6 位');

    var btn = $('login-submit');
    btn.disabled = true; btn.textContent = '登录中…';
    sb.auth.signInWithPassword({ email: emailFor(phone), password: pwd })
      .then(function (r) {
        if (r.error) throw r.error;
        rememberAccount(phone); // 记住本次登录的账号，下次在列表中点选
      })
    .catch(function (e) { showErr('login-error', friendlyError(e)); })
    .then(function () { btn.disabled = false; btn.textContent = '登录'; });
  });

  // 登录页账号列表：点击委托（选中填号 / 删除账号 / 使用其他账号）
  $('account-list').addEventListener('click', onAccountListClick);

  /* ============================================================
   *  账号找回（社交关系找回）
   * ============================================================ */
  function openRecovery() {
    resetRecovery();
    showModal('recovery-modal');
    $('rec-phone').focus();
  }

  function resetRecovery() {
    state.recPhone = '';
    state.recCode = '';
    $('rec-phone').value = '';
    $('rec-code-input').value = '';
    $('rec-error').hidden = true;
    $('rec-step1').hidden = false;
    $('rec-step2').hidden = true;
  }

  function genRecoveryCode() {
    var phone = $('rec-phone').value.trim();
    $('rec-error').hidden = true;
    if (!PHONE_RE.test(phone)) return showErr('rec-error', '请输入正确的 11 位手机号');
    // 客户端生成随机 6 位验证码
    var code = String(Math.floor(100000 + Math.random() * 900000));
    var btn = $('rec-gen-btn');
    btn.disabled = true; btn.textContent = '生成中…';
    sb.rpc('create_recovery_code', { p_phone: phone, p_code: code })
      .then(function (r) {
        if (r.error) throw r.error;
        if (!r.data) throw new Error('NO_PHONE');
        state.recPhone = phone;
        state.recCode = code;
        $('rec-code-display').textContent = code;
        $('rec-step1').hidden = true;
        $('rec-step2').hidden = false;
      })
      .catch(function (e) {
        if ((e && e.message) === 'NO_PHONE') showErr('rec-error', '该手机号未注册');
        else showErr('rec-error', friendlyError(e));
      })
      .then(function () { btn.disabled = false; btn.textContent = '生成验证码'; });
  }

  function verifyRecovery() {
    var phone = state.recPhone;
    var code = $('rec-code-input').value.trim();
    $('rec-error').hidden = true;
    if (!code) return showErr('rec-error', '请输入好友发给你的验证码');
    var btn = $('rec-verify-btn');
    btn.disabled = true; btn.textContent = '验证中…';
    sb.rpc('recover_account', { p_phone: phone, p_code: code })
      .then(function (r) {
        if (r.error) throw r.error;
        var tmp = r.data;
        if (!tmp) throw new Error('RECOVERY_FAIL');
        // 标记强制改密码；登录成功后 onAuthStateChange→start 完成时会自动打开设置
        state.forceChangePwd = true;
        return sb.auth.signInWithPassword({ email: emailFor(phone), password: tmp });
      })
      .then(function (r) {
        if (r.error) throw r.error;
        hideModal('recovery-modal');
        toast('验证成功，请立即修改密码');
      })
      .catch(function (e) {
        if ((e && e.message) === 'RECOVERY_FAIL') {
          showErr('rec-error', '验证未通过：需至少 2 位好友发送该验证码，且验证码未过期/未使用');
        } else {
          showErr('rec-error', friendlyError(e));
        }
        state.forceChangePwd = false;
      })
      .then(function () { btn.disabled = false; btn.textContent = '验证并登录'; });
  }

  $('recovery-btn').addEventListener('click', openRecovery);
  $('recovery-close').addEventListener('click', function () {
    if (state.forceChangePwd) { toast('请先完成账号找回并修改密码'); return; }
    hideModal('recovery-modal');
  });
  $('rec-gen-btn').addEventListener('click', genRecoveryCode);
  $('rec-verify-btn').addEventListener('click', verifyRecovery);
  $('rec-reset-btn').addEventListener('click', resetRecovery);
  $('recovery-modal').addEventListener('click', function (e) {
    if (e.target === this && !state.forceChangePwd) hideModal('recovery-modal');
  });

  $('register-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var phone = $('reg-phone').value.trim();
    var nick = $('reg-nickname').value.trim();
    var pwd = $('reg-password').value;
    $('reg-error').hidden = true;

    if (!PHONE_RE.test(phone)) return showErr('reg-error', '请输入正确的 11 位手机号');
    if (!nick) return showErr('reg-error', '请填写昵称');
    if (pwd.length < 6) return showErr('reg-error', '密码至少 6 位');

    var btn = $('reg-submit');
    btn.disabled = true; btn.textContent = '注册中…';
    sb.auth.signUp({
      email: emailFor(phone),
      password: pwd,
      options: { data: { phone: phone, nickname: nick } }
    })
      .then(function (r) {
        if (r.error) throw r.error;
        if (!r.data.session) {
          throw new Error('注册成功但未自动登录。请到 Supabase 后台 Authentication → Providers → Email，关闭 "Confirm email" 后重新注册。');
        }
        rememberAccount(phone); // 注册并登录成功后同样记住账号
      })
      .catch(function (e) { showErr('reg-error', friendlyError(e)); })
      .then(function () { btn.disabled = false; btn.textContent = '注册并登录'; });
  });

  $('logout-btn').addEventListener('click', function () {
    // 退出前清理本机设备记录
    if (state.deviceToken) {
      // Supabase query builder 是 thenable 而非完整 Promise，必须先 .then() 再 .catch()
      sb.from('device_sessions').delete().eq('token', state.deviceToken)
        .then(function () {})
        .catch(function () {});
    }
    // 无论 signOut 成功还是失败（特殊设备/弱网可能 reject），
    // 都兜底强制切回登录页，避免“点了登出没反应”
    sb.auth.signOut({ scope: 'local' })
      .then(function () { teardown(); })
      .catch(function () { teardown(); });
  });

  /* ============================================================
   *  会话启动 / 结束
   * ============================================================ */
  sb.auth.onAuthStateChange(function (event, session) {
    if (session && session.user) {
      if (state.uid !== session.user.id) {
        state.uid = session.user.id;
        start(session);
      } else if (state.channel) {
        sb.realtime.setAuth(session.access_token);
      }
    } else {
      teardown();
    }
  });

  sb.auth.getSession().then(function (r) {
    removeBootLoader();
    if (r.data && r.data.session) {
      state.uid = r.data.session.user.id;
      start(r.data.session);
    } else {
      $('auth-view').hidden = false;
      initLoginRemembered(); // 预填上次登录的手机号
    }
  });

  function removeBootLoader() {
    var b = $('boot');
    if (b) { b.parentNode.removeChild(b); }
  }

  function teardown() {
    if (state.heartbeat) { clearInterval(state.heartbeat); state.heartbeat = null; }
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
    if (state.onlineTimer) { clearInterval(state.onlineTimer); state.onlineTimer = null; }
    if (state.wordLogUnreadTimer) { clearInterval(state.wordLogUnreadTimer); state.wordLogUnreadTimer = null; }
    if (state.channel) { sb.removeChannel(state.channel); state.channel = null; }
    if (state.kickChannel) { try { sb.removeChannel(state.kickChannel); } catch (e) {} state.kickChannel = null; }
    if (state.presenceChannel) {
      try { broadcastOffline(); } catch (e) {}
      try { sb.removeChannel(state.presenceChannel); } catch (e) {}
      state.presenceChannel = null;
    }
    state.uid = null; state.profile = null; state.friends = [];
    state.incoming = []; state.active = null; state.chatVisible = false; state.unread = {}; state.urlCache = {};
    $('app-view').hidden = true;
    $('auth-view').hidden = false;
    document.querySelector('.app-view').classList.remove('show-chat');
    $('chat-room').hidden = true;
    $('chat-empty').hidden = false;
  }

  function start(session) {
    $('auth-view').hidden = true;
    $('app-view').hidden = false;
    sb.realtime.setAuth(session.access_token);

    loadConvTs();   // 刷新网页后恢复「会话浮顶时间戳」，避免刚发消息置顶、刷新又回原位

    registerDeviceSession();
    startHeartbeat();
    setupKickChannel();
    setupPresenceChannel();
    // 连续登录计数 + 自动授予「连续登录 N 天」称号（失败不影响主流程）
    sb.rpc('touch_login_streak').then(function () {}).catch(function () {});
    // 拉取“绝对管理员”uid，用于决定 GM 入口是否可见
    refreshGmAdmin();

    // 在线状态：登录后拉一次；Realtime 广播负责秒级点亮，10s 轮询作兜底校正
    refreshOnline();
    if (state.onlineTimer) clearInterval(state.onlineTimer);
    state.onlineTimer = setInterval(refreshOnline, 10000);

    loadProfile()
      .then(loadRelations)
      .then(loadGroupRemarks)
      .then(loadGroups)
      .then(convTsFallbackIfNeeded)   // RPC 不可用时，群聊加载完再补算会话浮顶时间
      .then(loadDisplayTitles)
      .then(applySelfTitle)
      .then(refreshAdminStatus)
      .then(loadForbiddenWords)
      .then(loadMyDrafts)            // 登录即拉取我的全部草稿（跨设备/退出网页后仍在）
      .then(loadUnreadFromDb)        // 登录即按 DB 计算离线/跨设备未读
      .then(function () {
        // 注意：不要写成 .then(subscribeRealtime).then(startPoll)
        // —— subscribeRealtime 没有 return，会返回 undefined，导致 .then(startPoll) 抛错、
        //    startPoll 永远不执行（一个坑过多次的 thenable 陷阱）。这里顺序调用即可。
        subscribeRealtime();
        startPoll();
        registerServiceWorker();   // PWA：注册 Service Worker 接收 Web Push（WebView 自动跳过）
        // 账号找回后：资料加载完即强制打开设置改密码
        if (state.forceChangePwd) openSettings();
      })
      .catch(function (e) { toast(friendlyError(e)); });
  }

  function loadProfile() {
    return sb.from('profiles').select('id,phone,nickname,avatar_path,muted_until,hide_dev_title').eq('id', state.uid).maybeSingle()
      .then(function (r) {
        if (r.error) throw r.error;
        if (!r.data) {
          // 触发器未生效时的兜底：用注册时写入的元数据补建资料
          return sb.auth.getUser().then(function (u) {
            var m = (u.data && u.data.user && u.data.user.user_metadata) || {};
            return sb.from('profiles').insert({
              id: state.uid,
              phone: m.phone || '未知',
              nickname: m.nickname || '用户'
            }).select().single();
          }).then(function (r2) {
            if (r2.error) throw r2.error;
            return r2.data;
          });
        }
        return r.data;
      })
      .then(function (p) {
        state.profile = p;
        state.mutedUntil = p.muted_until || null;
        // 尽早把「隐藏开发者称号」开关读到内存，避免后续 refreshAdminStatus 先用旧值把徽标画出来
        state.hideDevTitle = !!p.hide_dev_title;
        $('me-name').textContent = p.nickname;
        $('me-phone').textContent = p.phone;
        setAvatar($('me-avatar'), { nickname: p.nickname, phone: p.phone, avatarPath: p.avatar_path });
      });
  }

  /* ============================================================
   *  好友关系
   * ============================================================ */
  function loadRelations() {
    return sb.from('friendships')
      .select('id,status,requester_id,addressee_id,created_at,requester_remark,addressee_remark,' +
              'pinned_by_requester,pinned_by_addressee,' +
              'requester:profiles!friendships_requester_id_fkey(id,phone,nickname,avatar_path),' +
              'addressee:profiles!friendships_addressee_id_fkey(id,phone,nickname,avatar_path)')
      .or('requester_id.eq.' + state.uid + ',addressee_id.eq.' + state.uid)
      .order('created_at', { ascending: false })
      .then(function (r) {
        if (r.error) throw r.error;
        var rows = r.data || [];
        var friends = [], incoming = [];
        rows.forEach(function (row) {
          var iAmRequester = row.requester_id === state.uid;
          var other = iAmRequester ? row.addressee : row.requester;
          if (!other) return;
          if (row.status === 'accepted') {
            var myRemark = iAmRequester ? row.requester_remark : row.addressee_remark;
            var pinned = iAmRequester ? row.pinned_by_requester : row.pinned_by_addressee;
            friends.push({
              id: other.id,
              phone: other.phone,
              nickname: other.nickname,
              avatar: other.avatar_path,
              remark: myRemark,
              relId: row.id,
              iAmRequester: iAmRequester,
              pinned: !!pinned,
              type: 'friend'
            });
          } else if (row.status === 'pending' && !iAmRequester) {
            incoming.push({ rowId: row.id, user: other });
          }
        });
        // 置顶的好友排到最前；其余保持原有（创建时间倒序）顺序
        friends.sort(function (a, b) { return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0); });
        state.friends = friends;
        state.incoming = incoming;
        friends.forEach(function (f) {
          state.profilesById[f.id] = { nickname: f.nickname, avatar_path: f.avatar, phone: f.phone };
        });
        renderFriends();
        renderRequests();
        refreshOnline(); // 好友加载完后立即拉一次在线状态

        // 当前会话对象被删除好友时收起聊天窗
        if (state.active && !friends.some(function (f) { return f.id === state.active.id; })) {
          state.active = null;
          state.chatVisible = false;
          $('chat-room').hidden = true;
          $('chat-empty').hidden = false;
        }
      });
  }

  function renderRequests() {
    var sec = $('requests-section'), list = $('request-list');
    list.innerHTML = '';
    if (!state.incoming.length) { sec.hidden = true; return; }
    sec.hidden = false;
    $('requests-count').textContent = state.incoming.length;

    state.incoming.forEach(function (req) {
      var li = el('li');
      var av = el('div', 'avatar sm');
      setAvatar(av, { nickname: req.user.nickname, phone: req.user.phone, avatarPath: req.user.avatar_path });
      var info = el('div', 'info');
      info.appendChild(el('div', 'nm', req.user.nickname));
      info.appendChild(el('div', 'ph', maskPhone(req.user.phone)));
      var ok = el('button', 'mini-ok', '同意');
      var no = el('button', 'mini-no', '拒绝');
      ok.onclick = function () { respond(req.rowId, 'accepted'); };
      no.onclick = function () { respond(req.rowId, 'rejected'); };
      li.appendChild(av); li.appendChild(info); li.appendChild(ok); li.appendChild(no);
      list.appendChild(li);
    });
  }

  function respond(rowId, status) {
    sb.from('friendships').update({ status: status, updated_at: new Date().toISOString() })
      .eq('id', rowId)
      .then(function (r) {
        if (r.error) throw r.error;
        toast(status === 'accepted' ? '已添加为好友' : '已拒绝');
        return loadRelations();
      })
      .catch(function (e) { toast(friendlyError(e)); });
  }

  function renderFriends() { renderConversations(); }

  // 统一会话列表：好友 + 群聊合并渲染到 #chat-list
  /* 会话列表项里的“草稿”预览（仅在有草稿时显示） */
  function appendDraftPreview(info, peerId, isGroup) {
    var d = state.drafts[draftKey(peerId, isGroup)];
    if (!d || !d.text) return;
    var prev = d.text.replace(/\s+/g, ' ').trim();
    if (prev.length > 18) prev = prev.slice(0, 18) + '…';
    info.appendChild(el('div', 'draft-prev', '草稿：' + prev));
  }

  function renderConversations() {
    var list = $('chat-list');
    if (!list) return;
    list.innerHTML = '';

    var all = state.groups.concat(state.friends);
    var pinned = all.filter(function (x) { return x.pinned; });
    var normal = all.filter(function (x) { return !x.pinned; });
    sortByRecent(pinned);
    sortByRecent(normal);

    var emptyTip = $('chat-empty-tip');
    if (emptyTip) emptyTip.hidden = all.length > 0;

    if (pinned.length) {
      list.appendChild(el('li', 'list-section', '置顶'));
      pinned.forEach(function (x) { list.appendChild(makeConversationItem(x)); });
    }
    if (normal.length) {
      if (pinned.length) list.appendChild(el('li', 'list-section', '会话'));
      normal.forEach(function (x) { list.appendChild(makeConversationItem(x)); });
    }
  }

  function makeConversationItem(x) {
    return x.type === 'group' ? makeGroupItem(x) : makeFriendItem(x);
  }

  function makeGroupItem(g) {
    var li = el('li');
    if (state.active && state.active.id === g.id) li.classList.add('is-active');
    var av = el('div', 'avatar sm');
    setGroupAvatar(av, g);
    var info = el('div', 'info');
    info.appendChild(el('div', 'nm', groupDisplayName(g)));
    info.appendChild(el('div', 'ph', g.memberCount + ' 位成员'));
    appendDraftPreview(info, g.id, true);
    li.appendChild(av); li.appendChild(info);

    var pin = el('button', 'pin-btn', g.pinned ? '已置顶' : '置顶');
    pin.type = 'button';
    if (g.pinned) pin.classList.add('pinned');
    pin.onclick = function (ev) { ev.stopPropagation(); ev.preventDefault(); toggleGroupPin(g); };
    li.appendChild(pin);

    var cnt = state.unread[g.id] || 0;
    if (cnt > 0) {
      var badge = el('div', 'badge', cnt > 99 ? '99+' : String(cnt));
      li.appendChild(badge);
    }
    li.onclick = function () { var gg = groupById(g.id); if (gg) openChat(gg); };
    return li;
  }

  // 按“会话浮顶时间戳 convTs”降序排序：有 ts 的（收到过新消息 / 向对方发过消息）排到最前，
  // 且彼此按时间先后——越晚的会话越靠前；没有 ts 的历史会话保持原相对顺序。
  function sortByRecent(arr) {
    arr.forEach(function (x, i) { x.__order = i; });   // 记录原始位置，保证无 ts 时顺序稳定
    arr.sort(function (a, b) {
      var ta = state.convTs[a.id] || 0;
      var tb = state.convTs[b.id] || 0;
      if (tb !== ta) return tb - ta;                    // 有 ts 的按时间倒序前置
      return (a.__order || 0) - (b.__order || 0);       // 无 ts 保持原始顺序
    });
  }

  // 会话浮顶时间戳：让「刚发消息的会话」在刷新网页后仍停在列表顶部。
  // 可靠性分层（避免只依赖 localStorage，WebView 里 localStorage 常被清空）：
  //   1) 底：本浏览器 localStorage（桌面 / 普通手机浏览器）
  //   2) 主：get_my_conv_last_times RPC 返回的真实最后消息时间（跨设备/换浏览器都稳）
  //   3) 兜底：RPC 不可用时直接从 messages 表算每个会话最后时间（无需新 SQL）
  // 三者按“取较大者”合并，本地 Date.now() 浮顶作为叠加层保留。
  function loadConvTs() {
    if (!state.uid) return;
    // 1) 先恢复本浏览器 localStorage
    try {
      var raw = localStorage.getItem('convTs:' + state.uid);
      if (raw) state.convTs = JSON.parse(raw) || {};
      else state.convTs = state.convTs || {};
    } catch (e) { state.convTs = state.convTs || {}; }

    var applyRows = function (rows) {
      (rows || []).forEach(function (row) {
        var pid = row.peer_id || row.peer;
        if (!pid || !row.last_ts) return;
        var ts = new Date(row.last_ts).getTime();
        if (!isNaN(ts) && ts > (state.convTs[pid] || 0)) state.convTs[pid] = ts;
      });
      if (state.friends && (state.friends.length || state.groups.length)) renderConversations();
    };

    if (sb && sb.rpc) {
      sb.rpc('get_my_conv_last_times')
        .then(function (r) {
          if (r.error || !r.data) throw new Error('conv-ts-rpc-unavailable');
          applyRows(r.data);
        })
        .catch(function () {
          // 2) RPC 不可用（SQL 未执行等）——标记并降级到直接查 messages
          state._needConvTsFallback = true;
          loadConvTsFromMessages();
        });
    } else {
      state._needConvTsFallback = true;
      loadConvTsFromMessages();
    }
  }

  // 兜底：不依赖 get_my_conv_last_times，直接从 messages 表取“我参与”的最近消息，
  // 在 JS 里算出每个会话（好友 = 对方 id / 群 = group_id）的最后时间，合并进 convTs。
  // 这样即便用户漏跑 SQL、或 WebView 清了 localStorage，刷新后列表仍能按真实活动置顶。
  function loadConvTsFromMessages() {
    if (!sb || !state.uid) return Promise.resolve();
    var dmQ = sb.from('messages')
      .select('sender_id,receiver_id,group_id,created_at')
      .or('sender_id.eq.' + state.uid + ',receiver_id.eq.' + state.uid)
      .order('created_at', { ascending: false })
      .limit(500);
    var gids = (state.groups || []).map(function (g) { return g.id; });
    var gpQ = gids.length
      ? sb.from('messages')
          .select('sender_id,receiver_id,group_id,created_at')
          .in('group_id', gids)
          .order('created_at', { ascending: false })
          .limit(500)
      : Promise.resolve({ data: [] });
    return Promise.all([dmQ, gpQ]).then(function (res) {
      (res[0].data || []).forEach(function (m) {
        if (m.group_id) return;
        if (m.recalled || m.hidden_forbidden) return;
        if (m.deleted_by && m.deleted_by.indexOf(state.uid) >= 0) return;
        var peer = (m.sender_id === state.uid) ? m.receiver_id : m.sender_id;
        if (!peer || !m.created_at) return;
        var ts = new Date(m.created_at).getTime();
        if (!isNaN(ts) && ts > (state.convTs[peer] || 0)) state.convTs[peer] = ts;
      });
      (res[1].data || []).forEach(function (m) {
        if (!m.group_id) return;
        if (m.recalled || m.hidden_forbidden) return;
        if (m.deleted_by && m.deleted_by.indexOf(state.uid) >= 0) return;
        if (!m.created_at) return;
        var ts = new Date(m.created_at).getTime();
        if (!isNaN(ts) && ts > (state.convTs[m.group_id] || 0)) state.convTs[m.group_id] = ts;
      });
      if (state.friends && (state.friends.length || state.groups.length)) renderConversations();
    }).catch(function () {});
  }

  // 加载完群聊后补跑一次兜底（此时 state.groups 才就绪，群聊最后时间才完整）
  function convTsFallbackIfNeeded() {
    if (state._needConvTsFallback) return loadConvTsFromMessages();
    return null;
  }
  function bumpConvTs(id) {
    if (!id) return;
    state.convTs[id] = Date.now();
    try { localStorage.setItem('convTs:' + state.uid, JSON.stringify(state.convTs)); } catch (e) {}
  }

  // 把好友按“置顶 / 非置顶”分组渲染进容器；每组内未读优先。clickFn 为点击回调
  function renderGroupedFriends(container, friends, clickFn) {
    var pinned = friends.filter(function (f) { return f.pinned; });
    var normal  = friends.filter(function (f) { return !f.pinned; });
    sortByRecent(pinned);
    sortByRecent(normal);

    if (pinned.length) {
      container.appendChild(el('div', 'list-section', '置顶'));
      pinned.forEach(function (f) { container.appendChild(makeFriendRow(f, clickFn)); });
    }
    if (normal.length) {
      container.appendChild(el('div', 'list-section', pinned.length ? '非置顶' : '好友'));
      normal.forEach(function (f) { container.appendChild(makeFriendRow(f, clickFn)); });
    }
  }

  // 搜索结果用的行（带置顶/备注按钮与未读徽标），点击触发 clickFn
  function makeFriendRow(f, clickFn) {
    var row = el('div', 'row clickable');
    var av = el('div', 'avatar sm');
    setAvatar(av, { nickname: f.remark || f.nickname, phone: f.phone, avatarPath: f.avatar });
    var info = el('div', 'info');
    var nm = el('div', 'nm', displayName(f));
    info.appendChild(nm);
    info.appendChild(el('div', 'ph', f.phone + (f.remark ? ' · ' + f.nickname : '')));
    row.appendChild(av); row.appendChild(info);
    addOnlineDot(av, f.id);
    applyTitleFrame(av, f.id);
    addTitleBadge(nm, f.id);

    var pin = el('button', 'pin-btn', f.pinned ? '已置顶' : '置顶');
    pin.type = 'button';
    if (f.pinned) pin.classList.add('pinned');
    pin.onclick = function (ev) { ev.stopPropagation(); ev.preventDefault(); togglePin(f); };
    row.appendChild(pin);

    var cnt = parseInt(state.unread[f.id] || 0, 10) || 0;
    if (cnt > 0) {
      var badge = el('div', 'badge', cnt > 99 ? '99+' : String(cnt));
      badge.setAttribute('aria-label', '未读消息 ' + cnt + ' 条');
      row.appendChild(badge);
    }
    row.onclick = function () { clickFn(f); };
    return row;
  }

  // 搜索结果用的群聊行（带置顶按钮与未读徽标），点击触发 clickFn
  function makeGroupRow(g, clickFn) {
    var row = el('div', 'row clickable');
    var av = el('div', 'avatar sm');
    setGroupAvatar(av, g);
    var info = el('div', 'info');
    info.appendChild(el('div', 'nm', groupDisplayName(g) || '未命名群聊'));
    info.appendChild(el('div', 'ph', (g.memberCount || 0) + ' 位成员' + (g.iAmOwner ? ' · 我是群主' : '')));
    row.appendChild(av); row.appendChild(info);

    var pin = el('button', 'pin-btn', g.pinned ? '已置顶' : '置顶');
    pin.type = 'button';
    if (g.pinned) pin.classList.add('pinned');
    pin.onclick = function (ev) { ev.stopPropagation(); ev.preventDefault(); toggleGroupPin(g); };
    row.appendChild(pin);

    var cnt = parseInt(state.unread[g.id] || 0, 10) || 0;
    if (cnt > 0) {
      var badge = el('div', 'badge', cnt > 99 ? '99+' : String(cnt));
      badge.setAttribute('aria-label', '未读消息 ' + cnt + ' 条');
      row.appendChild(badge);
    }
    row.onclick = function () { clickFn(groupById(g.id) || g); };
    return row;
  }

  function makeFriendItem(f) {
    var li = el('li');
    if (state.active && state.active.id === f.id) li.classList.add('is-active');
    var av = el('div', 'avatar sm');
    setAvatar(av, { nickname: f.remark || f.nickname, phone: f.phone, avatarPath: f.avatar });
    var info = el('div', 'info');
    var nm = el('div', 'nm', displayName(f));
    info.appendChild(nm);
    info.appendChild(el('div', 'ph', f.phone + (f.remark ? ' · ' + f.nickname : '')));
    appendDraftPreview(info, f.id, false);
    li.appendChild(av); li.appendChild(info);
    addOnlineDot(av, f.id);
    applyTitleFrame(av, f.id);
    addTitleBadge(nm, f.id);

    var pin = el('button', 'pin-btn', f.pinned ? '已置顶' : '置顶');
    pin.type = 'button';
    if (f.pinned) pin.classList.add('pinned');
    pin.onclick = function (ev) { ev.stopPropagation(); ev.preventDefault(); togglePin(f); };
    li.appendChild(pin);

    var cnt = parseInt(state.unread[f.id] || 0, 10) || 0;
    if (cnt > 0) {
      var badge = el('div', 'badge', cnt > 99 ? '99+' : String(cnt));
      badge.setAttribute('aria-label', '未读消息 ' + cnt + ' 条');
      li.appendChild(badge);
    }
    li.onclick = function () { openChat(f); };
    return li;
  }

  function togglePin(f) {
    var col = f.iAmRequester ? 'pinned_by_requester' : 'pinned_by_addressee';
    var next = !f.pinned;
    var upd = {}; upd[col] = next;
    sb.from('friendships').update(upd).eq('id', f.relId)
      .then(function (r) {
        if (r.error) throw r.error;
        f.pinned = next;
        if (state.active && state.active.id === f.id) state.active.pinned = next;
        renderFriends();
      })
      .catch(function (e) { toast(friendlyError(e)); });
  }

  function makeResultRow(user) {
    var row = el('div', 'row');
    var av = el('div', 'avatar sm');
    var remark = user.remark || '';
    setAvatar(av, { nickname: remark || user.nickname, phone: user.phone, avatarPath: user.avatar_path });
    var info = el('div', 'info');
    info.appendChild(el('div', 'nm', displayName(user)));
    info.appendChild(el('div', 'ph', user.phone + (remark ? ' · ' + user.nickname : '')));
    row.appendChild(av); row.appendChild(info);
    return row;
  }

  function onUnifiedSearch() {
    var kw = $('search-box').value.trim();
    var panel = $('search-result');
    var list = $('chat-list');
    if (!kw) {
      panel.hidden = true; panel.innerHTML = '';
      list.hidden = false;
      $('chat-empty-tip').hidden = (state.friends.length + state.groups.length) > 0;
      return;
    }
    list.hidden = true;
    $('chat-empty-tip').hidden = true;
    panel.hidden = false; panel.innerHTML = '';

    var q = kw.toLowerCase();
    var local = state.friends.filter(function (f) {
      var hay = [f.phone, f.nickname, f.remark, (f.remark ? f.nickname : '')]
        .filter(Boolean).join(' ').toLowerCase();
      return hay.indexOf(q) !== -1;
    });

    // 已加入的群聊：按群名匹配（置顶群优先，其余按最近会话时间）
    var localG = (state.groups || []).filter(function (g) {
      return String(g.name || '').toLowerCase().indexOf(q) !== -1;
    });

    function pickConv(x) {
      $('search-box').value = '';
      onUnifiedSearch();
      openChat(x);
    }

    if (localG.length) {
      var gPin = localG.filter(function (g) { return g.pinned; });
      var gNor = localG.filter(function (g) { return !g.pinned; });
      sortByRecent(gPin);
      sortByRecent(gNor);
      panel.appendChild(el('div', 'list-section', '群聊'));
      gPin.concat(gNor).forEach(function (g) {
        panel.appendChild(makeGroupRow(g, pickConv));
      });
    }

    renderGroupedFriends(panel, local, pickConv);

    if (PHONE_RE.test(kw)) {
      sb.from('profiles').select('id,phone,nickname,avatar_path').eq('phone', kw).maybeSingle()
        .then(function (r) {
          if (r.error) { toast(friendlyError(r.error)); return; }
          if (!r.data) {
            if (local.length === 0 && localG.length === 0) panel.appendChild(el('div', 'note', '没有找到该手机号的用户，可能还没注册。'));
            return;
          }
          if (r.data.id === state.uid) return;
          if (state.friends.some(function (f) { return f.id === r.data.id; })) return;
          var row = makeResultRow(r.data);
          var add = el('button', 'btn-mini', '加为好友');
          add.style.padding = '6px 12px';
          add.onclick = function (ev) { ev.stopPropagation(); sendRequest(r.data, add); };
          row.appendChild(add);
          panel.appendChild(row);
        });
    } else if (local.length === 0 && localG.length === 0) {
      panel.appendChild(el('div', 'note', '没有找到相关好友或群聊'));
    }
  }

  /* ---------- 编辑好友备注 ---------- */
  function editRemark(f) {
    var cur = f.remark || '';
    var input = window.prompt('给好友设置备注名（留空可清除）：', cur);
    if (input === null) return; // 取消
    var val = input.trim().slice(0, 20);
    var payload = { updated_at: new Date().toISOString() };
    if (f.iAmRequester) payload.requester_remark = val || null;
    else payload.addressee_remark = val || null;

    sb.from('friendships').update(payload).eq('id', f.relId)
      .then(function (r) {
        if (r.error) throw r.error;
        f.remark = val || null;
        renderFriends();
        if (state.active && state.active.id === f.id) {
          $('peer-name').textContent = displayName(f);
          $('peer-avatar').textContent = initialOf(f.remark || f.nickname);
        }
        toast(val ? '已设置备注：' + val : '已清除备注');
      })
      .catch(function (e) { toast(friendlyError(e)); });
  }

  /* ---------- 删除好友 ---------- */
  var pendingDelFriend = null;

  function deleteFriend(f) {
    if (!f.relId) { toast('找不到好友关系记录'); return; }
    pendingDelFriend = f;
    $('del-friend-text').textContent =
      '确定删除好友「' + (f.remark || f.nickname) + '」吗？\n删除后将从双方好友列表中移除（聊天记录仍保留）。';
    showModal('del-friend-modal');
  }

  function closeDelFriend() {
    hideModal('del-friend-modal');
    pendingDelFriend = null;
  }

  function confirmDelFriend() {
    var f = pendingDelFriend;
    if (!f) return;
    hideModal('del-friend-modal');
    pendingDelFriend = null;
    sb.from('friendships').delete().eq('id', f.relId)
      .then(function (r) {
        if (r.error) throw r.error;
        toast('已删除好友');
        return loadRelations();
      })
      .then(function () {
        // loadRelations 内部会在当前会话好友已不存在时收起聊天窗
        $('peer-del-btn').hidden = true;
      })
      .catch(function (e) { toast(friendlyError(e)); });
  }

  $('del-friend-close').addEventListener('click', closeDelFriend);
  $('del-friend-cancel').addEventListener('click', closeDelFriend);
  $('del-friend-confirm').addEventListener('click', confirmDelFriend);

  // 一键清空与某好友的全部聊天记录（仅本端删除，对方无感、不可恢复）
  var pendingClearPeer = null;
  function openClearModal(peer) {
    pendingClearPeer = peer;
    $('clear-msgs-text').textContent =
      '确定清空与「' + displayName(peer) + '」的全部聊天记录吗？\n仅自己不可见，对方仍保留记录，且不可恢复。';
    showModal('clear-msgs-modal');
  }
  function closeClearModal() {
    hideModal('clear-msgs-modal');
    pendingClearPeer = null;
  }
  function confirmClearMessages() {
    var peer = pendingClearPeer;
    if (!peer) return;
    hideModal('clear-msgs-modal');
    pendingClearPeer = null;
    var btn = $('clear-msgs-confirm');
    if (btn) { btn.disabled = true; btn.textContent = '清空中…'; }
    // 乐观清空：先立即移除本地所有消息（含旧的单条删除占位），避免 RPC 失败时旧内容残留
    var box = $('messages');
    if (box) { box.innerHTML = ''; box.appendChild(el('div', 'day-sep', EMPTY_TIP)); }
    // 清空的同时抹掉该会话未读，避免列表上残留一个点不掉的红点
    if (state.unread[peer.id]) { delete state.unread[peer.id]; renderFriends(); }
    sb.rpc('clear_messages_for_me', { p_peer_id: peer.id })
      .then(function (r) {
        if (r && r.error) throw r.error;
        toast('已清空聊天记录（仅自己可见）');
        // 后端成功：从 DB 重拉当前会话，被本端删除的消息因 renderMessage 返回 null 而不会渲染
        if (state.active && state.active.id === peer.id) openChat(state.active);
      })
      .catch(function (e) {
        var msg = friendlyError(e);
        // 后端函数不存在（多半是没执行迁移 SQL）：已在本地隐藏，明确提示根因
        if (/does not exist|could not find|undefined function|42883/i.test(msg)) {
          toast('后端未生效：请先在 Supabase 执行 20260804_clear_messages.sql（本机已临时隐藏）');
        } else {
          toast('清空失败：' + msg);
        }
      })
      .then(function () {
        if (btn) { btn.disabled = false; btn.textContent = '清空'; }
      });
  }

  $('clear-msgs-close').addEventListener('click', closeClearModal);
  $('clear-msgs-cancel').addEventListener('click', closeClearModal);
  $('clear-msgs-confirm').addEventListener('click', confirmClearMessages);

  /* ============================================================
   *  个人设置（头像 + 名称）
   * ============================================================ */
  var pendingAvatar = null;   // 待保存的新头像路径（null 表示未改动）

  function openSettings() {
    if (!state.profile) return;
    pendingAvatar = null;
    $('settings-name').value = state.profile.nickname || '';
    setAvatar($('settings-avatar'), {
      nickname: state.profile.nickname,
      phone: state.profile.phone,
      avatarPath: state.profile.avatar_path
    });
    resetPwdFields();
    loadDeviceSessions();
    loadMyTitles();
    refreshAppealSection();
    // 账号找回后强制改密码：显示提示条，并禁用关闭
    $('force-pwd-banner').hidden = !state.forceChangePwd;
    // 强制改密码期间不允许注销账号 / 进入 GM 后台（先完成安全流程）
    var dab = $('delete-account-btn');
    if (dab) dab.hidden = !!state.forceChangePwd;
    var gob = $('gm-open-btn');
    if (gob) gob.hidden = !isGmAdmin() || !!state.forceChangePwd;
    showModal('settings-modal');
  }

  function closeSettings() {
    if (state.forceChangePwd) {
      toast('出于安全，请先修改密码后再关闭');
      return;
    }
    hideModal('settings-modal');
    pendingAvatar = null;
  }

  // 个人设置「禁言申诉」区块：根据当前禁言状态与已有申诉展示
  function refreshAppealSection() {
    var hint = $('appeal-status-hint');
    var btn = $('appeal-open-btn');
    if (!hint || !btn) return;
    var u = state.mutedUntil;
    if (u && new Date(u).getTime() > Date.now()) {
      hint.textContent = '你已被禁言，' + formatMuteDuration(u) + '后自动解除。如认为有误，可提交申诉。';
      btn.hidden = false;
    } else {
      hint.textContent = '你当前未被禁言。';
      btn.hidden = true;
    }
    // 若已有申诉，按状态展示并禁用按钮
    sb.rpc('get_my_mute_appeal').then(function (r) {
      if (r.error) return;
      var row = (r.data && r.data[0]) || null;
      if (!row) return;
      if (row.status === 'pending') {
        hint.textContent = '你的禁言申诉正在审核中，请耐心等待。';
        btn.hidden = true;
      } else if (row.status === 'approved') {
        hint.textContent = '你的禁言申诉已通过，禁言已解除。';
        btn.hidden = true;
      } else if (row.status === 'rejected') {
        hint.textContent = '你的禁言申诉未通过。';
        btn.hidden = false;
      }
    }).catch(function () {});
  }

  // 个人设置内「切换账号」：登出当前账号并返回登录页，保留已记住的账号列表，
  // 下次可在登录页点选；强制改密码期间禁用。
  function switchAccountFromSettings() {
    if (state.forceChangePwd) {
      toast('出于安全，请先修改密码后再切换账号');
      return;
    }
    if (state.deviceToken) {
      // Supabase query builder 是 thenable 而非完整 Promise，必须先 .then() 再 .catch()
      sb.from('device_sessions').delete().eq('token', state.deviceToken)
        .then(function () {})
        .catch(function () {});
    }
    pendingAvatar = null;
    hideModal('settings-modal');
    // 无论 signOut 成功与否都兜底回到登录页（与登出按钮一致），并刷新账号列表
    sb.auth.signOut({ scope: 'local' })
      .then(function () { teardown(); initLoginRemembered(); })
      .catch(function () { teardown(); initLoginRemembered(); });
  }

  function resetPwdFields() {
    $('settings-newpwd').value = '';
    $('settings-confirm-pwd').value = '';
    $('change-pwd-error').hidden = true;
  }

  /* ============================================================
   *  注销账号（多步确认：确认 → 输入手机号+密码验证 → 再次确认 → 注销）
   * ============================================================ */

  // 步骤1：打开「确认要注销吗」
  function openDeleteAccount() {
    showModal('del-account-modal');
  }

  // 步骤2：进入输入手机号 + 密码验证
  function deleteAccountToVerify() {
    hideModal('del-account-modal');
    var ph = $('del-account-phone');
    ph.value = (state.profile && state.profile.phone) || '';
    $('del-account-pwd').value = '';
    $('del-account-verify-error').hidden = true;
    showModal('del-account-verify');
    try { ph.focus(); } catch (e) {}
  }

  // 步骤2 → 校验手机号与密码，通过后进入步骤3「再次确认」
  function deleteAccountVerify() {
    var phone = $('del-account-phone').value.trim();
    var pwd = $('del-account-pwd').value;
    var err = $('del-account-verify-error');
    err.hidden = true;

    if (!PHONE_RE.test(phone)) { err.textContent = '请输入正确的 11 位手机号'; err.hidden = false; return; }
    if (pwd.length < 6) { err.textContent = '密码至少 6 位'; err.hidden = false; return; }
    if (state.profile && phone !== state.profile.phone) {
      err.textContent = '输入的手机号与当前登录账号不一致';
      err.hidden = false; return;
    }

    var btn = $('del-account-verify-btn');
    btn.disabled = true; btn.textContent = '验证中…';
    // 用手机号+密码重新登录以验证身份（验证失败即密码错误）
    sb.auth.signInWithPassword({ email: emailFor(phone), password: pwd })
      .then(function (r) {
        if (r.error) throw r.error;
        hideModal('del-account-verify');
        $('del-account-final-phone').textContent = phone;
        showModal('del-account-final');
      })
      .catch(function (e) {
        err.textContent = friendlyError(e);
        err.hidden = false;
        btn.disabled = false; btn.textContent = '确认';
      });
  }

  // 步骤3：最终确认 → 调用 RPC 删除账号
  function deleteAccountCommit() {
    var btn = $('del-account-final-btn');
    btn.disabled = true; btn.textContent = '注销中…';
    sb.rpc('delete_my_account')
      .then(function (r) {
        if (r && r.error) throw r.error;
        hideModal('del-account-final');
        toast('账号已注销');
        // 清除本机该账号痕迹（移除记住的账号、登录标记、设备令牌）
        try { clearCurrentAccountLocal(); } catch (e) {}
        // 作废会话并回到登录页（RPC 已删除用户，signOut 兜底）
        sb.auth.signOut({ scope: 'local' })
          .then(function () { teardown(); initLoginRemembered(); })
          .catch(function () { teardown(); initLoginRemembered(); });
      })
      .catch(function (e) {
        var msg = (e && (e.message || e.error_description)) || '';
        if (/delete_my_account|could not find|function .* does not exist|schema .* does not exist/i.test(msg)) {
          toast('注销失败：请先在 Supabase 执行 20260802_delete_account.sql 迁移');
        } else {
          toast('注销失败：' + friendlyError(e));
        }
        btn.disabled = false; btn.textContent = '确认注销';
      });
  }

  /* ============================================================
   *  绝对管理员（GM）后台
   *  入口在个人设置底部（刻意隐蔽）；输入口令后进入页面内覆盖层，
   *  可搜索全站用户、查看其群聊/好友，并强制删除群聊/好友/账号。
   *  口令仅存于本次会话内存，不写入 localStorage；所有 GM 操作 RPC
   *  均在数据库端再次校验口令（gm_check），保证前端拿不到口令也能拦住。
   * ============================================================ */
  var gmPwd = '';        // 本次会话的管理员口令（仅内存）
  var gmCurrent = null;  // 当前正在查看的目标用户 { uid, name, phone }
  // 管理员账号 uid（须与数据库 gm_admin_uid() 一致）。仅用于控制 GM 入口的可见性，
  // 真正的权限仍由后端 gm_check 校验 auth.uid() === gm_admin_uid() 且口令正确，前端拿不到权限。
  var GM_ADMIN_UID = '66f0744b-007b-4d5f-a9bc-2c5e4462baf9';

  // 从后端取“绝对管理员”uid（权威来源，避免前端硬编码漂移）。
  // 取不到（如尚未执行 gm_panel SQL）时回退到上面的常量，保证本机管理员依旧可见入口。
  function refreshGmAdmin() {
    try {
      sb.rpc('gm_admin_uid')
        .then(function (r) {
          if (r && !r.error && r.data) state.gmAdminUid = r.data;
          else state.gmAdminUid = GM_ADMIN_UID;
        })
        .catch(function () { state.gmAdminUid = GM_ADMIN_UID; });
    } catch (e) {
      state.gmAdminUid = GM_ADMIN_UID;
    }
  }

  function isGmAdmin() {
    var a = state.gmAdminUid || GM_ADMIN_UID;
    return !!state.uid && state.uid === a;
  }


  function openGmEntry() {
    $('gm-pwd-input').value = '';
    $('gm-pwd-error').hidden = true;
    var btn = $('gm-pwd-confirm');
    if (btn) { btn.disabled = false; btn.textContent = '进入'; }
    showModal('gm-pwd-modal');
    try { $('gm-pwd-input').focus(); } catch (e) {}
  }

  function gmTryAuth() {
    var pwd = $('gm-pwd-input').value;
    var err = $('gm-pwd-error');
    var btn = $('gm-pwd-confirm');
    function resetBtn() { if (btn) { btn.disabled = false; btn.textContent = '进入'; } }
    err.hidden = true;
    if (!pwd) { err.textContent = '请输入口令'; err.hidden = false; return; }
    btn.disabled = true; btn.textContent = '验证中…';
    try {
      sb.rpc('gm_auth', { p_pwd: pwd })
        .then(function (r) {
          if (r.error) throw r.error;
          if (!r.data) throw new Error('GM_AUTH_FAIL');
          gmPwd = pwd;
          hideModal('gm-pwd-modal');
          closeSettings();
          openGmPanel();
        })
        .catch(function (e) {
          var m = (e && (e.message || '')) || '';
          err.textContent = /GM_AUTH_FAIL|GM_FORBIDDEN/.test(m)
            ? '口令错误或非管理员账号，无法进入'
            : '请求失败：' + friendlyError(e);
          err.hidden = false;
        })
        .then(resetBtn, resetBtn);
    } catch (e) {
      err.textContent = '请求异常，请重试';
      err.hidden = false;
      resetBtn();
    }
  }

  function openGmPanel() {
    state.gmPanelOpen = true;
    $('gm-search-input').value = '';
    $('gm-results').innerHTML = '';
    $('gm-detail').hidden = true;
    $('gm-detail').innerHTML = '';
    showModal('gm-panel');
    try { $('gm-search-input').focus(); } catch (e) {}
  }

  function closeGm() { state.gmPanelOpen = false; stopGmPolling(); hideModal('gm-panel'); }

  function gmSearch() {
    var q = $('gm-search-input').value.trim();
    var box = $('gm-results');
    box.innerHTML = '<div class="gm-empty">搜索中…</div>';
    $('gm-detail').hidden = true;
    $('gm-detail').innerHTML = '';
    sb.rpc('gm_search_users', { p_pwd: gmPwd, p_query: q })
      .then(function (r) {
        if (r.error) throw r.error;
        var rows = r.data || [];
        if (!rows.length) { box.innerHTML = '<div class="gm-empty">未找到匹配用户</div>'; return; }
        box.innerHTML = '';
        rows.forEach(function (u) {
          var card = el('div', 'gm-user');
          var main = el('div', 'gm-user-main');
          var av = el('div', 'avatar sm');
          av.style.background = colorOf(u.nickname || u.phone);
          av.textContent = initialOf(u.nickname || u.phone);
          var info = el('div', 'gm-user-info');
          info.appendChild(el('div', 'gm-user-name', u.nickname || '(无昵称)'));
          info.appendChild(el('div', 'gm-user-phone', u.phone || ''));
          if (u.remark) info.appendChild(el('div', 'gm-user-phone', '备注：' + u.remark));
          main.appendChild(av); main.appendChild(info);
          var btn = el('button', 'btn-mini', '管理');
          btn.type = 'button';
          btn.onclick = function () { gmLoadDetail(u.id, u.nickname, u.phone); };
          card.appendChild(main); card.appendChild(btn);
          box.appendChild(card);
        });
      })
      .catch(function (e) {
        var m = (e && (e.message || '')) || '';
        if (/GM_AUTH_FAIL/.test(m)) box.innerHTML = '<div class="gm-empty">口令已失效，请重新进入</div>';
        else box.innerHTML = '<div class="gm-empty">搜索失败：' + friendlyError(e) + '</div>';
      });
  }

  function gmLoadDetail(uid, name, phone) {
    gmCurrent = { uid: uid, name: name, phone: phone };
    var box = $('gm-detail');
    box.hidden = false;
    box.innerHTML = '<div class="gm-loading">加载中…</div>';
    sb.rpc('gm_list_user_groups', { p_pwd: gmPwd, p_user_id: uid })
      .then(function (gr) {
        if (gr.error) throw gr.error;
        var groups = gr.data || [];
        return sb.rpc('gm_list_user_friends', { p_pwd: gmPwd, p_user_id: uid })
          .then(function (fr) {
            if (fr.error) throw fr.error;
            renderGmDetail(uid, name, phone, groups, fr.data || []);
          });
      })
      .catch(function (e) {
        var m = (e && (e.message || '')) || '';
        if (/GM_AUTH_FAIL/.test(m)) box.innerHTML = '<div class="gm-empty">口令已失效，请重新进入</div>';
        else box.innerHTML = '<div class="gm-empty">加载失败：' + friendlyError(e) + '</div>';
      });
  }

  function renderGmDetail(uid, name, phone, groups, friends) {
    var box = $('gm-detail');
    box.innerHTML = '';

    var head = el('div', 'gm-detail-head');
    head.appendChild(el('div', 'gm-detail-name', (name || '(无昵称)') + '  ·  ' + (phone || '')));
    var accBtn = el('button', 'btn-danger gm-acc-del', '注销该账号');
    accBtn.type = 'button';
    accBtn.onclick = function () { gmForceDeleteAccount(uid, name); };
    head.appendChild(accBtn);
    box.appendChild(head);

    box.appendChild(el('div', 'gm-subtitle', '群聊（' + groups.length + '）'));
    if (!groups.length) box.appendChild(el('div', 'gm-empty', '无群聊'));
    groups.forEach(function (g) {
      var row = el('div', 'gm-row');
      var txt = el('div', 'gm-row-text');
      txt.appendChild(el('div', 'gm-row-name', g.name));
      txt.appendChild(el('div', 'gm-row-sub', (g.is_owner ? '群主' : '成员') + ' · ' + (g.member_count || 0) + ' 人'));
      row.appendChild(txt);
      var b = el('button', 'btn-mini gm-danger', '强制删除');
      b.type = 'button';
      b.onclick = function () { gmForceDeleteGroup(uid, g.group_id, g.name); };
      row.appendChild(b);
      var chatBtn = el('button', 'btn-mini', '聊天');
      chatBtn.type = 'button';
      chatBtn.onclick = function () { gmOpenGroupChat(g.group_id, g.name, uid); };
      row.appendChild(chatBtn);
      box.appendChild(row);
    });

    box.appendChild(el('div', 'gm-subtitle', '好友（' + friends.length + '）'));
    if (!friends.length) box.appendChild(el('div', 'gm-empty', '无好友'));
    friends.forEach(function (f) {
      var row = el('div', 'gm-row');
      var txt = el('div', 'gm-row-text');
      txt.appendChild(el('div', 'gm-row-name', f.other_nickname || '(无昵称)'));
      txt.appendChild(el('div', 'gm-row-sub', (f.other_phone || '') + ' · ' + (f.status || '')));
      row.appendChild(txt);
      var b = el('button', 'btn-mini gm-danger', '删除好友');
      b.type = 'button';
      b.onclick = function () { gmForceDeleteFriend(uid, f.other_id, f.other_nickname); };
      row.appendChild(b);
      var chatBtn = el('button', 'btn-mini', '聊天');
      chatBtn.type = 'button';
      chatBtn.onclick = function () { gmOpenDmChat(uid, f.other_id, f.other_nickname); };
      row.appendChild(chatBtn);
      box.appendChild(row);
    });

    renderGmUserTitles(uid);
    renderGmMuteSection(uid);
  }

  // GM 用户详情里的「禁言管理」区块
  function renderGmMuteSection(uid) {
    var box = $('gm-detail');
    var sec = el('div', 'gm-mute-sec');
    sec.appendChild(el('div', 'gm-subtitle', '禁言管理'));
    var status = el('div', 'gm-mute-status', '加载中…');
    sec.appendChild(status);
    var row = el('div', 'gm-mute-row');
    var durLabel = el('span', 'gm-mute-label', '禁言时长：');
    var inpD = el('input', 'gm-dur-input'); inpD.type = 'number'; inpD.min = '0'; inpD.max = '365'; inpD.value = '0'; inpD.placeholder = '天';
    var inpH = el('input', 'gm-dur-input'); inpH.type = 'number'; inpH.min = '0'; inpH.max = '23'; inpH.value = '0'; inpH.placeholder = '时';
    var inpM = el('input', 'gm-dur-input'); inpM.type = 'number'; inpM.min = '0'; inpM.max = '59'; inpM.value = '30'; inpM.placeholder = '分';
    var muteBtn = el('button', 'btn-mini', '禁言'); muteBtn.type = 'button';
    var unmuteBtn = el('button', 'btn-mini gm-danger', '立即解除'); unmuteBtn.type = 'button';
    row.appendChild(durLabel);
    row.appendChild(inpD); row.appendChild(inpH); row.appendChild(inpM);
    row.appendChild(muteBtn); row.appendChild(unmuteBtn);
    sec.appendChild(row);
    box.appendChild(sec);

    function refresh() {
      sb.rpc('gm_get_user_mute', { p_pwd: gmPwd, p_user_id: uid })
        .then(function (r) {
          if (r.error) throw r.error;
          var u = r.data || null;
          status.textContent = u
            ? ('禁言中，将于 ' + formatMuteUntil(u) + ' 自动解除')
            : '未禁言';
        })
        .catch(function () { status.textContent = '状态获取失败'; });
    }
    muteBtn.onclick = function () {
      var d = parseInt(inpD.value, 10) || 0;
      var h = parseInt(inpH.value, 10) || 0;
      var m = parseInt(inpM.value, 10) || 0;
      if (d < 0 || h < 0 || h > 23 || m < 0 || m > 59) { toast('请填写有效的禁言时长'); return; }
      if (d === 0 && h === 0 && m === 0) { toast('请至少填写 1 分钟'); return; }
      sb.rpc('gm_mute_user', { p_pwd: gmPwd, p_user_id: uid, p_days: d, p_hours: h, p_minutes: m })
        .then(function (r) {
          if (r.error) throw r.error;
          toast('已禁言 ' + muteLenText(d, h, m));
          refresh();
        })
        .catch(function (e) { toast('禁言失败：' + friendlyError(e)); });
    };
    unmuteBtn.onclick = function () {
      sb.rpc('gm_unmute_user', { p_pwd: gmPwd, p_user_id: uid })
        .then(function (r) {
          if (r.error) throw r.error;
          toast('已解除禁言');
          refresh();
        })
        .catch(function (e) { toast('解除失败：' + friendlyError(e)); });
    };
    refresh();
  }

  function gmForceDeleteGroup(uid, gid, gname) {
    if (!window.confirm('确认强制删除群聊「' + (gname || gid) + '」？该群所有成员与消息将一并删除。')) return;
    sb.rpc('gm_force_delete_group', { p_pwd: gmPwd, p_group_id: gid })
      .then(function (r) {
        if (r.error) throw r.error;
        toast('已强制删除群聊：' + (gname || ''));
        if (gmCurrent && gmCurrent.uid === uid) gmLoadDetail(gmCurrent.uid, gmCurrent.name, gmCurrent.phone);
      })
      .catch(function (e) { toast('删除失败：' + friendlyError(e)); });
  }

  function gmForceDeleteFriend(uid, otherId, otherName) {
    if (!window.confirm('确认删除该好友关系（' + (otherName || otherId) + '）？双方都会失去这段好友关系。')) return;
    sb.rpc('gm_force_delete_friendship', { p_pwd: gmPwd, p_user_a: uid, p_user_b: otherId })
      .then(function (r) {
        if (r.error) throw r.error;
        toast('已删除好友关系：' + (otherName || ''));
        if (gmCurrent && gmCurrent.uid === uid) gmLoadDetail(gmCurrent.uid, gmCurrent.name, gmCurrent.phone);
      })
      .catch(function (e) { toast('删除失败：' + friendlyError(e)); });
  }

  function gmForceDeleteAccount(uid, name) {
    if (!window.confirm('确认注销账号「' + (name || uid) + '」？该账号及全部数据将被永久删除，不可恢复。')) return;
    sb.rpc('gm_force_delete_account', { p_pwd: gmPwd, p_user_id: uid })
      .then(function (r) {
        if (r.error) throw r.error;
        toast('已注销账号：' + (name || ''));
        $('gm-detail').hidden = true;
        $('gm-detail').innerHTML = '';
        gmSearch();
      })
      .catch(function (e) { toast('注销失败：' + friendlyError(e)); });
  }

  // ---------- GM 群聊管理（搜索 / 成员在线 / 剥夺群主 / 移除成员 / 解散） ----------
  var gmGroupCurrent = null; // 当前正在查看的群 { gid, name }

  function openGmGroupsTab() {
    $('gm-group-search-input').value = '';
    $('gm-group-results').innerHTML = '';
    $('gm-group-detail').hidden = true;
    $('gm-group-detail').innerHTML = '';
  }

  function openGmAppealsTab(silent) {
    var box = $('gm-appeal-list');
    if (!box) return;
    if (!silent) box.innerHTML = '<div class="gm-loading">加载中…</div>';
    sb.rpc('gm_list_mute_appeals', { p_pwd: gmPwd })
      .then(function (r) {
        if (r.error) throw r.error;
        state.gmAppealsAll = r.data || [];
        renderGmAppeals();
      })
      .catch(function (e) {
        var m = (e && (e.message || '')) || '';
        var box2 = $('gm-appeal-list');
        if (!box2) return;
        if (/BAD_PWD|GM_AUTH_FAIL/.test(m)) box2.innerHTML = '<div class="gm-empty">口令已失效，请重新进入</div>';
        else box2.innerHTML = '<div class="gm-empty">加载失败：' + friendlyError(e) + '</div>';
      });
  }

  function renderGmAppeals() {
    var box = $('gm-appeal-list');
    if (!box) return;
    var kw = ((($('gm-appeal-search') && $('gm-appeal-search').value) || '').trim().toLowerCase());
    var rows = state.gmAppealsAll || [];
    if (kw) {
      rows = rows.filter(function (a) {
        var n = (a.nickname || '').toLowerCase();
        var p = (a.phone || '').toLowerCase();
        return n.indexOf(kw) >= 0 || p.indexOf(kw) >= 0;
      });
    }
    box.innerHTML = '';
    if (!rows.length) { box.innerHTML = '<div class="gm-empty">' + (kw ? '无匹配结果' : '暂无禁言申诉') + '</div>'; return; }
    rows.forEach(function (a) { box.appendChild(buildAppealCard(a, 'gm')); });
  }

  function gmReviewAppeal(id, action, name) {
    var verb = action === 'approve' ? '通过并解禁' : '驳回';
    if (!window.confirm('确认' + verb + '「' + (name || id) + '」的申诉？')) return;
    sb.rpc('gm_review_mute_appeal', { p_pwd: gmPwd, p_id: id, p_action: action })
      .then(function (r) {
        if (r.error) throw r.error;
        toast('已' + (action === 'approve' ? '通过，已解除禁言' : '驳回'));
        openGmAppealsTab();
      })
      .catch(function (e) { toast('操作失败：' + friendlyError(e)); });
  }

  // GM 后台「用户举报」列表（绝对管理员口令鉴权，留存、可搜索、不可删除、只读）
  function openGmUserReportsTab(silent) {
    var box = $('gm-userreport-list');
    if (box && !silent) box.innerHTML = '<div class="gm-loading">加载中…</div>';
    sb.rpc('gm_list_user_reports', { p_pwd: gmPwd })
      .then(function (r) {
        if (r.error) throw r.error;
        state.gmUserReportsAll = r.data || [];
        renderGmUserReports();
      })
      .catch(function (e) {
        var m = (e && (e.message || '')) || '';
        var box2 = $('gm-userreport-list');
        if (!box2) return;
        box2.innerHTML = /GM_AUTH_FAIL/.test(m)
          ? '<div class="gm-empty">口令已失效，请重新进入</div>'
          : '<div class="gm-empty">加载失败：' + friendlyError(e) + '</div>';
      });
  }

  function renderGmUserReports() {
    var box = $('gm-userreport-list');
    if (!box) return;
    var kw = ((($('gm-userreport-search') && $('gm-userreport-search').value) || '').trim().toLowerCase());
    var rows = state.gmUserReportsAll || [];
    if (kw) {
      rows = rows.filter(function (rep) {
        var fields = [rep.reporter_nickname, rep.reporter_phone, rep.reported_name, rep.reported_kind, rep.target_ref, rep.detail, rep.report_type];
        return fields.some(function (f) { return (f || '').toLowerCase().indexOf(kw) >= 0; });
      });
    }
    box.innerHTML = '';
    if (!rows.length) { box.innerHTML = '<div class="gm-empty">' + (kw ? '无匹配结果' : '暂无用户举报') + '</div>'; return; }
    var CAP = 200;
    var shown = 0;
    rows.forEach(function (rep) {
      if (shown >= CAP) return;
      box.appendChild(renderUserReportCardGm(rep));
      shown++;
    });
    if (rows.length > CAP) {
      box.appendChild(el('div', 'gm-empty', '仅显示最近 ' + CAP + ' 条（共 ' + rows.length + ' 条）'));
    }
  }

  // 用户举报卡片（GM 后台只读版：展示内容 + 图片预览，无禁言 / 不禁言 / 忽略 / 删除按钮，保证留存）
  function renderUserReportCardGm(rep) {
    var card = el('div', 'gm-report');
    var head = el('div', 'gm-report-head');
    var name = el('div', 'gm-report-name',
      (rep.reporter_nickname || '(匿名)') + ' 举报 ' + (rep.reported_name || (rep.reported_kind === 'group' ? '群聊' : '用户')));
    var badge = el('div', 'gm-report-badge' + (rep.status === 'handled' ? ' done' : ''),
      rep.status === 'handled' ? '已处理' : '待处理');
    head.appendChild(name); head.appendChild(badge);
    card.appendChild(head);

    var typeTxt = { nickname: '昵称', message: '信息', video: '视频', image: '图片', other: '其他' }[rep.report_type] || rep.report_type;
    card.appendChild(el('div', 'gm-report-sub',
      '类型：' + typeTxt + ' · 提交时间：' + (rep.created_at ? rep.created_at.replace('T', ' ').slice(0, 16) : '—')));

    if (rep.reporter_phone) card.appendChild(el('div', 'gm-report-sub', '举报人手机号：' + rep.reporter_phone));
    if (rep.target_ref)   card.appendChild(el('div', 'gm-report-line', '被举报内容：' + rep.target_ref));
    if (rep.detail)       card.appendChild(el('div', 'gm-report-line', '补充说明：' + rep.detail));

    if (rep.file_path) {
      var isVid = rep.report_type === 'video' || /\.(mp4|webm|mov|ogg|m4v)$/i.test(rep.file_path || '');
      var media = el('div', 'gm-report-media');
      var thumb = document.createElement(isVid ? 'video' : 'img');
      if (isVid) { thumb.controls = true; thumb.preload = 'metadata'; thumb.playsInline = true; }
      else { thumb.alt = '举报图片'; thumb.loading = 'lazy'; }
      thumb.className = 'report-thumb';
      media.appendChild(thumb);
      card.appendChild(media);
      signedUrl(rep.file_path).then(function (u) {
        if (!u) return;
        if (isVid) {
          thumb.src = u;
          thumb.onclick = function (e) { e.stopPropagation(); openReportPreview(u, true); };
        } else {
          thumb.src = u;
          thumb.onclick = function () { openReportPreview(u, false); };
        }
      });
    }
    return card;
  }

  // ---------- GM 问题反馈列表 ----------
  function openGmFeedbackTab(silent) {
    var box = $('gm-feedback');
    if (!box) return;
    if (!silent) box.innerHTML = '<div class="gm-loading">加载中…</div>';
    sb.rpc('gm_list_feedback', { p_pwd: gmPwd })
      .then(function (r) {
        if (r.error) throw r.error;
        var rows = r.data || [];
        box.innerHTML = '';
        if (!rows.length) { box.innerHTML = '<div class="gm-empty">暂无反馈</div>'; return; }
        rows.forEach(function (f) {
          var card = el('div', 'gm-report');
          var head = el('div', 'gm-report-head');
          var name = el('div', 'gm-report-name', (f.nickname || '(无昵称)') + ' · ' + (f.phone || '—'));
          head.appendChild(name);
          var badge = el('div', 'gm-report-badge' + (f.status === 'new' ? '' : ' done'),
            f.status === 'new' ? '未读' : '已读');
          head.appendChild(badge);
          card.appendChild(head);
          card.appendChild(el('div', 'gm-report-sub', '提交时间：' + (f.created_at ? f.created_at.replace('T', ' ').slice(0, 16) : '—')));
          card.appendChild(el('div', 'gm-report-line', '内容：' + (f.content || '')));
          if (f.contact) card.appendChild(el('div', 'gm-report-sub', '联系方式：' + f.contact));

          if (f.status === 'new') {
            var acts = el('div', 'gm-row-acts');
            var read = el('button', 'btn-mini', '标记已读'); read.type = 'button';
            read.onclick = function () { gmMarkFeedbackRead(f.id); };
            acts.appendChild(read);
            card.appendChild(acts);
          }
          box.appendChild(card);
        });
      })
      .catch(function (e) {
        var m = (e && (e.message || '')) || '';
        if (/BAD_PWD|GM_AUTH_FAIL/.test(m)) box.innerHTML = '<div class="gm-empty">口令已失效，请重新进入</div>';
        else box.innerHTML = '<div class="gm-empty">加载失败：' + friendlyError(e) + '</div>';
      });
  }

  function gmMarkFeedbackRead(id) {
    sb.rpc('gm_mark_feedback_read', { p_pwd: gmPwd, p_id: id })
      .then(function (r) { if (r.error) throw r.error; openGmFeedbackTab(); })
      .catch(function (e) { toast('操作失败：' + friendlyError(e)); });
  }

  // 违禁词记录：列出「任意」被系统检测出的违禁词（含发给陌生人 / 群聊），不限于好友
  // GM 后台留存、可搜索、不可删除（仅批量禁言，不隐藏记录）
  function openGmWordLogTab(silent) {
    var box = $('gm-word-log-list');
    if (!box) return;
    if (!silent) box.innerHTML = '<div class="gm-loading">加载中…</div>';
    sb.rpc('gm_list_word_log', { p_pwd: gmPwd })
      .then(function (r) {
        if (r.error) return; // 兼容旧部署：函数不存在时静默
        state.gmWordLogAll = r.data || [];
        renderGmWordLog();
      })
      .catch(function () { var b = $('gm-word-log-list'); if (b) b.innerHTML = '<div class="gm-empty">暂无违禁词检测记录</div>'; });
  }

  function renderGmWordLog() {
    var box = $('gm-word-log-list');
    if (!box) return;
    var kw = ((($('gm-word-log-search') && $('gm-word-log-search').value) || '').trim().toLowerCase());
    var rows = state.gmWordLogAll || [];
    if (kw) {
      rows = rows.filter(function (w) {
        var fields = [w.nickname, w.phone, w.word, w.content, w.peer_name];
        return fields.some(function (f) { return (f || '').toLowerCase().indexOf(kw) >= 0; });
      });
    }
    box.innerHTML = '';
    if (!rows.length) { box.innerHTML = '<div class="gm-empty">' + (kw ? '无匹配结果' : '暂无违禁词检测记录') + '</div>'; return; }
    var CAP = 100;
    var shown = 0;
    rows.forEach(function (w) {
      if (shown >= CAP) return;
      box.appendChild(renderWordLogCard(w));
      shown++;
    });
    if (rows.length > CAP) {
      box.appendChild(el('div', 'gm-empty', '仅显示最近 ' + CAP + ' 条（共 ' + rows.length + ' 条）'));
    }
    var saG = $('gm-wl-selectall'); if (saG) saG.checked = false;
    updateWlCount('gm');
  }

  // 单条违禁词检测卡片（GM 后台与「管理员」面板共用）
  function renderWordLogCard(w, mode) {
    var card = el('div', 'gm-report');
    // 多选勾选框（批量禁言 / 不禁言 / 删除用）
    var selRow = el('div', 'wl-check-row');
    var cb = el('input');
    cb.type = 'checkbox';
    cb.className = 'wl-check';
    cb.setAttribute('data-id', w.id || '');
    if (w.user_id) cb.setAttribute('data-uid', w.user_id);
    cb.title = '选择此条';
    selRow.appendChild(cb);
    card.appendChild(selRow);
    var head = el('div', 'gm-report-head');
    head.appendChild(el('div', 'gm-report-name', (w.nickname || '(无昵称)') + ' · ' + (w.phone || '—')));
    head.appendChild(el('div', 'gm-report-badge', '命中：' + (w.word || '?')));
    card.appendChild(head);
    card.appendChild(el('div', 'gm-report-sub', '时间：' + (w.created_at ? w.created_at.replace('T', ' ').slice(0, 16) : '—')));
    card.appendChild(el('div', 'gm-report-line', '内容：' + (w.content || '')));
    var peerTxt = w.peer_type === 'group'
      ? ('群聊「' + (w.peer_name || '') + '」')
      : w.peer_type === 'user'
        ? ((w.peer_name || '') + ' · ' + (w.peer_phone || ''))
        : '（未知 / 未记录）';
    card.appendChild(el('div', 'gm-report-line', '接收方：' + peerTxt));

    // 管理员模式：可对发送违禁词者禁言 / 标记不禁言（全网隐藏）/ 忽略（仅自己隐藏）
    if (mode === 'admin' && w.user_id) {
      card.appendChild(buildMuteRow('word_warning', w.id, w.user_id));
      var acts = el('div', 'gm-report-acts');
      acts.appendChild(noMuteBtn('word_warning', w.id));
      acts.appendChild(ignoreBtn('word_warning', w.id));
      card.appendChild(acts);
    }
    return card;
  }

  // ---------- 违禁词记录：多选 + 批量禁言 / 不禁言 / 删除 ----------
  // 顺序执行任务数组（避免 Supabase thenable 的 Promise.all 陷阱）；全部完成回调 done，任一失败回调 fail 并停止
  function seqRun(tasks, done, fail) {
    var i = 0;
    function step() {
      if (i >= tasks.length) { if (done) done(); return; }
      var t = tasks[i++];
      t().then(step, fail);
    }
    step();
  }

  // 收集某面板当前勾选的记录：返回 { ids:[记录id], uids:[去重后的违规用户id], count:勾选数 }
  function collectCheckedWl(panel) {
    var listId = (panel === 'gm') ? 'gm-word-log-list' : 'admin-word-log-list';
    var list = $(listId);
    var ids = [], uids = [], count = 0;
    if (list) {
      var boxes = list.querySelectorAll('.wl-check');
      for (var i = 0; i < boxes.length; i++) {
        var b = boxes[i];
        if (!b.checked) continue;
        count++;
        var id = b.getAttribute('data-id');
        if (id) ids.push(id);
        var u = b.getAttribute('data-uid');
        if (u && uids.indexOf(u) < 0) uids.push(u);
      }
    }
    return { ids: ids, uids: uids, count: count };
  }

  // 绑定某面板的批量操作栏（全选 / 列表勾选变化计数 / 三个批量按钮）
  function bindWlBatch(panel) {
    var pre = (panel === 'gm') ? 'gm-wl' : 'admin-wl';
    var listId = (panel === 'gm') ? 'gm-word-log-list' : 'admin-word-log-list';
    var selAll = $(pre + '-selectall');
    var list = $(listId);
    if (selAll) selAll.addEventListener('change', function () {
      var boxes = list.querySelectorAll('.wl-check');
      for (var i = 0; i < boxes.length; i++) boxes[i].checked = this.checked;
      updateWlCount(panel);
    });
    if (list) list.addEventListener('change', function () { updateWlCount(panel); });
    var mute = $(pre + '-mute'); if (mute) mute.addEventListener('click', function () { batchWlMute(panel); });
    var nomute = $(pre + '-nomute'); if (nomute) nomute.addEventListener('click', function () { batchWlNoMute(panel); });
    var del = $(pre + '-del'); if (del) del.addEventListener('click', function () { batchWlDelete(panel); });
  }

  function reloadWl(panel) {
    if (panel === 'gm') openGmWordLogTab();
    else openAdminWordLog();
  }

  function updateWlCount(panel) {
    var sel = collectCheckedWl(panel);
    var pre = (panel === 'gm') ? 'gm-wl' : 'admin-wl';
    var c = $(pre + '-count');
    if (c) c.textContent = '已选 ' + sel.count + ' 项';
  }

  // 批量禁言：禁言每个去重后的违规用户，并把这些记录标记为「仅自己隐藏」（个人端，其他用户不变）
  function batchWlMute(panel) {
    var sel = collectCheckedWl(panel);
    if (!sel.ids.length) { toast('请先勾选要禁言的记录'); return; }
    var pre = (panel === 'gm') ? 'gm-wl' : 'admin-wl';
    var d = parseInt($(pre + '-days').value, 10) || 0;
    var h = parseInt($(pre + '-hours').value, 10) || 0;
    var m = parseInt($(pre + '-mins').value, 10) || 0;
    var total = d * 1440 + h * 60 + m;
    if (total < 1) { toast('请至少填写 1 分钟禁言时长'); return; }
    if (total > 28800) { toast('禁言时长上限为 20 天'); return; }
    if (!window.confirm('确认对选中的 ' + sel.ids.length + ' 条记录执行「禁言」？将禁言 ' + sel.uids.length + ' 名用户，并对所有管理员/开发者隐藏这些记录。')) return;
    var muteFn = (panel === 'gm')
      ? function (uid) { return sb.rpc('gm_mute_user', { p_pwd: gmPwd, p_user_id: uid, p_days: d, p_hours: h, p_minutes: m }); }
      : function (uid) { return sb.rpc('admin_mute_user', { p_user_id: uid, p_days: d, p_hours: h, p_minutes: m }); };
    var tasks = [];
    sel.uids.forEach(function (uid) { tasks.push(function () { return muteFn(uid); }); });
    // 仅「管理员」面板隐藏记录；GM 后台为留存日志，禁言但不隐藏，记录始终可见
    if (panel !== 'gm') {
      sel.ids.forEach(function (id) { tasks.push(function () { return sb.rpc('set_content_hide', { p_target_type: 'word_warning', p_target_id: id, p_kind: 'global' }); }); });
    }
    seqRun(tasks,
      function () {
        toast('已批量禁言 ' + sel.uids.length + ' 人' + (panel === 'gm' ? '（记录已留存）' : ('，并隐藏 ' + sel.ids.length + ' 条记录')));
        reloadWl(panel);
      },
      function (e) {
        var msg = (e && (e.message || '')) || '';
        if (/GM_AUTH_FAIL/.test(msg)) toast('口令已失效，请重新进入');
        else if (/ADMIN_FORBIDDEN/.test(msg)) onAdminRevoked();
        else toast('批量禁言失败：' + friendlyError(e));
      });
  }

  // 批量不禁言：把选中记录标记为「全局隐藏」（所有管理员都不可见，禁言动作对全员生效）
  function batchWlNoMute(panel) {
    var sel = collectCheckedWl(panel);
    if (!sel.ids.length) { toast('请先勾选记录'); return; }
    if (!window.confirm('确认对选中的 ' + sel.ids.length + ' 条记录标记为「不禁言」？将对所有管理员/开发者隐藏这些记录。')) return;
    var tasks = [];
    sel.ids.forEach(function (id) { tasks.push(function () { return sb.rpc('set_content_hide', { p_target_type: 'word_warning', p_target_id: id, p_kind: 'global' }); }); });
    seqRun(tasks,
      function () { toast('已标记 ' + sel.ids.length + ' 条为「不禁言」并隐藏'); reloadWl(panel); },
      function (e) {
        var msg = (e && (e.message || '')) || '';
        if (/GM_AUTH_FAIL/.test(msg)) toast('口令已失效');
        else if (/ADMIN_FORBIDDEN/.test(msg)) onAdminRevoked();
        else toast('操作失败：' + friendlyError(e));
      });
  }

  // 批量删除：个人端隐藏（仅自己不可见，其他用户不变），不再硬删
  function batchWlDelete(panel) {
    var sel = collectCheckedWl(panel);
    if (!sel.ids.length) { toast('请先勾选要隐藏的记录'); return; }
    if (!window.confirm('确认隐藏选中的 ' + sel.ids.length + ' 条违禁词记录？仅你自己不再显示，其他人仍可见。')) return;
    var tasks = sel.ids.map(function (id) {
      return function () { return sb.rpc('set_content_hide', { p_target_type: 'word_warning', p_target_id: id, p_kind: 'ignore' }); };
    });
    seqRun(tasks,
      function () { toast('已隐藏 ' + sel.ids.length + ' 条违禁词记录（仅你自己不可见）'); reloadWl(panel); },
      function (e) {
        var msg = (e && (e.message || '')) || '';
        if (/GM_AUTH_FAIL/.test(msg)) toast('口令已失效');
        else if (/ADMIN_FORBIDDEN/.test(msg)) onAdminRevoked();
        else toast('操作失败：' + friendlyError(e));
      });
  }

  // ---------- 用户举报：多选 + 批量禁言 / 不禁言 / 删除 ----------
  function collectCheckedUr() {
    var list = $('admin-userreport-list');
    var ids = [], uids = [], count = 0;
    if (list) {
      var boxes = list.querySelectorAll('.ur-check');
      for (var i = 0; i < boxes.length; i++) {
        var b = boxes[i];
        if (!b.checked) continue;
        count++;
        var id = b.getAttribute('data-id'); if (id) ids.push(id);
        var u = b.getAttribute('data-uid'); if (u && uids.indexOf(u) < 0) uids.push(u);
      }
    }
    return { ids: ids, uids: uids, count: count };
  }

  function updateUrCount() {
    var sel = collectCheckedUr();
    var c = $('admin-ur-count');
    if (c) c.textContent = '已选 ' + sel.count + ' 项';
  }

  function bindUrBatch() {
    var selAll = $('admin-ur-selectall');
    var list = $('admin-userreport-list');
    if (selAll) selAll.addEventListener('change', function () {
      var boxes = list.querySelectorAll('.ur-check');
      for (var i = 0; i < boxes.length; i++) boxes[i].checked = this.checked;
      updateUrCount();
    });
    if (list) list.addEventListener('change', function () { updateUrCount(); });
    var mute = $('admin-ur-mute');   if (mute)   mute.addEventListener('click', batchUrMute);
    var nomute = $('admin-ur-nomute'); if (nomute) nomute.addEventListener('click', batchUrNoMute);
    var del = $('admin-ur-del');     if (del)     del.addEventListener('click', batchUrDelete);
    var clr = $('admin-ur-clear');   if (clr)     clr.addEventListener('click', clearAllUserReports);
  }

  // 批量禁言：禁言每个去重后的「被举报用户」（仅 user 类），并把这些举报标记已处理
  function batchUrMute() {
    var sel = collectCheckedUr();
    if (!sel.ids.length) { toast('请先勾选要禁言的举报'); return; }
    var d = parseInt($('admin-ur-days').value, 10) || 0;
    var h = parseInt($('admin-ur-hours').value, 10) || 0;
    var m = parseInt($('admin-ur-mins').value, 10) || 0;
    var total = d * 1440 + h * 60 + m;
    if (total < 1) { toast('请至少填写 1 分钟禁言时长'); return; }
    if (total > 28800) { toast('禁言时长上限为 20 天'); return; }
    if (!window.confirm('确认对选中的 ' + sel.ids.length + ' 条举报执行「禁言」？将禁言 ' + sel.uids.length + ' 名被举报用户并标记处理。')) return;
    var tasks = [];
    sel.uids.forEach(function (uid) {
      tasks.push(function () { return sb.rpc('admin_mute_user', { p_user_id: uid, p_days: d, p_hours: h, p_minutes: m }); });
    });
    sel.ids.forEach(function (id) {
      tasks.push(function () { return sb.rpc('resolve_user_report', { p_report_id: id, p_handled: true }); });
    });
    seqRun(tasks,
      function () { toast('已禁言 ' + sel.uids.length + ' 人，并标记 ' + sel.ids.length + ' 条举报为已处理'); openUserReports(); loadAllUnread(); },
      function (e) {
        var msg = (e && (e.message || '')) || '';
        if (/ADMIN_FORBIDDEN/.test(msg)) onAdminRevoked();
        else toast('批量禁言失败：' + friendlyError(e));
      });
  }

  // 批量不禁言：把选中举报标记为已处理（不执行禁言）
  function batchUrNoMute() {
    var sel = collectCheckedUr();
    if (!sel.ids.length) { toast('请先勾选举报'); return; }
    if (!window.confirm('确认对选中的 ' + sel.ids.length + ' 条举报标记为「不禁言」（标记已处理，不执行禁言）？')) return;
    var tasks = [];
    sel.ids.forEach(function (id) {
      tasks.push(function () { return sb.rpc('resolve_user_report', { p_report_id: id, p_handled: true }); });
    });
    seqRun(tasks,
      function () { toast('已标记 ' + sel.ids.length + ' 条举报为已处理（不禁言）'); openUserReports(); loadAllUnread(); },
      function (e) {
        var msg = (e && (e.message || '')) || '';
        if (/ADMIN_FORBIDDEN/.test(msg)) onAdminRevoked();
        else toast('操作失败：' + friendlyError(e));
      });
  }

  // 批量删除：个人端隐藏，仅自己不可见，其他用户不变（一次性批量 RPC，避免记录多时卡住）
  function batchUrDelete() {
    var sel = collectCheckedUr();
    if (!sel.ids.length) { toast('请先勾选要隐藏的举报'); return; }
    if (!window.confirm('确认隐藏选中的 ' + sel.ids.length + ' 条用户举报？仅你自己不再显示，其他人仍可见。')) return;
    var btn = $('admin-ur-del');
    if (btn) { btn.disabled = true; btn.textContent = '隐藏中…'; }
    sb.rpc('admin_hide_user_reports', { p_ids: sel.ids })
      .then(function (r) {
        if (r.error) throw r.error;
        toast('已隐藏 ' + sel.ids.length + ' 条用户举报（仅你自己不可见）');
        openUserReports(); loadAllUnread();
      })
      .catch(function (e) {
        var msg = (e && (e.message || '')) || '';
        if (/ADMIN_FORBIDDEN/.test(msg)) onAdminRevoked();
        else toast('删除失败：' + friendlyError(e));
      })
      .then(function () {
        if (btn) { btn.disabled = false; btn.textContent = '批量删除'; }
      });
  }

  // 清空全部：个人端隐藏所有用户举报（仅自己不可见，其他人仍可见）
  // 2026-08-06 改为调用一次性 RPC admin_clear_user_reports()，不再逐条串行 set_content_hide，避免记录多时卡住。
  function clearAllUserReports() {
    var list = $('admin-userreport-list');
    var ids = [];
    if (list) {
      var boxes = list.querySelectorAll('.ur-check');
      for (var i = 0; i < boxes.length; i++) {
        var id = boxes[i].getAttribute('data-id');
        if (id) ids.push(id);
      }
    }
    if (!ids.length) { toast('当前没有可隐藏的举报'); return; }
    if (!window.confirm('⚠️ 确认隐藏【全部】用户举报（共 ' + ids.length + ' 条）？\n仅你本人不再显示，其他人仍可见，GM 后台记录永不删除。')) return;
    if (!window.confirm('再次确认：仅对自己隐藏全部用户举报？此操作不影响其他管理员/开发者。')) return;
    var btn = $('admin-ur-clear');
    if (btn) { btn.disabled = true; btn.textContent = '清空中…'; }
    sb.rpc('admin_clear_user_reports')
      .then(function (r) {
        if (r.error) throw r.error;
        toast('已隐藏全部用户举报（' + ids.length + ' 条，仅你自己不可见）');
        openUserReports(); loadAllUnread();
      })
      .catch(function (e) {
        var msg = (e && (e.message || '')) || '';
        if (/ADMIN_FORBIDDEN/.test(msg)) onAdminRevoked();
        else toast('清空失败：' + friendlyError(e));
      })
      .then(function () {
        if (btn) { btn.disabled = false; btn.textContent = '清空全部'; }
      });
  }

  function gmSearchGroups() {
    var q = $('gm-group-search-input').value.trim();
    var box = $('gm-group-results');
    box.innerHTML = '<div class="gm-empty">搜索中…</div>';
    $('gm-group-detail').hidden = true;
    $('gm-group-detail').innerHTML = '';
    sb.rpc('gm_search_groups', { p_pwd: gmPwd, p_query: q })
      .then(function (r) {
        if (r.error) throw r.error;
        var rows = r.data || [];
        if (!rows.length) { box.innerHTML = '<div class="gm-empty">未找到匹配群聊</div>'; return; }
        box.innerHTML = '';
        rows.forEach(function (g) {
          var card = el('div', 'gm-user');
          var main = el('div', 'gm-user-main');
          var av = el('div', 'avatar sm');
          av.textContent = initialOf(g.name);
          av.style.background = '#7f77dd';
          var info = el('div', 'gm-user-info');
          info.appendChild(el('div', 'gm-user-name', g.name || '(未命名群)'));
          info.appendChild(el('div', 'gm-user-phone', '群主：' + (g.owner_nickname || '?') + ' · ' + (g.member_count || 0) + ' 人'));
          if (g.remark) info.appendChild(el('div', 'gm-user-phone', '备注：' + g.remark));
          main.appendChild(av); main.appendChild(info);
          var btn = el('button', 'btn-mini', '管理');
          btn.type = 'button';
          btn.onclick = function () { gmLoadGroupDetail(g.group_id, g.name); };
          var chatBtn = el('button', 'btn-mini', '聊天');
          chatBtn.type = 'button';
          chatBtn.onclick = function () { gmOpenGroupChat(g.group_id, g.name, null); };
          card.appendChild(main); card.appendChild(btn); card.appendChild(chatBtn);
          box.appendChild(card);
        });
      })
      .catch(function (e) {
        var m = (e && (e.message || '')) || '';
        if (/GM_AUTH_FAIL/.test(m)) box.innerHTML = '<div class="gm-empty">口令已失效，请重新进入</div>';
        else box.innerHTML = '<div class="gm-empty">搜索失败：' + friendlyError(e) + '</div>';
      });
  }

  function gmLoadGroupDetail(gid, gname) {
    gmGroupCurrent = { gid: gid, name: gname };
    var box = $('gm-group-detail');
    box.hidden = false;
    box.innerHTML = '<div class="gm-loading">加载中…</div>';
    sb.rpc('gm_list_group_members', { p_pwd: gmPwd, p_group_id: gid })
      .then(function (r) {
        if (r.error) throw r.error;
        renderGmGroupDetail(gid, gname, r.data || []);
      })
      .catch(function (e) {
        var m = (e && (e.message || '')) || '';
        if (/GM_AUTH_FAIL/.test(m)) box.innerHTML = '<div class="gm-empty">口令已失效，请重新进入</div>';
        else box.innerHTML = '<div class="gm-empty">加载失败：' + friendlyError(e) + '</div>';
      });
  }

  function renderGmGroupDetail(gid, gname, members) {
    var box = $('gm-group-detail');
    box.innerHTML = '';

    var head = el('div', 'gm-detail-head');
    head.appendChild(el('div', 'gm-detail-name', (gname || '(未命名群)') + '  ·  ' + members.length + ' 人'));
    var delBtn = el('button', 'btn-danger', '解散群聊');
    delBtn.type = 'button';
    delBtn.onclick = function () { gmGmDissolveGroup(gid, gname); };
    head.appendChild(delBtn);
    var chatBtn = el('button', 'btn-mini', '聊天');
    chatBtn.type = 'button';
    chatBtn.onclick = function () { gmOpenGroupChat(gid, gname, null); };
    head.appendChild(chatBtn);
    box.appendChild(head);

    box.appendChild(el('div', 'gm-subtitle', '群成员（' + members.length + '）· 含在线状态'));
    if (!members.length) box.appendChild(el('div', 'gm-empty', '无成员'));
    members.forEach(function (m) {
      var row = el('div', 'gm-row');
      var main = el('div', 'gm-user-main');
      var av = el('div', 'avatar sm');
      av.textContent = initialOf(m.nickname || m.phone);
      av.style.background = colorOf(m.nickname || m.phone);
      var old = av.querySelector('.online-dot'); domRemove(old);
      var dot = el('span', 'online-dot');
      dot.classList.add(onlineFromIso(m.last_active) ? 'online' : 'offline');
      av.appendChild(dot);
      var info = el('div', 'gm-user-info');
      info.appendChild(el('div', 'gm-user-name', (m.nickname || '(无昵称)') + (m.is_owner ? '（群主）' : '')));
      info.appendChild(el('div', 'gm-user-phone', (m.phone || '') + ' · ' + onlineText(m.last_active)));
      main.appendChild(av); main.appendChild(info);
      row.appendChild(main);

      var acts = el('div', 'gm-row-acts');
      if (!m.is_owner) {
        var ownerBtn = el('button', 'btn-mini', '设为群主');
        ownerBtn.type = 'button';
        ownerBtn.onclick = function () { gmGmSetOwner(gid, m.user_id, m.nickname); };
        acts.appendChild(ownerBtn);
      }
      var rmBtn = el('button', 'btn-mini gm-danger', '移除');
      rmBtn.type = 'button';
      rmBtn.onclick = function () { gmGmRemoveMember(gid, m.user_id, m.nickname); };
      acts.appendChild(rmBtn);
      row.appendChild(acts);
      box.appendChild(row);
    });
  }

  function gmGmSetOwner(gid, uid, name) {
    if (!window.confirm('确认将群主转让给「' + (name || uid) + '」？原群主将降为普通成员。')) return;
    sb.rpc('gm_set_group_owner', { p_pwd: gmPwd, p_group_id: gid, p_new_owner_id: uid })
      .then(function (r) { if (r.error) throw r.error; toast('已转让群主'); gmLoadGroupDetail(gid, (gmGroupCurrent && gmGroupCurrent.name) || ''); })
      .catch(function (e) { toast('操作失败：' + friendlyError(e)); });
  }

  function gmGmRemoveMember(gid, uid, name) {
    if (!window.confirm('确认将「' + (name || uid) + '」移出该群？')) return;
    sb.rpc('gm_remove_group_member', { p_pwd: gmPwd, p_group_id: gid, p_user_id: uid })
      .then(function (r) { if (r.error) throw r.error; toast('已移除成员'); gmLoadGroupDetail(gid, (gmGroupCurrent && gmGroupCurrent.name) || ''); })
      .catch(function (e) { toast('操作失败：' + friendlyError(e)); });
  }

  function gmGmDissolveGroup(gid, gname) {
    if (!window.confirm('确认解散群聊「' + (gname || gid) + '」？该群所有成员与消息将一并删除。')) return;
    sb.rpc('gm_force_delete_group', { p_pwd: gmPwd, p_group_id: gid })
      .then(function (r) {
        if (r.error) throw r.error;
        toast('已解散群聊：' + (gname || ''));
        $('gm-group-detail').hidden = true;
        $('gm-group-detail').innerHTML = '';
        gmSearchGroups();
      })
      .catch(function (e) { toast('解散失败：' + friendlyError(e)); });
  }

  // ---------- GM 聊天记录查看器 ----------
  var gmChatReload = null;   // 当前会话重载函数（供「刷新」按钮复用）

  function gmOpenChat(title, loader) {
    gmChatReload = loader;
    $('gm-chat-title').textContent = title || '聊天记录';
    var body = $('gm-chat-body');
    body.innerHTML = '<div class="gm-empty">加载中…</div>';
    $('gm-chat-viewer').classList.add('open');
    loader();
  }

  function gmCloseChat() {
    $('gm-chat-viewer').classList.remove('open');
    gmChatReload = null;
  }

  // 用已有的 lightbox 看大图 / 播视频（lightbox 为全局已实现弹层，避免重复造轮子）
  function openGmMedia(url, isVid) {
    if (typeof openReportPreview === 'function') { openReportPreview(url, isVid); return; }
    var lb = $('lightbox'), im = $('lightbox-img'), vv = $('lightbox-video');
    if (!lb) return;
    if (isVid) { im.hidden = true; vv.hidden = false; vv.src = url; vv.play().catch(function () {}); }
    else { vv.hidden = true; im.hidden = false; im.src = url; }
    lb.classList.add('open');
  }

  // 渲染单条消息（GM 视角：不隐藏撤回/删除/违禁词，仅加标注）
  function renderGmMessage(m, ctx) {
    var out = !!(ctx && m.sender_id && m.sender_id === ctx.selfUid);
    var wrap = el('div', 'gm-msg ' + (out ? 'out' : 'in'));

    // 群聊显示发送者昵称
    if (ctx && ctx.showSender && m.sender_name) {
      wrap.appendChild(el('div', 'gm-msg-sender', m.sender_name || '成员'));
    }

    if (m.recalled) {
      // 撤回会清空正文，GM 也只能看到「已撤回」标记，但保留该条记录不被隐藏
      wrap.appendChild(el('div', 'gm-msg-recalled', '（已撤回，正文不可见）'));
    } else {
      var bubble;
      if (m.kind === 'text') {
        bubble = el('div', 'gm-msg-bubble', m.content || '');
      } else if (m.kind === 'image') {
        bubble = el('div', 'gm-msg-bubble gm-msg-media');
        var img = document.createElement('img');
        img.alt = m.file_name || '图片';
        bubble.appendChild(img);
        signedUrl(m.file_path).then(function (u) {
          if (!u) return;
          img.src = u;
          img.onclick = function () { openGmMedia(u, false); };
        });
      } else if (m.kind === 'video' || isVideoFile(m)) {
        bubble = el('div', 'gm-msg-bubble gm-msg-media');
        var vid = document.createElement('video');
        vid.controls = true; vid.preload = 'metadata'; vid.playsInline = true;
        bubble.appendChild(vid);
        signedUrl(m.file_path).then(function (u) {
          if (!u) return;
          vid.src = u;
          vid.onclick = function (e) { e.stopPropagation(); };
          bubble.onclick = function () { openGmMedia(u, true); };
        });
      } else {
        bubble = el('div', 'gm-msg-bubble');
        var a = document.createElement('a');
        a.className = 'gm-file-card';
        a.target = '_blank'; a.rel = 'noopener';
        var ext = (m.file_name || '').split('.').pop() || 'file';
        a.appendChild(el('div', 'gm-file-icon', ext.slice(0, 4)));
        var meta = el('div', 'gm-file-meta');
        meta.appendChild(el('div', 'gm-file-name', m.file_name || '文件'));
        meta.appendChild(el('div', 'gm-file-size', fmtSize(m.file_size)));
        a.appendChild(meta);
        bubble.appendChild(a);
        signedUrl(m.file_path).then(function (u) { if (u) { a.href = u; a.download = m.file_name || ''; } });
      }
      wrap.appendChild(bubble);
    }

    // 异常状态标注（被删除本端 / 命中违禁词）——GM 仍可看到正文，仅追加提示
    if (m.deleted_by && m.deleted_by.length) {
      wrap.appendChild(el('div', 'gm-chat-note warn', '已被 ' + m.deleted_by.length + ' 人删除（本端删除，GM 仍可见）'));
    }
    if (m.hidden_forbidden) {
      wrap.appendChild(el('div', 'gm-chat-note danger', '命中违禁词（已对普通用户隐藏，GM 仍可见）'));
    }

    wrap.appendChild(el('div', 'gm-msg-time', fmtTime(m.created_at)));
    return wrap;
  }

  function gmRenderChatList(rows, ctx) {
    var body = $('gm-chat-body');
    body.innerHTML = '';
    if (!rows || !rows.length) { body.appendChild(el('div', 'gm-empty', '暂无聊天记录')); return; }
    rows.forEach(function (m) {
      var node = renderGmMessage(m, ctx);
      if (node) body.appendChild(node);
    });
    body.scrollTop = body.scrollHeight;
  }

  // 群聊聊天记录：绕过本端删除 / 撤回 / 违禁词隐藏
  function gmOpenGroupChat(gid, gname, selfUid) {
    var ctx = { showSender: true, selfUid: selfUid || null };
    gmOpenChat((gname || '群聊') + ' · 聊天记录', function () {
      sb.rpc('gm_get_group_messages', { p_pwd: gmPwd, p_group_id: gid })
        .then(function (r) {
          if (r.error) throw r.error;
          gmRenderChatList(r.data || [], ctx);
        })
        .catch(function (e) {
          $('gm-chat-body').innerHTML = '<div class="gm-empty">加载失败：' + friendlyError(e) + '</div>';
        });
    });
  }

  // 两人私聊记录：绕过本端删除 / 撤回 / 违禁词隐藏
  function gmOpenDmChat(userA, userB, name) {
    var ctx = { showSender: false, selfUid: userA };
    gmOpenChat((name || '私聊') + ' · 聊天记录', function () {
      sb.rpc('gm_get_dm_messages', { p_pwd: gmPwd, p_user_a: userA, p_user_b: userB })
        .then(function (r) {
          if (r.error) throw r.error;
          gmRenderChatList(r.data || [], ctx);
        })
        .catch(function (e) {
          $('gm-chat-body').innerHTML = '<div class="gm-empty">加载失败：' + friendlyError(e) + '</div>';
        });
    });
  }

  // ---------- 称号管理（GM 后台） ----------
  function gmSwitchTab(tab) {
    state.gmCurrentTab = tab;
    var map = { users: 'gm-users', reports: 'gm-reports', userreports: 'gm-userreports', titles: 'gm-titles', groups: 'gm-groups', appeals: 'gm-appeals', feedback: 'gm-feedback', wordlog: 'gm-word-log' };
    ['users', 'reports', 'userreports', 'titles', 'groups', 'appeals', 'feedback', 'wordlog'].forEach(function (k) {
      var b = $('gm-tab-' + k); if (b) b.classList.toggle('active', k === tab);
      var p = $(map[k]); if (p) p.hidden = (k !== tab);
    });
    if (tab === 'titles') { stopGmPolling(); openTitleTab(); }
    else if (tab === 'reports') { openReportsTab(); startGmPolling(); }
    else if (tab === 'userreports') { openGmUserReportsTab(); startGmPolling(); }
    else if (tab === 'groups') { stopGmPolling(); openGmGroupsTab(); }
    else if (tab === 'appeals') { openGmAppealsTab(); startGmPolling(); }
    else if (tab === 'feedback') { openGmFeedbackTab(); startGmPolling(); }
    else if (tab === 'wordlog') { openGmWordLogTab(); startGmPolling(); }
    else { stopGmPolling(); }
  }

  // 自动刷新当前打开的 GM 看板（轮询 / 每日 00:00 兜底）
  function refreshGmCurrentTab(silent) {
    if (state.gmPanelOpen !== true) return;
    var tab = state.gmCurrentTab;
    if (tab === 'reports') openReportsTab(silent);
    else if (tab === 'userreports') openGmUserReportsTab(silent);
    else if (tab === 'wordlog') openGmWordLogTab(silent);
    else if (tab === 'appeals') openGmAppealsTab(silent);
    else if (tab === 'feedback') openGmFeedbackTab(silent);
  }

  // GM 看板轮询：每 5 秒静默刷新当前 tab（页面隐藏时跳过）
  function startGmPolling() {
    stopGmPolling();
    if (state.gmPanelOpen !== true) return;
    state.gmPollTimer = setInterval(function () {
      if (document.hidden) return;
      refreshGmCurrentTab(true);
    }, 5000);
  }

  function stopGmPolling() {
    if (state.gmPollTimer) { clearInterval(state.gmPollTimer); state.gmPollTimer = null; }
  }

  function scheduleDailyRefresh() {
    if (state.dailyTimer) { clearTimeout(state.dailyTimer); state.dailyTimer = null; }
    if (state.dailyInterval) { clearInterval(state.dailyInterval); state.dailyInterval = null; }
    var now = new Date();
    // 下一个自然日 00:00（today 24:00 = tomorrow 00:00）
    var next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 24, 0, 0, 0);
    var ms = next - now;
    if (ms < 1000) ms = 1000;
    state.dailyTimer = setTimeout(function () {
      refreshGmCurrentTab();
      state.dailyInterval = setInterval(refreshGmCurrentTab, 24 * 3600 * 1000);
    }, ms);
  }

  // 渲染单条违规上报卡片（GM 后台与「管理员」面板共用）
  // mode: 'gm' | 'admin' —— admin 模式额外带「禁言（最高 20 天）」操作
  function renderReportCard(rep, mode) {
    var card = el('div', 'gm-report');
    var head = el('div', 'gm-report-head');
    var name = el('div', 'gm-report-name', (rep.nickname || '(无昵称)') + '  ·  ' + (rep.phone || ''));
    if (mode === 'gm') {
      name.style.cursor = 'pointer';
      name.title = '点击查看该用户';
      name.onclick = function () { gmLoadDetail(rep.user_id, rep.nickname, rep.phone); };
    }
    var badge = el('div', 'gm-report-badge' + (rep.handled ? ' done' : ''), rep.handled ? '已处理' : '待处理');
    head.appendChild(name); head.appendChild(badge);
    card.appendChild(head);
    card.appendChild(el('div', 'gm-report-sub',
      '本周（' + rep.week_start + ' 起）触发违禁词 ' + rep.warn_count + ' 次 · 上报 ' + fmtTime(rep.reported_at)));

    // —— 明细：发送的信息 / 接收方 / 接收方近期是否触发违禁词 ——
    var content = rep.last_content || '（无内容记录）';
    card.appendChild(el('div', 'gm-report-line', '发送的信息：' + content));

    var peerTxt;
    if (!rep.last_peer_id) peerTxt = '（未知接收方）';
    else if (rep.last_peer_type === 'group') peerTxt = (rep.last_peer_name || '群聊') + '（群）';
    else peerTxt = (rep.last_peer_name || '用户') + (rep.last_peer_phone ? '（' + rep.last_peer_phone + '）' : '（用户）');
    card.appendChild(el('div', 'gm-report-line', '接收方：' + peerTxt));

    var recentTxt;
    if (rep.last_peer_type === 'group') recentTxt = '（群消息，不适用）';
    else if (rep.peer_recent_warn === true) recentTxt = '是（近 7 天 ' + (rep.peer_warn_count || 0) + ' 次）';
    else if (rep.peer_recent_warn === false) recentTxt = '否';
    else recentTxt = '未知';
    card.appendChild(el('div', 'gm-report-line', '接收方近期是否触发违禁词：' + recentTxt));

    // —— GM 模式：标记处理 / 撤销处理（翻转 forbidden_reports.handled）——
    //    admin 模式通过 set_content_hide 隐藏来表达「处理」，此处 GM 用专属 RPC 维护 handled 状态
    if (mode === 'gm') {
      var rActs = el('div', 'gm-report-acts');
      var rBtn = el('button', 'btn-mini' + (rep.handled ? ' gm-danger' : ''), rep.handled ? '撤销处理' : '标记处理');
      rBtn.type = 'button';
      rBtn.onclick = function () {
        sb.rpc('gm_resolve_report', { p_pwd: gmPwd, p_report_id: rep.id, p_handled: !rep.handled })
          .then(function (r) { if (r.error) throw r.error; rep.handled = !rep.handled; renderGmReports(); })
          .catch(function (e) { toast('操作失败：' + friendlyError(e)); });
      };
      rActs.appendChild(rBtn);
      card.appendChild(rActs);
    }

    // —— 管理员模式：禁言 / 不禁言（选择后全网隐藏）+ 忽略（仅自己隐藏）——
    if (mode === 'admin') {
      card.appendChild(buildMuteRow('forbidden_report', rep.id, rep.user_id));
      var acts = el('div', 'gm-report-acts');
      acts.appendChild(noMuteBtn('forbidden_report', rep.id));
      acts.appendChild(ignoreBtn('forbidden_report', rep.id));
      card.appendChild(acts);
    }

    return card;
  }

  // GM 后台「违规上报」列表（留存、可搜索、不可删除）
  function openReportsTab(silent) {
    var box = $('gm-report-list');
    if (box && !silent) box.innerHTML = '<div class="gm-loading">加载中…</div>';
    sb.rpc('gm_list_reports', { p_pwd: gmPwd })
      .then(function (r) {
        if (r.error) throw r.error;
        state.gmReportsAll = r.data || [];
        renderGmReports();
      })
      .catch(function (e) {
        var m = (e && (e.message || '')) || '';
        var box2 = $('gm-report-list');
        if (!box2) return;
        box2.innerHTML = /GM_AUTH_FAIL/.test(m)
          ? '<div class="gm-empty">口令已失效，请重新进入</div>'
          : '<div class="gm-empty">加载失败：' + friendlyError(e) + '</div>';
      });
  }

  function renderGmReports() {
    var box = $('gm-report-list');
    if (!box) return;
    var kw = ((($('gm-report-search') && $('gm-report-search').value) || '').trim().toLowerCase());
    var rows = state.gmReportsAll || [];
    if (kw) {
      rows = rows.filter(function (rep) {
        var fields = [rep.nickname, rep.phone, rep.last_content, rep.last_peer_name];
        return fields.some(function (f) { return (f || '').toLowerCase().indexOf(kw) >= 0; });
      });
    }
    box.innerHTML = '';
    if (!rows.length) { box.innerHTML = '<div class="gm-empty">' + (kw ? '无匹配结果' : '暂无违规上报') + '</div>'; return; }
    rows.forEach(function (rep) { box.appendChild(renderReportCard(rep, 'gm')); });
  }

  // ============================================================
  //  「管理员」称号体系：侧边栏「违禁接收」入口 + 无口令管理面板
  // ============================================================
  function refreshAdminStatus() {
    if (!state.uid) return Promise.resolve();
    // 这里直接查 user_titles（不依赖 get_profiles_titles 的新增列），
    // 因此即便 admin_dual_title / dev_title 两个迁移还没执行，
    // 「自己」的开发者/管理员徽标也能正常显示（他人的仍需新 SQL）。
    return sb.from('user_titles')
      .select('title_id, titles(id,name,frame_color,frame_style)')
      .eq('user_id', state.uid)
      .then(function (r) {
        if (r.error) return Promise.resolve();
        var rows = (r.data || []).map(function (x) { return x.titles; }).filter(Boolean);
        var names = rows.map(function (t) { return (t.name || '').trim(); }).filter(Boolean);
        state.ownedTitles = names;
        // 开发者拥有管理员全部权限与能力：开发者同样视为管理员（违禁接收入口/面板对开发者开放）
        state.isAdmin = names.indexOf('管理员') >= 0 || names.indexOf('开发者') >= 0;
        state.isDev = names.indexOf('开发者') >= 0;
        // 「管理员」称号专属标记（公告/撤销规则只针对「管理员」称号，不含纯开发者）
        state.hasAdminTitle = names.indexOf('管理员') >= 0;
        updateAdminCard();
        // 启动管理后台四大板块未读数轮询（tab 与侧边栏入口的数字提示）
        if (state.isAdmin) { startWordLogUnreadPoller(); loadAllUnread(); }
        else { stopWordLogUnreadPoller(); clearAllUnreadBadges(); }

        // 兜底回填自己的强制称号槽位，保证右上角一定能看到徽标
        function pick(n) {
          var hit = null;
          rows.forEach(function (t) { if (!hit && (t.name || '').trim() === n) hit = t; });
          return hit;
        }
        var adminRow = pick('管理员');
        var devRow   = pick('开发者');
        state.titlesMap = state.titlesMap || {};
        var slot = state.titlesMap[state.uid] || { primary: null, primary2: null, admin: null, dev: null };
        slot.admin = adminRow ? {
          titleId: adminRow.id,
          titleName: adminRow.name,
          frameColor: adminRow.frame_color || '#f5511e',
          frameStyle: adminRow.frame_style || 'solid'
        } : null;
        state.devTitleRow = devRow;
        // 隐藏开关只影响「展示」：隐藏时不填开发者槽位，
        // 权限仍由 state.isDev / 后端 is_admin_user() 判定，完全不受影响。
        slot.dev = (devRow && !state.hideDevTitle) ? {
          titleId: devRow.id,
          titleName: devRow.name,
          frameColor: devRow.frame_color || '#7c4dff',
          frameStyle: 'dev'
        } : null;
        // 同时清理可能错误戴在自选槽位的开发者称号，确保隐藏彻底
        if (state.hideDevTitle) {
          if (isDevSlot(slot.primary)) slot.primary = null;
          if (isDevSlot(slot.primary2)) slot.primary2 = null;
        }
        // 自选称号若已不在拥有列表中（例如触发违禁词被撤销），立即摘下并前移，
        // 否则徽标/头像框要等刷新页面才消失。
        var ownedIds = {};
        rows.forEach(function (t) { if (t && t.id) ownedIds[t.id] = 1; });
        var keep = [];
        [slot.primary, slot.primary2].forEach(function (x) {
          if (x && x.titleId && ownedIds[x.titleId]) keep.push(x);
        });
        slot.primary  = keep[0] || null;
        slot.primary2 = keep[1] || null;
        state.titlesMap[state.uid] = slot;
        // 记录强制称号的真实 id，后续 loadMyTitles 用 id 匹配更稳（避免名称隐藏字符问题）
        state.adminTitleId = adminRow ? adminRow.id : null;
        state.devTitleId   = devRow   ? devRow.id   : null;
        // 等 loadHideDevPref 确认完最新开关状态后再最终渲染，
        // 避免先用 loadProfile 里的旧值把徽标画出来再闪烁消失。
        return loadHideDevPref().then(function () {
          applySelfTitle();
          // 获得「管理员」称号后首次登录：显示管理员公告（被撤销后重新获得会再次提示）
          syncAdminAnnounceState();
        });
      })
      .catch(function () {});
  }

  // 读取「隐藏开发者称号」开关（后端列不存在时静默按「未隐藏」处理）
  function loadHideDevPref() {
    if (!state.uid || !state.isDev) return Promise.resolve();
    return sb.from('profiles')
      .select('hide_dev_title')
      .eq('id', state.uid)
      .limit(1)
      .then(function (r) {
        if (r.error || !r.data || !r.data.length) return;
        state.hideDevTitle = !!r.data[0].hide_dev_title;
        if (!state.devHiddenMap) state.devHiddenMap = {};
        state.devHiddenMap[state.uid] = state.hideDevTitle;
        //  always re-apply，避免其它流程先把 dev 槽位写错
        applyDevSlot();
      })
      .catch(function () {});
  }

  // 按当前隐藏开关重算自己的开发者展示槽位并即时重绘（不触碰任何权限字段）
  function applyDevSlot() {
    if (!state.uid) return;
    if (!state.devHiddenMap) state.devHiddenMap = {};
    state.devHiddenMap[state.uid] = !!state.hideDevTitle;
    state.titlesMap = state.titlesMap || {};
    var slot = state.titlesMap[state.uid] || { primary: null, primary2: null, admin: null, dev: null };
    var d = state.devTitleRow;
    slot.dev = (d && !state.hideDevTitle) ? {
      titleId: d.id,
      titleName: d.name,
      frameColor: d.frame_color || '#7c4dff',
      frameStyle: 'dev'
    } : null;
    // 同步清理自选槽位里的开发者称号，防止隐藏后仍通过自选槽展示
    if (state.hideDevTitle) {
      if (isDevSlot(slot.primary)) slot.primary = null;
      if (isDevSlot(slot.primary2)) slot.primary2 = null;
    }
    state.titlesMap[state.uid] = slot;
    applySelfTitle();
    if (typeof renderConversations === 'function') renderConversations();
  }

  // 开发者本人切换「隐藏称号」（管理员称号不提供此开关）
  function toggleHideDevTitle(hide) {
    sb.rpc('set_hide_dev_title', { p_hide: !!hide })
      .then(function (r) {
        if (r.error) throw r.error;
        state.hideDevTitle = !!hide;
        if (!state.devHiddenMap) state.devHiddenMap = {};
        state.devHiddenMap[state.uid] = state.hideDevTitle;
        applyDevSlot();
        toast(hide ? '已隐藏「开发者」称号，其他人将看不到（权限不变）'
                   : '已取消隐藏，「开发者」称号重新展示');
        loadMyTitles();
      })
      .catch(function (e) {
        var msg = (e && e.message === 'NOT_DEV') ? '你不是开发者' : friendlyError(e);
        toast('操作失败：' + msg);
      });
  }

  function updateAdminCard() {
    // 侧边栏「违禁接收」入口（搜索框上方），仅管理员 / 开发者可见
    var btn = $('admin-violation-open');
    if (btn) btn.hidden = !state.isAdmin;
  }

  // 统一的小红点渲染：n<=0 隐藏，>99 显示 99+
  function paintBadge(id, n) {
    var b = $(id);
    if (!b) return;
    if (!n || n <= 0) {
      b.textContent = '';
      b.classList.remove('show');
    } else {
      b.textContent = n > 99 ? '99+' : String(n);
      b.classList.add('show');
    }
  }

  /* ---------------------------------------------------------------------
     管理后台四大板块统一「未读 + 实时提示」模块
     key 同时用作 adminTabCurrent 的取值，便于「当前正打开该 tab 就自动刷新列表」
     --------------------------------------------------------------------- */
  var UNREAD_KINDS = [
    { key: 'wordlog',     badge: 'admin-tab-wordlog-badge',     table: 'word_warnings',
      count: 'admin_count_word_log_unread',    mark: 'admin_mark_word_log_read_all',    label: '违禁词记录' },
    { key: 'userreports', badge: 'admin-tab-userreports-badge', table: 'user_reports',
      count: 'admin_count_user_report_unread', mark: 'admin_mark_user_report_read_all', label: '用户举报' },
    { key: 'reports',     badge: 'admin-tab-reports-badge',     table: 'forbidden_reports',
      count: 'admin_count_report_unread',      mark: 'admin_mark_report_read_all',      label: '违规上报' },
    { key: 'appeals',     badge: 'admin-tab-appeals-badge',     table: 'mute_appeals',
      count: 'admin_count_appeal_unread',      mark: 'admin_mark_appeal_read_all',      label: '禁言申诉' }
  ];

  function unreadKind(key) {
    for (var i = 0; i < UNREAD_KINDS.length; i++) {
      if (UNREAD_KINDS[i].key === key) return UNREAD_KINDS[i];
    }
    return null;
  }

  function unreadKindByTable(tbl) {
    for (var i = 0; i < UNREAD_KINDS.length; i++) {
      if (UNREAD_KINDS[i].table === tbl) return UNREAD_KINDS[i];
    }
    return null;
  }

  // 侧边栏「违禁接收」蓝色入口：显示四大板块未读总数
  function updateSideViolationBadge() {
    if (!state.unreadMap) state.unreadMap = {};
    var total = 0;
    for (var i = 0; i < UNREAD_KINDS.length; i++) {
      total += (state.unreadMap[UNREAD_KINDS[i].key] || 0);
    }
    paintBadge('admin-violation-badge', total);
  }

  // 写入某板块未读数：更新 tab 红点 + 侧边栏总数
  function paintUnread(key, n) {
    var k = unreadKind(key);
    if (!k) return;
    if (!state.unreadMap) state.unreadMap = {};
    state.unreadMap[key] = n || 0;
    paintBadge(k.badge, n);
    updateSideViolationBadge();
  }

  /* 未读数增长即提示：realtime 在老 WebView 上易丢事件，这里由「未读计数变大」统一驱动 toast，
     realtime 事件只负责立刻触发一次计数刷新，避免两条重复提示。
     首次拉取只建立基线（prev 为 null），不提示。 */
  function noticeUnreadGrow(key, n, label) {
    if (!state.seenUnread) state.seenUnread = {};
    var prev = state.seenUnread[key];
    state.seenUnread[key] = n;
    if (prev === null || prev === undefined) return;
    if (n > prev) toast('收到 ' + (n - prev) + ' 条新的' + label);
  }

  /* 后端 SQL 未执行时，RPC 会报 PGRST202「找不到函数」。
     以前这里静默吞掉，导致「明明没生效却毫无线索」。改为整场会话只提示一次。 */
  function warnUnreadRpcMissing(e) {
    var m = (e && (e.message || e.code || '')) || '';
    if (!/PGRST202|Could not find the function|does not exist|schema cache/i.test(String(m))) return;
    if (state.unreadRpcWarned) return;
    state.unreadRpcWarned = true;
    toast('管理通知功能未启用：请在 Supabase 执行 20260804_admin_unread_all.sql');
  }

  // 拉取某板块未读数
  function loadUnread(key) {
    var k = unreadKind(key);
    if (!k || !state.isAdmin) return Promise.resolve(0);
    return Promise.resolve(sb.rpc(k.count))
      .then(function (r) {
        if (r.error) throw r.error;
        var n = (r.data === null || r.data === undefined) ? 0 : Number(r.data);
        noticeUnreadGrow(key, n, k.label);
        paintUnread(key, n);
        return n;
      })
      .catch(function (e) {
        warnUnreadRpcMissing(e);
        paintUnread(key, 0);
        return 0;
      });
  }

  function loadAllUnread() {
    if (!state.isAdmin) return;
    for (var i = 0; i < UNREAD_KINDS.length; i++) loadUnread(UNREAD_KINDS[i].key);
  }

  // 某板块全部标为已读
  function markUnreadRead(key) {
    var k = unreadKind(key);
    if (!k || !state.isAdmin) return Promise.resolve();
    if (!state.seenUnread) state.seenUnread = {};
    state.seenUnread[key] = 0;
    paintUnread(key, 0);
    return Promise.resolve(sb.rpc(k.mark))
      .then(function (r) { if (r.error) throw r.error; paintUnread(key, 0); })
      .catch(function () { paintUnread(key, 0); });
  }

  // 按 tab key 重新拉取列表内容（用于「停留在该 tab 时自动出现新记录」）
  function refreshTabList(key) {
    if (key === 'wordlog')     return refreshWordLogList();
    if (key === 'userreports') return refreshUserReportList();
    if (key === 'reports')     return refreshAdminReportList();
    if (key === 'appeals')     return refreshAdminAppealList();
    return Promise.resolve();
  }

  /* 轮询兜底：老 WebView 的 WebSocket 容易静默断开，单靠 realtime 不可靠。
     8 秒一轮，四个板块全部刷新计数；正在查看的 tab 顺带刷新列表并标已读。 */
  function startWordLogUnreadPoller() {
    if (state.wordLogUnreadTimer) return;
    // 仅每 8 秒刷新未读徽章计数；列表内容一律由用户点「刷新」按钮（或切 tab）触发，不做自动刷新
    state.wordLogUnreadTimer = setInterval(function () {
      if (!state.isAdmin) return;
      for (var i = 0; i < UNREAD_KINDS.length; i++) {
        (function (key) {
          loadUnread(key);
        })(UNREAD_KINDS[i].key);
      }
    }, 8000);
  }

  function stopWordLogUnreadPoller() {
    if (state.wordLogUnreadTimer) {
      clearInterval(state.wordLogUnreadTimer);
      state.wordLogUnreadTimer = null;
    }
  }

  function clearAllUnreadBadges() {
    for (var i = 0; i < UNREAD_KINDS.length; i++) paintUnread(UNREAD_KINDS[i].key, 0);
  }

  /* 管理后台四大板块的实时 INSERT 统一处理。
     只负责「立刻刷新一次未读计数」，toast 由 loadUnread 的未读增量逻辑统一发出，
     避免 realtime 与轮询各弹一次造成重复提示。 */
  function onAdminFeedInsert(payload) {
    if (!state.isAdmin) return;
    if (!payload || !payload.new) return;
    var k = unreadKindByTable(payload.table);
    if (!k) return;
    loadUnread(k.key);   // 仅更新未读徽章；列表不自动刷新，需用户点「刷新」按钮
  }

  /* 违禁词记录被清空（DELETE）后，GM 后台与管理员面板若正打开该 tab，自动刷新列表。
     清空会一次性删除多条，用 400ms 节流避免高频重拉；GM 后台同时清空搜索框，
     让用户直接看到「暂无违禁词检测记录」而非「无匹配结果」。 */
  function onWordLogDelete() {
    if (!state.isAdmin) return;
    if (state.gmPanelOpen && state.gmCurrentTab === 'wordlog') {
      var s = $('gm-word-log-search'); if (s) s.value = '';
      if (state.wordLogDeleteTimer) clearTimeout(state.wordLogDeleteTimer);
      state.wordLogDeleteTimer = setTimeout(function () {
        state.wordLogDeleteTimer = null;
        openGmWordLogTab();
      }, 400);
    }
    if (state.adminPanelOpen && adminTabCurrent === 'wordlog') {
      if (state.wordLogDeleteTimer) clearTimeout(state.wordLogDeleteTimer);
      state.wordLogDeleteTimer = setTimeout(function () {
        state.wordLogDeleteTimer = null;
        refreshWordLogList();
      }, 400);
    }
  }

  // 兼容旧调用点
  function loadWordLogUnread()    { return loadUnread('wordlog'); }
  function markWordLogReadAll()   { return markUnreadRead('wordlog'); }
  function loadUserReportUnread() { return loadUnread('userreports'); }
  function markUserReportReadAll(){ return markUnreadRead('userreports'); }

  // 管理员称号「首次登录」公告：
  // 用 localStorage 记录迁移状态，仅在「从非管理员变为管理员」的那次登录显示一次；
  // 若称号被撤销后重新获得，会再次提示。纯开发者（无管理员称号）不触发。
  function syncAdminAnnounceState() {
    if (!state.uid) return;
    var KEY = 'admin_announce_' + state.uid;
    try {
      if (state.hasAdminTitle) {
        var prev = localStorage.getItem(KEY);
        if (prev !== '1') showAdminAnnouncement();
        localStorage.setItem(KEY, '1');
      } else {
        localStorage.setItem(KEY, '0');
      }
    } catch (e) {}
  }

  function showAdminAnnouncement() {
    showModal('admin-announce-modal');
  }

  // 权限被撤销（GM 撤回「管理员」称号）时：隐藏卡片并提示
  function onAdminRevoked() {
    state.isAdmin = false;
    updateAdminCard();
    stopWordLogUnreadPoller();
    clearAllUnreadBadges();
    hideModal('admin-panel');
    toast('您的管理员权限已被撤销');
  }

  var adminTabCurrent = 'reports';

  // 收集某类内容的隐藏状态：global = 全网隐藏；my = 当前用户本人忽略
  function loadHideSets(type) {
    return sb.rpc('list_content_hides', { p_target_type: type })
      .then(function (r) {
        var rows = (r && r.data) || [];
        var global = {}, my = {};
        rows.forEach(function (h) {
          var info = { kind: h.hide_kind, created_at: h.created_at };
          if (h.hide_kind === 'global') global[h.target_id] = info;
          else if (h.hide_kind === 'ignore' && h.admin_uid === state.uid) my[h.target_id] = info;
        });
        return { global: global, my: my };
      })
      .catch(function () { return { global: {}, my: {} }; });
  }

  // 判断某条隐藏记录的撤销窗口是否已过期（10 分钟）
  function isUndoExpired(createdAt) {
    if (!createdAt) return true;
    var t = new Date(createdAt).getTime();
    if (!t || isNaN(t)) return true;
    return (Date.now() - t) > 10 * 60 * 1000;
  }

  function rerenderCurrentAdminTab() {
    if (adminTabCurrent === 'reports') openAdminReports();
    else if (adminTabCurrent === 'wordlog') openAdminWordLog();
    else if (adminTabCurrent === 'userreports') openUserReports();
    else if (adminTabCurrent === 'appeals') openAdminAppeals();
  }

  // 管理员「违禁接收」面板：列表不自动轮询，由用户点击「刷新」按钮手动刷新。

  // 隐藏后的占位行：内容本身不显示，仅留恢复入口；撤销仅在 10 分钟内有效
  function renderHiddenRow(type, id, kind, createdAt) {
    var row = el('div', 'gm-hidden-row');
    row.appendChild(el('span', 'gm-hidden-text',
      kind === 'global' ? '已处理隐藏（全员不可见）' : '已忽略（仅你自己不可见）'));
    if (isUndoExpired(createdAt)) {
      row.appendChild(el('span', 'gm-hidden-expired', '已超 10 分钟，不可撤销'));
    } else {
      var undo = el('button', 'btn-mini', '撤销');
      undo.type = 'button';
      undo.onclick = function () {
        sb.rpc('clear_content_hide', { p_target_type: type, p_target_id: id, p_kind: kind })
          .then(function (r) { if (r.error) throw r.error; rerenderCurrentAdminTab(); })
          .catch(function (e) {
            var m = (e && (e.message || '')) || '';
            if (/UNDO_WINDOW_EXPIRED/.test(m)) toast('已超过 10 分钟撤销窗口');
            else toast('撤销失败：' + friendlyError(e));
          });
      };
      row.appendChild(undo);
    }
    return row;
  }

  // 禁言操作行（天/时/分 + 禁言 + 解除禁言）；禁言后全网隐藏
  // content：被举报的消息内容（仅 type==='user_report' 时传入），禁言后同时登记到违禁词库与违禁词记录
  // reportType：举报类型（message/image/video/nickname/other 等）；仅 message 类型才写入违禁词库
  function buildMuteRow(type, id, offenderUid, content, reportType) {
    var muteRow = el('div', 'gm-mute-row');
    var durLabel = el('span', 'gm-mute-label', '禁言：');
    var inpD = el('input', 'gm-dur-input'); inpD.type = 'number'; inpD.min = '0'; inpD.max = '20'; inpD.value = '1'; inpD.placeholder = '天';
    var inpH = el('input', 'gm-dur-input'); inpH.type = 'number'; inpH.min = '0'; inpH.max = '23'; inpH.value = '0'; inpH.placeholder = '时';
    var inpM = el('input', 'gm-dur-input'); inpM.type = 'number'; inpM.min = '0'; inpM.max = '59'; inpM.value = '0'; inpM.placeholder = '分';
    var muteBtn = el('button', 'btn-mini', '禁言');
    muteBtn.type = 'button';
    muteBtn.onclick = function () {
      var d = parseInt(inpD.value, 10) || 0, h = parseInt(inpH.value, 10) || 0, m = parseInt(inpM.value, 10) || 0;
      var total = d * 1440 + h * 60 + m;
      if (total < 1) { toast('请至少填写 1 分钟'); return; }
      if (total > 28800) { toast('管理员禁言上限为 20 天'); return; }
      sb.rpc('admin_mute_user', { p_user_id: offenderUid, p_days: d, p_hours: h, p_minutes: m })
        .then(function (r) { if (r.error) throw r.error; return sb.rpc('set_content_hide', { p_target_type: type, p_target_id: id, p_kind: 'global' }); })
        .then(function () {
          // 举报禁言联动：仅用户举报-文字消息才写入违禁词库 + 违禁词记录
          if (type === 'user_report' && content && reportType === 'message') {
            // target_ref 格式为「纯内容  (时间 · 发送者)」，去掉尾部 meta，只取纯消息内容
            var word = (content || '').trim().replace(/\s+\([^)]*\)\s*$/, '');
            if (!word) return;
            return Promise.resolve(sb.rpc('admin_add_forbidden_word', { p_word: word, p_note: '来自举报禁言' }))
              .catch(function () { /* 词库已存在则忽略 */ })
              .then(function () {
                return Promise.resolve(sb.rpc('admin_add_word_warning', { p_user_id: offenderUid, p_word: word, p_content: content, p_peer_id: null }));
              })
              .catch(function () { /* 后端 RPC 未部署时不影响禁言主流程 */ })
              .then(function () { loadForbiddenWords(); }); // 立即刷新客户端词库缓存，使新词即时生效
          }
        })
        .then(function () { toast('已对该用户禁言 ' + muteLenText(d, h, m) + '，并隐藏该内容、加入违禁词'); rerenderCurrentAdminTab(); })
        .catch(function (e) { var msg = (e && (e.message || '')) || ''; if (/ADMIN_FORBIDDEN/.test(msg)) onAdminRevoked(); else toast('禁言失败：' + friendlyError(e)); });
    };
    var unmuteBtn = el('button', 'btn-mini gm-danger', '解除禁言');
    unmuteBtn.type = 'button';
    unmuteBtn.onclick = function () {
      sb.rpc('admin_unmute_user', { p_user_id: offenderUid })
        .then(function (r) { if (r.error) throw r.error; toast('已解除禁言'); rerenderCurrentAdminTab(); })
        .catch(function (e) { var m2 = (e && (e.message || '')) || ''; if (/ADMIN_FORBIDDEN/.test(m2)) onAdminRevoked(); else toast('操作失败：' + friendlyError(e)); });
    };
    muteRow.appendChild(durLabel); muteRow.appendChild(inpD); muteRow.appendChild(inpH); muteRow.appendChild(inpM); muteRow.appendChild(muteBtn); muteRow.appendChild(unmuteBtn);
    return muteRow;
  }

  function ignoreBtn(type, id) {
    var b = el('button', 'btn-mini', '忽略');
    b.type = 'button';
    b.onclick = function () {
      sb.rpc('set_content_hide', { p_target_type: type, p_target_id: id, p_kind: 'ignore' })
        .then(function (r) { if (r.error) throw r.error; toast('已忽略，仅你自己不再显示'); rerenderCurrentAdminTab(); })
        .catch(function (e) { toast('操作失败：' + friendlyError(e)); });
    };
    return b;
  }

  function noMuteBtn(type, id) {
    var b = el('button', 'btn-mini gm-danger', '不禁言');
    b.type = 'button';
    b.onclick = function () {
      sb.rpc('set_content_hide', { p_target_type: type, p_target_id: id, p_kind: 'global' })
        .then(function (r) { if (r.error) throw r.error; toast('已标记并不再显示'); rerenderCurrentAdminTab(); })
        .catch(function (e) { toast('操作失败：' + friendlyError(e)); });
    };
    return b;
  }

  function openAdminPanel() {
    // 进入前再校验一次权限（GM 可能已撤回称号）
    sb.rpc('is_admin_user')
      .then(function (r) {
        var ok = r && !r.error && r.data === true;
        if (!ok) { onAdminRevoked(); return; }
        state.isAdmin = true;
        updateAdminCard();
        startWordLogUnreadPoller();
        state.adminPanelOpen = true;
        showModal('admin-panel');
        $('admin-report-list').innerHTML = '<div class="gm-empty">加载中…</div>';
        openAdminReports();
        loadAllUnread();
      })
      .catch(function () { toast('权限校验失败，请重试'); });
  }

  function refreshAdminReportList(silent) {
    var box = $('admin-report-list');
    if (!box) return Promise.resolve();
    if (!silent) box.innerHTML = '<div class="gm-empty">加载中…</div>';
    return Promise.resolve(sb.rpc('admin_list_reports'))
      .then(function (r) {
        if (r.error) throw r.error;
        var rows = r.data || [];
        return loadHideSets('forbidden_report').then(function (sets) {
          box.innerHTML = '';
          if (!rows.length) { box.innerHTML = '<div class="gm-empty">暂无违规上报</div>'; return; }
          rows.forEach(function (rep) {
            var hideInfo = sets.global[rep.id] || sets.my[rep.id] || null;
            var hidden = hideInfo ? hideInfo.kind : null;
            // 方案一：global 隐藏超过 10 分钟后，管理列表不再显示该占位行（记录仍保留，内容仍隐藏）
            // ignore（个人忽略/删除）直接不显示占位，无需撤销
            if (hidden === 'ignore') return;
            if (hidden === 'global' && isUndoExpired(hideInfo.created_at)) return;
            if (hidden === 'global') box.appendChild(renderHiddenRow('forbidden_report', rep.id, hidden, hideInfo.created_at));
            else box.appendChild(renderReportCard(rep, 'admin'));
          });
        });
      })
      .catch(function (e) {
        var m = (e && (e.message || '')) || '';
        if (/ADMIN_FORBIDDEN/.test(m)) { onAdminRevoked(); return; }
        if (silent) return;
        box.innerHTML = '<div class="gm-empty">加载失败：' + friendlyError(e) + '</div>';
      });
  }

  function openAdminReports() {
    adminTabCurrent = 'reports';
    markUnreadRead('reports');
    return refreshAdminReportList();
  }

  // 用户手动举报（昵称/信息/视频/图片）→ 管理员 / 开发者管理页展示
  function refreshUserReportList(silent) {
    var box = $('admin-userreport-list');
    if (!box) return Promise.resolve();
    if (!silent) box.innerHTML = '<div class="gm-empty">加载中…</div>';
    return Promise.resolve(sb.rpc('list_user_reports'))
      .then(function (r) {
        if (r.error) throw r.error;
        var rows = r.data || [];
        return loadHideSets('user_report').then(function (sets) {
          box.innerHTML = '';
          if (!rows.length) { box.innerHTML = '<div class="gm-empty">暂无用户举报</div>'; var saE = $('admin-ur-selectall'); if (saE) saE.checked = false; updateUrCount(); return; }
          rows.forEach(function (rep) {
            var hideInfo = sets.global[rep.id] || sets.my[rep.id] || null;
            var hidden = hideInfo ? hideInfo.kind : null;
            // 方案一：global 隐藏超过 10 分钟后，管理列表不再显示该占位行（记录仍保留，内容仍隐藏）
            // ignore（个人忽略/删除）直接不显示占位，无需撤销
            if (hidden === 'ignore') return;
            if (hidden === 'global' && isUndoExpired(hideInfo.created_at)) return;
            if (hidden === 'global') box.appendChild(renderHiddenRow('user_report', rep.id, hidden, hideInfo.created_at));
            else box.appendChild(renderUserReportCard(rep));
          });
          var saU = $('admin-ur-selectall'); if (saU) saU.checked = false;
          updateUrCount();
        });
      })
      .catch(function (e) {
        var m = (e && (e.message || '')) || '';
        if (/ADMIN_FORBIDDEN/.test(m)) { onAdminRevoked(); return; }
        if (silent) return;
        box.innerHTML = '<div class="gm-empty">加载失败：' + friendlyError(e) + '</div>';
      });
  }

  function openUserReports() {
    adminTabCurrent = 'userreports';
    markUserReportReadAll();
    refreshUserReportList();
  }

  function renderUserReportCard(rep) {
    // 本人被举报：管理员不可审理自己的内容（后端 admin_mute_user 也会兜底拒绝）
    var isSelfReport = (rep.reported_kind === 'user' && rep.reported_id && rep.reported_id === state.uid);
    var card = el('div', 'gm-report');
    // 多选勾选框（批量禁言 / 不禁言 / 删除用）
    var selRow = el('div', 'wl-check-row');
    var cb = el('input');
    cb.type = 'checkbox';
    cb.className = 'ur-check';
    cb.setAttribute('data-id', rep.id || '');
    if (rep.reported_kind === 'user' && rep.reported_id) cb.setAttribute('data-uid', rep.reported_id);
    cb.title = '选择此举报';
    selRow.appendChild(cb);
    if (!isSelfReport) card.appendChild(selRow);
    var head = el('div', 'gm-report-head');
    var name = el('div', 'gm-report-name',
      (rep.reporter_nickname || '(匿名)') + ' 举报 ' + (rep.reported_name || (rep.reported_kind === 'group' ? '群聊' : '用户')));
    var badge = el('div', 'gm-report-badge' + (rep.status === 'handled' ? ' done' : ''),
      rep.status === 'handled' ? '已处理' : '待处理');
    head.appendChild(name); head.appendChild(badge);
    card.appendChild(head);

    var typeTxt = { nickname: '昵称', message: '信息', video: '视频', image: '图片', other: '其他' }[rep.report_type] || rep.report_type;
    card.appendChild(el('div', 'gm-report-sub',
      '类型：' + typeTxt + ' · 提交时间：' + (rep.created_at ? rep.created_at.replace('T', ' ').slice(0, 16) : '—')));

    if (rep.reporter_phone) card.appendChild(el('div', 'gm-report-sub', '举报人手机号：' + rep.reporter_phone));
    if (rep.target_ref)   card.appendChild(el('div', 'gm-report-line', '被举报内容：' + rep.target_ref));
    if (rep.detail)       card.appendChild(el('div', 'gm-report-line', '补充说明：' + rep.detail));

    // 任何带 file_path 的举报（图片/视频/信息类型皆可能携带）都渲染缩略图，点击大图预览（复用 lightbox 全屏框）
    if (rep.file_path) {
      var isVid = rep.report_type === 'video' || /\.(mp4|webm|mov|ogg|m4v)$/i.test(rep.file_path || '');
      var media = el('div', 'gm-report-media');
      var thumb = document.createElement(isVid ? 'video' : 'img');
      if (isVid) { thumb.controls = true; thumb.preload = 'metadata'; thumb.playsInline = true; }
      else { thumb.alt = '举报图片'; thumb.loading = 'lazy'; }
      thumb.className = 'report-thumb';
      media.appendChild(thumb);
      card.appendChild(media);
      signedUrl(rep.file_path).then(function (u) {
        if (!u) return;
        if (isVid) {
          thumb.src = u;
          thumb.onclick = function (e) { e.stopPropagation(); openReportPreview(u, true); };
        } else {
          thumb.src = u;
          thumb.onclick = function () { openReportPreview(u, false); };
        }
      });
    }

    // 本人被举报：管理员不可审理自己的内容，直接结束（不渲染处置按钮）
    if (isSelfReport) {
      card.appendChild(el('div', 'gm-report-note', '本人被举报，无法审理（需由其他管理员 / 开发者处理）'));
      return card;
    }
    // —— 处置：禁言（全网隐藏）/ 不禁言（全网隐藏）/ 忽略（仅自己隐藏）——
    // 说明：原卡片上的「标记处理 / 撤销处理」单按钮已移除（v163），统一由批量栏的「批量不禁言」完成标记处理，
    //       单个举报如需处置走下方禁言 / 不禁言 / 忽略按钮。
    card.appendChild(buildMuteRow('user_report', rep.id, rep.reported_id, rep.target_ref, rep.report_type));
    var acts = el('div', 'gm-report-acts');
    acts.appendChild(noMuteBtn('user_report', rep.id));
    acts.appendChild(ignoreBtn('user_report', rep.id));
    card.appendChild(acts);
    return card;
  }

  // 管理员面板：违禁词记录（任意检测，不限于好友）
  // 只刷新「违禁词记录」列表内容（不含标已读逻辑），供打开 tab 与轮询实时刷新共用
  function refreshWordLogList(silent) {
    var box = $('admin-word-log-list');
    if (!box) return Promise.resolve();
    if (!silent) box.innerHTML = '<div class="gm-loading">加载中…</div>';
    return Promise.resolve(sb.rpc('admin_list_word_log'))
      .then(function (r) {
        if (r.error) throw r.error;
        var rows = r.data || [];
        return loadHideSets('word_warning').then(function (sets) {
          box.innerHTML = '';
          if (!rows.length) { box.innerHTML = '<div class="gm-empty">暂无违禁词检测记录</div>'; return; }
          var CAP = 100;
          var shown = 0;
          rows.forEach(function (w) {
            if (shown >= CAP) return;
            var hideInfo = sets.global[w.id] || sets.my[w.id] || null;
            var hidden = hideInfo ? hideInfo.kind : null;
            // 方案一：global 隐藏超过 10 分钟后，管理列表不再显示该占位行（记录仍保留，内容仍隐藏）
            // ignore（个人忽略/删除）直接不显示占位，无需撤销
            if (hidden === 'ignore') return;
            if (hidden === 'global' && isUndoExpired(hideInfo.created_at)) return;
            if (hidden === 'global') box.appendChild(renderHiddenRow('word_warning', w.id, hidden, hideInfo.created_at));
            else box.appendChild(renderWordLogCard(w, 'admin'));
            shown++;
          });
          if (shown === 0) {
            box.innerHTML = '<div class="gm-empty">暂无违禁词检测记录</div>';
          } else if (rows.length > CAP) {
            box.appendChild(el('div', 'gm-empty', '仅显示最近 ' + CAP + ' 条（共 ' + rows.length + ' 条）'));
          }
          var saA = $('admin-wl-selectall'); if (saA) saA.checked = false;
          updateWlCount('admin');
        });
      })
      .catch(function (e) {
        var m = (e && (e.message || '')) || '';
        if (/ADMIN_FORBIDDEN/.test(m)) { onAdminRevoked(); return; }
        if (silent) return;
        box.innerHTML = '<div class="gm-empty">暂无违禁词检测记录</div>';
      });
  }

  function openAdminWordLog() {
    adminTabCurrent = 'wordlog';
    // 打开 tab 即视为已读，先清零数字提示再拉数据
    markWordLogReadAll();
    return refreshWordLogList();
  }

  // 管理员面板：禁言申诉列表（查看 + 通过/驳回）
  function refreshAdminAppealList(silent) {
    var box = $('admin-appeal-list');
    if (!box) return Promise.resolve();
    if (!silent && !state.adminAppealsAll) box.innerHTML = '<div class="gm-loading">加载中…</div>';
    return Promise.resolve(sb.rpc('admin_list_mute_appeals'))
      .then(function (r) {
        if (r.error) throw r.error;
        state.adminAppealsAll = r.data || [];
        renderAdminAppeals();
      })
      .catch(function (e) {
        var m = (e && (e.message || '')) || '';
        if (/ADMIN_FORBIDDEN/.test(m)) { onAdminRevoked(); return; }
        box.innerHTML = '<div class="gm-empty">加载失败：' + friendlyError(e) + '</div>';
      });
  }

  function openAdminAppeals() {
    adminTabCurrent = 'appeals';
    markUnreadRead('appeals');
    return refreshAdminAppealList();
  }

  function renderAdminAppeals() {
    var box = $('admin-appeal-list');
    if (!box) return;
    var kw = ((($('admin-appeal-search') && $('admin-appeal-search').value) || '').trim().toLowerCase());
    var rows = state.adminAppealsAll || [];
    if (kw) {
      rows = rows.filter(function (a) {
        var n = (a.nickname || '').toLowerCase();
        var p = (a.phone || '').toLowerCase();
        return n.indexOf(kw) >= 0 || p.indexOf(kw) >= 0;
      });
    }
    // 普通管理员视图：已处理（approved/rejected）超过 10 分钟自动清空；GM 后台保留全部
    rows = rows.filter(function (a) {
      if (a.status === 'pending') return true;
      return !isUndoExpired(a.reviewed_at);
    });
    box.innerHTML = '';
    if (!rows.length) { box.innerHTML = '<div class="gm-empty">' + (kw ? '无匹配结果' : '暂无禁言申诉') + '</div>'; return; }
    rows.forEach(function (a) { box.appendChild(buildAppealCard(a, 'admin')); });
  }

  function buildAppealCard(a, mode) {
    var card = el('div', 'gm-report');
    var head = el('div', 'gm-report-head');
    var name = el('div', 'gm-report-name', (a.nickname || '(无昵称)') + ' · ' + (a.phone || '—'));
    head.appendChild(name);
    var badge = el('div', 'gm-report-badge' + (a.status === 'pending' ? '' : ' done'),
      a.status === 'pending' ? '待处理' : (a.status === 'approved' ? '已通过' : '已驳回'));
    head.appendChild(badge);
    card.appendChild(head);
    card.appendChild(el('div', 'gm-report-sub', '提交时间：' + (a.created_at ? a.created_at.replace('T', ' ').slice(0, 16) : '—')));
    card.appendChild(el('div', 'gm-report-line', '申诉理由：' + (a.reason || '')));

    var isSelfAppeal = (mode === 'admin' && a.user_id && a.user_id === state.uid);
    if (a.status === 'pending') {
      if (isSelfAppeal) {
        card.appendChild(el('div', 'gm-report-note', '本人申诉，无法审核（需由其他管理员 / 开发者处理）'));
      } else {
        // 目标为管理员、且当前审核人不是开发者时：仅能驳回，不能解禁
        var devOnlyTarget = (mode === 'admin' && !state.isDev && a.is_admin);
        var acts = el('div', 'gm-row-acts');
        var ok = el('button', 'btn-mini', '通过并解禁'); ok.type = 'button';
        if (devOnlyTarget) {
          ok.disabled = true;
          ok.title = '该用户为管理员，仅开发者可解除其禁言';
        }
        ok.onclick = function () {
          if (mode === 'gm') gmReviewAppeal(a.id, 'approve', a.nickname);
          else adminReviewAppeal(a.id, 'approve', a.nickname);
        };
        var no = el('button', 'btn-mini gm-danger', '驳回'); no.type = 'button';
        no.onclick = function () {
          if (mode === 'gm') gmReviewAppeal(a.id, 'reject', a.nickname);
          else adminReviewAppeal(a.id, 'reject', a.nickname);
        };
        acts.appendChild(ok); acts.appendChild(no);
        card.appendChild(acts);
        if (devOnlyTarget) {
          card.appendChild(el('div', 'gm-report-note', '该用户为管理员，仅开发者可解除其禁言（你可驳回，但不能解禁）'));
        }
      }
    } else if (mode === 'admin' && !isUndoExpired(a.reviewed_at)) {
      // 普通管理员：处理完成后 10 分钟内可撤销审核决定（GM 后台始终可见全部，不提供撤销）
      var undoActs = el('div', 'gm-row-acts');
      var undo = el('button', 'btn-mini', '撤销'); undo.type = 'button';
      undo.onclick = function () { adminUndoAppealReview(a.id, a.nickname); };
      undoActs.appendChild(undo);
      card.appendChild(undoActs);
    }
    return card;
  }

  function adminReviewAppeal(id, action, name) {
    var verb = action === 'approve' ? '通过并解禁' : '驳回';
    if (!window.confirm('确认' + verb + '「' + (name || id) + '」的申诉？')) return;
    sb.rpc('admin_review_mute_appeal', { p_id: id, p_action: action })
      .then(function (r) {
        if (r.error) throw r.error;
        toast('已' + (action === 'approve' ? '通过，已解除禁言' : '驳回'));
        openAdminAppeals();
      })
      .catch(function (e) {
        var m = (e && (e.message || '')) || '';
        if (/ADMIN_FORBIDDEN/.test(m)) { onAdminRevoked(); } else { toast('操作失败：' + friendlyError(e)); }
      });
  }

  function adminUndoAppealReview(id, name) {
    if (!window.confirm('确认撤销对「' + (name || id) + '」申诉的审核决定？撤销后该申诉恢复为待处理状态。')) return;
    sb.rpc('admin_undo_mute_appeal_review', { p_id: id })
      .then(function (r) {
        if (r.error) throw r.error;
        toast('已撤销，申诉恢复为待处理');
        openAdminAppeals();
      })
      .catch(function (e) {
        var m = (e && (e.message || '')) || '';
        if (/ADMIN_FORBIDDEN/.test(m)) { onAdminRevoked(); }
        else if (/UNDO_WINDOW_EXPIRED/.test(m)) { toast('已超过 10 分钟撤销窗口'); }
        else { toast('撤销失败：' + friendlyError(e)); }
      });
  }

  function openTitleTab() {
    var box = $('gm-title-list');
    box.innerHTML = '<div class="gm-empty">加载中…</div>';
    sb.rpc('gm_list_titles', { p_pwd: gmPwd })
      .then(function (r) {
        if (r.error) throw r.error;
        renderGmTitles(r.data || []);
      })
      .catch(function (e) {
        var m = (e && (e.message || '')) || '';
        box.innerHTML = /GM_AUTH_FAIL/.test(m)
          ? '<div class="gm-empty">口令已失效，请重新进入</div>'
          : '<div class="gm-empty">加载失败：' + friendlyError(e) + '</div>';
      });
  }

  // 拉取违禁词词库（登录后调用一次，缓存到 state.forbiddenWords）
  function loadForbiddenWords() {
    return sb.from('forbidden_words').select('word')
      .then(function (r) {
        if (r.error) return;
        state.forbiddenWords = (r.data || [])
          .map(function (w) { return (w.word || '').toLowerCase(); })
          .filter(function (w) { return !!w; });
      })
      .catch(function () {});
  }

  // 检测文本是否命中违禁词，命中返回该词（小写），否则 null
  function matchForbidden(text) {
    var low = (text || '').toLowerCase();
    var list = state.forbiddenWords || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && low.indexOf(list[i]) >= 0) return list[i];
    }
    return null;
  }

  function condText(t) {
    if (t.cond_type === 'streak') return '连续登录 ' + (t.cond_value || '?') + ' 天自动获得';
    if (t.cond_type === 'total_login') return '累计登录 ' + (t.cond_value || '?') + ' 天自动获得';
    if (t.cond_type === 'clean_streak') return '自注册起满 ' + (t.cond_value || '?') + ' 天且从未触发违禁词警告自动获得；一旦触发即中断，已获得的也会被撤销';
    return '仅 GM 手动授予';
  }

  function renderGmTitles(rows) {
    var box = $('gm-title-list');
    box.innerHTML = '';
    if (!rows.length) { box.appendChild(el('div', 'gm-empty', '暂无称号，点击右上角「+ 新建称号」')); return; }
    rows.forEach(function (t) {
      var card = el('div', 'gm-title-card');
      var head = el('div', 'gm-title-head');
      var nameEl = el('span', 'gm-title-name', t.name);
      nameEl.style.borderColor = t.frame_color;
      nameEl.style.color = t.frame_color;
      head.appendChild(nameEl);
      head.appendChild(el('span', 'gm-title-cond', condText(t)));
      card.appendChild(head);
      if (t.description) card.appendChild(el('div', 'gm-title-desc', t.description));
      card.appendChild(el('div', 'gm-title-usage', '已有 ' + (t.usage_count || 0) + ' 人获得'));

      var actions = el('div', 'gm-title-actions');
      var editBtn = el('button', 'btn-mini', '编辑');
      editBtn.type = 'button';
      editBtn.onclick = function () { openTitleForm(t); };
      var grantBtn = el('button', 'btn-mini gm-confirm', '授予');
      grantBtn.type = 'button';
      grantBtn.onclick = function () { toggleTitleBox(card, t, 'grant'); };
      var revokeBtn = el('button', 'btn-mini gm-danger', '撤销');
      revokeBtn.type = 'button';
      revokeBtn.onclick = function () { toggleTitleBox(card, t, 'revoke'); };
      var delBtn = el('button', 'btn-mini gm-danger', '删除');
      delBtn.type = 'button';
      delBtn.onclick = function () { gmDeleteTitle(t.id, t.name); };
      actions.appendChild(editBtn); actions.appendChild(grantBtn); actions.appendChild(revokeBtn); actions.appendChild(delBtn);
      card.appendChild(actions);

      // 授予/撤销 子面板（可输入手机号或昵称；昵称支持模糊搜索）
      var gbox = el('div', 'gm-grant-box');
      gbox.hidden = true;
      gbox.dataset.mode = 'grant';

      // 模式切换：授予 / 撤销
      var modeRow = el('div', 'gm-mode-row');
      var mGrant = el('button', 'btn-mini', '授予模式');
      mGrant.type = 'button';
      var mRevoke = el('button', 'btn-mini', '撤销模式');
      mRevoke.type = 'button';
      mGrant.onclick = function () { setBoxMode(gbox, 'grant'); };
      mRevoke.onclick = function () { setBoxMode(gbox, 'revoke'); };
      modeRow.appendChild(mGrant); modeRow.appendChild(mRevoke);
      gbox.appendChild(modeRow);

      var inp = el('input');
      inp.type = 'text'; inp.placeholder = '输入手机号或昵称（昵称可模糊搜索）'; inp.autocomplete = 'off';
      inp.setAttribute('inputmode', 'text');
      gbox.appendChild(inp);
      var look = el('button', 'btn-mini', '查询');
      look.type = 'button';
      look.onclick = function () { gmTitleLookup(t, inp.value.trim(), gres, card); };
      var cancel = el('button', 'btn-mini', '取消');
      cancel.type = 'button';
      cancel.onclick = function () { gbox.hidden = true; };
      gbox.appendChild(look); gbox.appendChild(cancel);
      var gres = el('div', 'gm-grant-result');
      gbox.appendChild(gres);
      card.appendChild(gbox);
      setBoxMode(gbox, 'grant');

      box.appendChild(card);
    });
  }

  function setBoxMode(gbox, mode) {
    gbox.dataset.mode = mode;
    var btns = gbox.querySelectorAll('.gm-mode-row button');
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      var isGrant = b.textContent.indexOf('授予') >= 0;
      var active = (mode === 'grant' && isGrant) || (mode === 'revoke' && !isGrant);
      if (active) b.classList.add('gm-mode-active'); else b.classList.remove('gm-mode-active');
    }
  }

  function toggleTitleBox(card, t, mode) {
    var gbox = card.querySelector('.gm-grant-box');
    if (!gbox) return;
    gbox.hidden = !gbox.hidden;
    if (!gbox.hidden) setBoxMode(gbox, mode);
  }

  // 授予/撤销 统一搜索：mode = 'grant' 仅显示未获得该称号用户；'revoke' 仅显示已获得该称号用户
  function gmTitleLookup(t, query, resBox, card) {
    var gbox = resBox.parentNode;
    var mode = gbox.dataset.mode || 'grant';
    resBox.innerHTML = '查询中…';
    if (!query) { resBox.innerHTML = '请输入手机号或昵称'; return; }

    function isRpcMissing(e) {
      var m = (e && (e.message || e.code || '')) || '';
      return /PGRST202|Could not find the function|does not exist|schema cache/i.test(String(m));
    }

    function renderRows(rows, holderSet) {
      rows = rows || [];
      if (mode === 'grant' && holderSet) {
        rows = rows.filter(function (u) { return !holderSet[u.id]; });
      }
      if (!rows.length) {
        resBox.innerHTML = (mode === 'grant')
          ? '未找到可授予的用户（可能全部已拥有该称号）'
          : '未找到已获得该称号的用户（可能搜索词不匹配）';
        return;
      }
      resBox.innerHTML = '';
      resBox.appendChild(el('div', 'gm-grant-count',
        (mode === 'grant' ? '找到 ' + rows.length + ' 个可授予用户'
                           : '找到 ' + rows.length + ' 个已获得该称号的用户')));
      rows.forEach(function (u) {
        var row = el('div', 'gm-grant-user-row');
        row.setAttribute('data-uid', u.id);
        var infoTxt = (u.nickname || '(无昵称)') + ' · ' + (u.phone || '') + (u.remark ? ' · ' + u.remark : '');
        if (mode === 'grant' && holderSet && holderSet[u.id]) infoTxt += '（已拥有）';
        var info = el('div', 'gm-grant-user', infoTxt);
        row.appendChild(info);
        if (mode === 'grant') {
          var ok = el('button', 'btn-mini gm-confirm', '授予');
          ok.type = 'button';
          if (holderSet && holderSet[u.id]) {
            ok.disabled = true;
            ok.textContent = '已授予';
            ok.classList.remove('gm-confirm');
          }
          ok.onclick = function () { gmGrantTitle(u.id, t, row, card); };
          row.appendChild(ok);
        } else {
          var rv = el('button', 'btn-mini gm-danger', '撤销');
          rv.type = 'button';
          rv.onclick = function () { gmRevokeTitleFromTab(u.id, t, row, card); };
          row.appendChild(rv);
        }
        resBox.appendChild(row);
      });
    }

    function fetchHolders(done) {
      if (mode !== 'grant') { done({}); return; }
      sb.rpc('gm_get_title_holders', { p_pwd: gmPwd, p_title_id: t.id })
        .then(function (r) {
          if (r.error && isRpcMissing(r.error)) { done(null); return; }
          var set = {};
          (r.data || []).forEach(function (h) { if (h.user_id) set[h.user_id] = 1; });
          done(set);
        })
        .catch(function (e) {
          if (isRpcMissing(e)) { done(null); }
          else { done({}); }
        });
    }

    fetchHolders(function (holderSet) {
      var rpc = (mode === 'grant') ? 'gm_search_users_for_title' : 'gm_search_users_with_title';
      sb.rpc(rpc, { p_pwd: gmPwd, p_query: query, p_title_id: t.id })
        .then(function (r) {
          if (r.error && isRpcMissing(r.error)) {
            if (mode === 'grant') {
              if (holderSet === null) {
                resBox.innerHTML = '授予搜索需先执行最新 SQL 迁移（gm_search_users_for_title / gm_get_title_holders），否则无法排除已授予用户';
                return;
              }
              return sb.rpc('gm_search_users', { p_pwd: gmPwd, p_query: query })
                .then(function (r2) { renderRows(r2.data, holderSet); });
            }
            resBox.innerHTML = '撤销搜索功能需要先执行最新 SQL 迁移（gm_search_users_with_title）';
            return;
          }
          renderRows(r.data, holderSet);
        })
        .catch(function (e) {
          if (isRpcMissing(e)) {
            if (mode === 'grant') {
              if (holderSet === null) {
                resBox.innerHTML = '授予搜索需先执行最新 SQL 迁移（gm_search_users_for_title / gm_get_title_holders），否则无法排除已授予用户';
                return;
              }
              sb.rpc('gm_search_users', { p_pwd: gmPwd, p_query: query })
                .then(function (r2) { renderRows(r2.data, holderSet); })
                .catch(function (e2) { resBox.innerHTML = '查询失败：' + friendlyError(e2); });
            } else {
              resBox.innerHTML = '撤销搜索功能需要先执行最新 SQL 迁移（gm_search_users_with_title）';
            }
            return;
          }
          resBox.innerHTML = '查询失败：' + friendlyError(e);
        });
    });
  }

  function gmGrantTitle(uid, t, row, card) {
    sb.rpc('gm_grant_title', { p_pwd: gmPwd, p_user_id: uid, p_title_id: t.id })
      .then(function (r) {
        if (r.error) throw r.error;
        toast('已授予「' + t.name + '」');
        // 同步前端头像框；refreshAdminStatus 兜底刷新自身强制称号
        loadDisplayTitles().then(refreshAdminStatus).then(applySelfTitle).then(renderConversations);
        // 从搜索结果中移除该用户，避免重复授予
        if (row && row.parentNode) domRemove(row);
        // 更新卡片上的“已有 N 人获得”
        if (card) {
          var usageEl = card.querySelector('.gm-title-usage');
          if (usageEl) {
            t.usage_count = (t.usage_count || 0) + 1;
            usageEl.textContent = '已有 ' + t.usage_count + ' 人获得';
          }
        }
        // 停留在当前授予页面，不关闭子面板
      })
      .catch(function (e) { toast('授予失败：' + friendlyError(e)); });
  }

  // 称号管理界面内的撤销：成功后移除该行并递减计数，停留在当前页面
  function gmRevokeTitleFromTab(uid, t, row, card) {
    if (!window.confirm('确认撤销「' + t.name + '」称号？')) return;
    sb.rpc('gm_revoke_title', { p_pwd: gmPwd, p_user_id: uid, p_title_id: t.id })
      .then(function (r) {
        if (r.error) throw r.error;
        toast('已撤销「' + t.name + '」');
        loadDisplayTitles().then(refreshAdminStatus).then(applySelfTitle).then(renderConversations);
        // 从搜索结果中移除该用户，方便继续撤销下一位
        if (row && row.parentNode) domRemove(row);
        // 更新卡片上的“已有 N 人获得”
        if (card) {
          var usageEl = card.querySelector('.gm-title-usage');
          if (usageEl) {
            t.usage_count = Math.max(0, (t.usage_count || 1) - 1);
            usageEl.textContent = '已有 ' + t.usage_count + ' 人获得';
          }
        }
        // 停留在当前撤销页面，不关闭子面板
      })
      .catch(function (e) { toast('撤销失败：' + friendlyError(e)); });
  }

  function gmDeleteTitle(id, name) {
    if (!window.confirm('确认删除称号「' + name + '」？已获得该称号的用户也会一并失去。')) return;
    sb.rpc('gm_delete_title', { p_pwd: gmPwd, p_title_id: id })
      .then(function (r) {
        if (r.error) throw r.error;
        toast('已删除称号：' + name);
        openTitleTab();
      })
      .catch(function (e) { toast('删除失败：' + friendlyError(e)); });
  }

  // 新建 / 编辑称号表单
  function autoCondTypes() { return ['streak', 'total_login', 'clean_streak']; }
  function setDaysLabel(cond) {
    var lbl = $('gm-title-days-label');
    if (lbl) lbl.textContent = (cond === 'total_login') ? '累计天数' : '连续天数';
  }

  function openTitleForm(editTitle) {
    if (editTitle) {
      state.editingTitleId = editTitle.id;
      $('gm-title-name').value = editTitle.name || '';
      $('gm-title-desc').value = editTitle.description || '';
      $('gm-title-color').value = editTitle.frame_color || '#ffd700';
      $('gm-title-style').value = editTitle.frame_style || 'ring';
      $('gm-title-cond').value = editTitle.cond_type || 'manual';
      $('gm-title-days').value = editTitle.cond_value || 7;
      var isAuto = autoCondTypes().indexOf(editTitle.cond_type) >= 0;
      $('gm-title-days-wrap').hidden = !isAuto;
      setDaysLabel(editTitle.cond_type);
      $('gm-title-modal-title').textContent = '编辑称号';
      $('gm-title-create').textContent = '保存';
    } else {
      state.editingTitleId = null;
      $('gm-title-name').value = '';
      $('gm-title-desc').value = '';
      $('gm-title-color').value = '#ffd700';
      $('gm-title-style').value = 'ring';
      $('gm-title-cond').value = 'manual';
      $('gm-title-days-wrap').hidden = true;
      $('gm-title-days').value = '7';
      setDaysLabel('manual');
      $('gm-title-modal-title').textContent = '新建称号';
      $('gm-title-create').textContent = '创建';
    }
    $('gm-title-error').hidden = true;
    showModal('gm-title-modal');
  }

  function readTitleForm() {
    return {
      name: $('gm-title-name').value.trim(),
      desc: $('gm-title-desc').value.trim(),
      color: $('gm-title-color').value,
      style: $('gm-title-style').value,
      cond: $('gm-title-cond').value,
      days: parseInt($('gm-title-days').value, 10)
    };
  }

  function validateTitleForm(f) {
    if (!f.name) return '请填写称号名称';
    if (autoCondTypes().indexOf(f.cond) >= 0 && (!f.days || f.days < 1)) return '请填写有效的天数';
    return null;
  }

  function gmCreateTitle() {
    var f = readTitleForm();
    var err = $('gm-title-error');
    err.hidden = true;
    var msg = validateTitleForm(f);
    if (msg) { err.textContent = msg; err.hidden = false; return; }
    var btn = $('gm-title-create');
    btn.disabled = true; btn.textContent = '创建中…';
    sb.rpc('gm_create_title', {
      p_pwd: gmPwd, p_name: f.name, p_desc: f.desc, p_color: f.color,
      p_style: f.style, p_cond_type: f.cond, p_value: autoCondTypes().indexOf(f.cond) >= 0 ? f.days : null
    })
      .then(function (r) {
        if (r.error) throw r.error;
        hideModal('gm-title-modal');
        toast('已创建称号：' + f.name);
        openTitleTab();
      })
      .catch(function (e) { err.textContent = '创建失败：' + friendlyError(e); err.hidden = false; })
      .then(function () { btn.disabled = false; btn.textContent = '创建'; });
  }

  function gmUpdateTitle() {
    var id = state.editingTitleId;
    if (!id) return;
    var f = readTitleForm();
    var err = $('gm-title-error');
    err.hidden = true;
    var msg = validateTitleForm(f);
    if (msg) { err.textContent = msg; err.hidden = false; return; }
    var btn = $('gm-title-create');
    btn.disabled = true; btn.textContent = '保存中…';
    sb.rpc('gm_update_title', {
      p_pwd: gmPwd, p_title_id: id, p_name: f.name, p_desc: f.desc, p_color: f.color,
      p_style: f.style, p_cond_type: f.cond, p_value: autoCondTypes().indexOf(f.cond) >= 0 ? f.days : null
    })
      .then(function (r) {
        if (r.error) throw r.error;
        hideModal('gm-title-modal');
        toast('已保存称号：' + f.name);
        openTitleTab();
        loadDisplayTitles().then(applySelfTitle).then(renderConversations);
      })
      .catch(function (e) { err.textContent = '保存失败：' + friendlyError(e); err.hidden = false; })
      .then(function () { btn.disabled = false; btn.textContent = '保存'; });
  }

  function onTitleSubmit() {
    if (state.editingTitleId) gmUpdateTitle();
    else gmCreateTitle();
  }

  // 在用户详情里追加「称号」区块（查看/撤回）
  function renderGmUserTitles(uid) {
    var box = $('gm-detail');
    // 先清理已有的「称号」区块，保证幂等——无论被调用几次都只保留一个
    var olds = box.querySelectorAll('.gm-titles-sub');
    for (var i = 0; i < olds.length; i++) {
      var prev = olds[i].previousElementSibling;
      if (prev && prev.classList && prev.classList.contains('gm-subtitle') && prev.textContent === '称号') prev.parentNode.removeChild(prev);
      olds[i].parentNode.removeChild(olds[i]);
    }
    // 始终插在「禁言管理」之前（若无则追加到末尾）
    var muteSec = box.querySelector('.gm-mute-sec');
    var sub = el('div', 'gm-subtitle', '称号');
    var wrap = el('div', 'gm-titles-sub');
    box.insertBefore(sub, muteSec);
    box.insertBefore(wrap, muteSec);

    wrap.appendChild(el('div', 'gm-loading', '加载中…'));
    sb.rpc('gm_list_user_titles', { p_pwd: gmPwd, p_user_id: uid })
      .then(function (r) {
        if (r.error) throw r.error;
        var rows = r.data || [];
        wrap.innerHTML = '';
        if (!rows.length) { wrap.appendChild(el('div', 'gm-empty', '该用户暂无称号')); return; }
        rows.forEach(function (t) {
          var row = el('div', 'gm-row');
          var txt = el('div', 'gm-row-text');
          txt.appendChild(el('div', 'gm-row-name', t.name));
          txt.appendChild(el('div', 'gm-row-sub', (t.source === 'auto' ? '自动获得' : 'GM 授予')));
          row.appendChild(txt);
          var b = el('button', 'btn-mini gm-danger', '撤回');
          b.type = 'button';
          b.onclick = function () { gmRevokeTitle(uid, t.title_id, t.name); };
          row.appendChild(b);
          wrap.appendChild(row);
        });
      })
      .catch(function (e) {
        wrap.innerHTML = '<div class="gm-empty">加载失败：' + friendlyError(e) + '</div>';
      });
  }

  function gmRevokeTitle(uid, titleId, name) {
    if (!window.confirm('确认撤回称号「' + name + '」？')) return;
    sb.rpc('gm_revoke_title', { p_pwd: gmPwd, p_user_id: uid, p_title_id: titleId })
      .then(function (r) {
        if (r.error) throw r.error;
        toast('已撤回称号：' + name);
        loadDisplayTitles().then(refreshAdminStatus).then(applySelfTitle).then(renderConversations);
        renderGmUserTitles(uid);
      })
      .catch(function (e) { toast('撤回失败：' + friendlyError(e)); });
  }

  function changePassword() {
    var np = $('settings-newpwd').value;
    var cp = $('settings-confirm-pwd').value;
    var err = $('change-pwd-error');
    err.hidden = true;
    if (np.length < 6) { err.textContent = '新密码至少 6 位'; err.hidden = false; return; }
    if (np !== cp) { err.textContent = '两次输入的密码不一致'; err.hidden = false; return; }

    var btn = $('change-pwd-btn');
    btn.disabled = true; btn.textContent = '更新中…';
    sb.auth.updateUser({ password: np })
      .then(function (r) {
        if (r.error) throw r.error;
        resetPwdFields();
        if (state.forceChangePwd) {
          state.forceChangePwd = false;
          $('force-pwd-banner').hidden = true;
          hideModal('settings-modal');
          toast('密码已修改，账号已恢复');
        } else {
          toast('密码已更新，下次登录生效');
        }
      })
      .catch(function (e) {
        var m = (e && e.message) || '';
        if (/re-authenticat|recent login|sign in recently/i.test(m)) {
          err.textContent = '出于安全需要，请先退出登录并重新登录后再修改密码';
        } else {
          err.textContent = friendlyError(e);
        }
        err.hidden = false;
      })
      .then(function () { btn.disabled = false; btn.textContent = '更新密码'; });
  }

  $('settings-btn').addEventListener('click', openSettings);
  $('settings-close').addEventListener('click', closeSettings);
  $('switch-account-settings').addEventListener('click', switchAccountFromSettings);
  $('settings-cancel').addEventListener('click', closeSettings);

  // 禁言提示弹窗（发送被拦截时弹出）
  $('mute-notice-close').addEventListener('click', function () { hideModal('mute-notice-modal'); });
  $('mute-notice-ok').addEventListener('click', function () { hideModal('mute-notice-modal'); });
  // 管理员称号公告弹窗
  $('admin-announce-close').addEventListener('click', function () { hideModal('admin-announce-modal'); });
  $('admin-announce-ok').addEventListener('click', function () { hideModal('admin-announce-modal'); });

  // 举报弹窗
  $('report-close').addEventListener('click', function () { hideModal('report-modal'); });
  $('report-cancel').addEventListener('click', function () { hideModal('report-modal'); });
  $('report-submit').addEventListener('click', submitReport);
  var reportChips = document.querySelectorAll('#report-types .report-chip');
  for (var ri = 0; ri < reportChips.length; ri++) {
    reportChips[ri].addEventListener('click', function () {
      var t = this.getAttribute('data-type');
      state.reportType = t;
      var sibs = document.querySelectorAll('#report-types .report-chip');
      for (var s = 0; s < sibs.length; s++) sibs[s].classList.remove('active');
      this.classList.add('active');
      renderReportTargets();
    });
  }
  var rMemberSearch = $('report-member-search');
  if (rMemberSearch) {
    rMemberSearch.addEventListener('input', renderReportMemberSearch);
    rMemberSearch.addEventListener('keyup', renderReportMemberSearch);
  }
  var rMemberClear = $('report-member-clear');
  if (rMemberClear) rMemberClear.addEventListener('click', clearReportMember);

  $('mute-notice-appeal').addEventListener('click', function () {
    hideModal('mute-notice-modal');
    $('appeal-reason').value = '';
    $('appeal-error').hidden = true;
    showModal('appeal-modal');
  });

  // 禁言申诉弹窗
  $('appeal-close').addEventListener('click', function () { hideModal('appeal-modal'); });
  $('appeal-cancel').addEventListener('click', function () { hideModal('appeal-modal'); });
  $('appeal-open-btn').addEventListener('click', function () {
    var u = state.mutedUntil;
    if (!(u && new Date(u).getTime() > Date.now())) {
      toast('你未被禁言');
      return;
    }
    $('appeal-reason').value = '';
    $('appeal-error').hidden = true;
    showModal('appeal-modal');
  });
  $('appeal-submit').addEventListener('click', function () {
    var reason = $('appeal-reason').value.trim();
    if (reason.length < 5) {
      $('appeal-error').textContent = '申诉理由至少 5 个字';
      $('appeal-error').hidden = false;
      return;
    }
    sb.rpc('submit_mute_appeal', { p_reason: reason })
      .then(function (r) {
        if (r.error) throw r.error;
        toast('申诉已提交，管理员将尽快审核');
        hideModal('appeal-modal');
        refreshAppealSection();
      })
      .catch(function (e) {
        var m = (e && (e.message || '')) || '';
        if (/NOT_MUTED/.test(m)) $('appeal-error').textContent = '你当前未被禁言，无需申诉';
        else if (/REASON_TOO_SHORT/.test(m)) $('appeal-error').textContent = '申诉理由至少 5 个字';
        else $('appeal-error').textContent = '提交失败：' + friendlyError(e);
        $('appeal-error').hidden = false;
      });
  });

  // 问题反馈弹窗
  $('feedback-close').addEventListener('click', function () { hideModal('feedback-modal'); });
  $('feedback-cancel').addEventListener('click', function () { hideModal('feedback-modal'); });
  $('feedback-open-btn').addEventListener('click', function () {
    $('feedback-content').value = '';
    $('feedback-contact').value = '';
    $('feedback-error').hidden = true;
    showModal('feedback-modal');
  });
  $('feedback-submit').addEventListener('click', function () {
    var content = $('feedback-content').value.trim();
    var contact = $('feedback-contact').value.trim();
    if (content.length < 5) {
      $('feedback-error').textContent = '反馈内容至少 5 个字';
      $('feedback-error').hidden = false;
      return;
    }
    sb.rpc('submit_feedback', { p_content: content, p_contact: contact })
      .then(function (r) {
        if (r.error) throw r.error;
        toast('反馈已提交，感谢你的建议');
        hideModal('feedback-modal');
      })
      .catch(function (e) {
        var m = (e && (e.message || '')) || '';
        if (/CONTENT_TOO_SHORT/.test(m)) $('feedback-error').textContent = '反馈内容至少 5 个字';
        else if (/NOT_AUTH/.test(m)) $('feedback-error').textContent = '请先登录后再反馈';
        else $('feedback-error').textContent = '提交失败：' + friendlyError(e);
        $('feedback-error').hidden = false;
      });
  });

  // 消息推送开关
  var pushBtn = $('push-toggle-btn');
  if (pushBtn) {
    refreshPushButton();
    pushBtn.addEventListener('click', function () {
      if (!pushSupported()) { toast('当前浏览器不支持系统通知'); return; }
      getSwRegistration().then(function (reg) {
        if (!reg) { toast('推送服务未就绪，请刷新页面重试'); return; }
        reg.pushManager.getSubscription().then(function (sub) {
          if (sub) disablePush(); else initPush();
        });
      });
    });
  }

  // 注销账号：入口与各步骤按钮
  $('delete-account-btn').addEventListener('click', openDeleteAccount);
  $('del-account-close').addEventListener('click', function () { hideModal('del-account-modal'); });
  $('del-account-cancel').addEventListener('click', function () { hideModal('del-account-modal'); });
  $('del-account-confirm').addEventListener('click', deleteAccountToVerify);
  $('del-account-verify-close').addEventListener('click', function () { hideModal('del-account-verify'); });
  $('del-account-verify-cancel').addEventListener('click', function () { hideModal('del-account-verify'); });
  $('del-account-verify-btn').addEventListener('click', deleteAccountVerify);
  $('del-account-final-close').addEventListener('click', function () { hideModal('del-account-final'); });
  $('del-account-final-cancel').addEventListener('click', function () { hideModal('del-account-final'); });
  $('del-account-final-btn').addEventListener('click', deleteAccountCommit);
  $('settings-modal').addEventListener('click', function (e) {
    if (e.target === this) closeSettings();
  });

  // 绝对管理员（GM）后台：入口与各步骤
  $('gm-open-btn').addEventListener('click', openGmEntry);
  $('gm-pwd-close').addEventListener('click', function () { hideModal('gm-pwd-modal'); });
  $('gm-pwd-cancel').addEventListener('click', function () { hideModal('gm-pwd-modal'); });
  $('gm-pwd-confirm').addEventListener('click', gmTryAuth);
  $('gm-pwd-input').addEventListener('keydown', function (e) { if (e.key === 'Enter') gmTryAuth(); });
  $('gm-close').addEventListener('click', closeGm);
  $('gm-panel').addEventListener('click', function (e) { if (e.target === this) closeGm(); });
  $('gm-search-btn').addEventListener('click', gmSearch);
  $('gm-search-input').addEventListener('keydown', function (e) { if (e.key === 'Enter') gmSearch(); });

  // 称号管理标签页与表单
  $('gm-tab-users').addEventListener('click', function () { gmSwitchTab('users'); });
  $('gm-tab-reports').addEventListener('click', function () { gmSwitchTab('reports'); });
  $('gm-tab-titles').addEventListener('click', function () { gmSwitchTab('titles'); });
  $('gm-tab-groups').addEventListener('click', function () { gmSwitchTab('groups'); });
  $('gm-tab-appeals').addEventListener('click', function () { gmSwitchTab('appeals'); });
  $('gm-tab-feedback').addEventListener('click', function () { gmSwitchTab('feedback'); });
  $('gm-tab-wordlog').addEventListener('click', function () { gmSwitchTab('wordlog'); });
  $('gm-tab-userreports').addEventListener('click', function () { gmSwitchTab('userreports'); });
  // 各看板「刷新」按钮（手动刷新）
  $('gm-report-refresh').addEventListener('click', openReportsTab);
  $('gm-userreport-refresh').addEventListener('click', openGmUserReportsTab);
  $('gm-word-log-refresh').addEventListener('click', openGmWordLogTab);
  $('gm-appeal-refresh').addEventListener('click', openGmAppealsTab);
  // 各看板搜索框（输入即过滤，模糊匹配）
  function bindSearch(id, fn) { var e = $(id); if (e) e.addEventListener('input', fn); }
  bindSearch('gm-report-search', renderGmReports);
  bindSearch('gm-userreport-search', renderGmUserReports);
  bindSearch('gm-word-log-search', renderGmWordLog);
  bindSearch('gm-appeal-search', renderGmAppeals);
  // 注意：gm-word-log-clear 按钮已从 HTML 移除（GM 后台为留存日志，不可清空/删除）
  bindWlBatch('gm');
  // 每日 00:00 自动刷新 GM 看板（即使面板当时关闭，定时器也常驻，面板打开时按当前 tab 刷新）
  scheduleDailyRefresh();
  $('gm-group-search-btn').addEventListener('click', gmSearchGroups);
  $('gm-group-search-input').addEventListener('keydown', function (e) { if (e && e.key === 'Enter') gmSearchGroups(); });
  $('gm-title-new-btn').addEventListener('click', function () { openTitleForm(); });
  $('gm-title-close').addEventListener('click', function () { hideModal('gm-title-modal'); });
  $('gm-title-cancel').addEventListener('click', function () { hideModal('gm-title-modal'); });
  $('gm-title-create').addEventListener('click', onTitleSubmit);
  // GM 聊天记录查看器：关闭 / 刷新 / 点背景关闭
  $('gm-chat-close').addEventListener('click', gmCloseChat);
  $('gm-chat-refresh').addEventListener('click', function () { if (gmChatReload) gmChatReload(); });
  $('gm-chat-viewer').addEventListener('click', function (e) { if (e.target === this) gmCloseChat(); });
  $('gm-title-cond').addEventListener('change', function () {
    var isAuto = autoCondTypes().indexOf(this.value) >= 0;
    $('gm-title-days-wrap').hidden = !isAuto;
    setDaysLabel(this.value);
  });

  // 管理员（称号）后台：侧边栏「违禁接收」入口 + 免密面板
  $('admin-violation-open').addEventListener('click', openAdminPanel);
  $('admin-close').addEventListener('click', function () { state.adminPanelOpen = false; hideModal('admin-panel'); });
  $('admin-panel').addEventListener('click', function (e) { if (e.target === this) { state.adminPanelOpen = false; hideModal('admin-panel'); } });
  // 管理员面板：子 tab 切换（周报 / 违禁词记录 / 用户举报 / 禁言申诉）
  function setAdminTabActive(name) {
    ['reports','wordlog','userreports','appeals'].forEach(function (k) {
      var t = $('admin-tab-' + k);
      if (t) {
        if (k === name) t.classList.add('active');
        else t.classList.remove('active');
      }
      var p = $('admin-' + (k === 'reports' ? 'reports' : (k === 'wordlog' ? 'word-log' : k)));
      if (p) p.hidden = (k !== name);
    });
  }
  $('admin-tab-reports').addEventListener('click', function () {
    setAdminTabActive('reports');
    openAdminReports();
  });
  $('admin-tab-wordlog').addEventListener('click', function () {
    setAdminTabActive('wordlog');
    openAdminWordLog();
  });
  $('admin-tab-userreports').addEventListener('click', function () {
    setAdminTabActive('userreports');
    openUserReports();
  });
  $('admin-tab-appeals').addEventListener('click', function () {
    setAdminTabActive('appeals');
    openAdminAppeals();
  });
  // 禁言申诉搜索框（前端过滤，兼容老 WebView）
  var gmAs = $('gm-appeal-search');
  if (gmAs) gmAs.addEventListener('input', renderGmAppeals);
  var admAs = $('admin-appeal-search');
  if (admAs) admAs.addEventListener('input', renderAdminAppeals);
  $('admin-word-log-refresh').addEventListener('click', openAdminWordLog);
  $('admin-report-refresh').addEventListener('click', openAdminReports);
  $('admin-userreport-refresh').addEventListener('click', openUserReports);
  $('admin-appeal-refresh').addEventListener('click', openAdminAppeals);
  $('admin-word-log-clear').addEventListener('click', function () {
    if (!window.confirm('确认清空全部违禁词检测记录？\n仅对你本人隐藏，其他管理员/开发者与 GM 后台均不受影响，且 GM 记录永不删除。')) return;
    this.disabled = true;
    sb.rpc('admin_clear_word_log')
      .then(function (r) {
        if (r.error) throw r.error;
        var n = (r.data === null || r.data === undefined) ? 0 : (r.data || 0);
        toast('已清空违禁词记录' + (n ? ('（' + n + ' 条）') : ''));
        openAdminWordLog();
      })
      .catch(function (e) {
        var m = (e && (e.message || '')) || '';
        if (/ADMIN_FORBIDDEN/.test(m)) { onAdminRevoked(); return; }
        toast('清空失败：' + friendlyError(e));
      })
      .then(function () { this.disabled = false; }.bind(this));
  });
  bindWlBatch('admin');
  bindUrBatch();

  $('settings-avatar-btn').addEventListener('click', function () {
    $('settings-avatar-file').click();
  });

  $('settings-avatar-file').addEventListener('change', function () {
    var file = this.files && this.files[0];
    this.value = '';
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { toast('头像图片请小于 10 MB'); return; }

    var ext = (file.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '');
    var rand = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
             : Date.now() + (Math.random() * 1e6 | 0);
    var path = state.uid + '/avatars/' + rand + (ext ? '.' + ext : '');

    var btn = $('settings-avatar-btn');
    btn.disabled = true; btn.textContent = '上传中…';
    sb.storage.from(BUCKET).upload(path, file, { contentType: file.type || 'image/png', upsert: true })
      .then(function (r) {
        if (r.error) throw r.error;
        pendingAvatar = path;
        var url = URL.createObjectURL(file);   // 立即本地预览
        var av = $('settings-avatar');
        av.textContent = '';
        av.style.background = 'transparent';
        var old = av.querySelector('img');
        domRemove(old);
        var im = new Image();
        im.className = 'avatar-img';
        im.src = url;
        av.appendChild(im);
        toast('头像已选择，点「保存」生效');
      })
      .catch(function (e) { toast(friendlyError(e)); })
      .then(function () { btn.disabled = false; btn.textContent = '更换头像'; });
  });

  $('change-pwd-btn').addEventListener('click', changePassword);
  $('logout-other-devices').addEventListener('click', logoutOtherDevices);

  $('settings-save').addEventListener('click', function () {
    var name = $('settings-name').value.trim();
    if (!name) { toast('名称不能为空'); return; }
    var payload = { nickname: name.slice(0, 20) };
    if (pendingAvatar !== null) payload.avatar_path = pendingAvatar;

    var btn = $('settings-save');
    btn.disabled = true; btn.textContent = '保存中…';
    sb.from('profiles').update(payload).eq('id', state.uid)
      .then(function (r) {
        if (r.error) throw r.error;
        state.profile.nickname = name;
        if (pendingAvatar !== null) state.profile.avatar_path = pendingAvatar;
        $('me-name').textContent = name;
        setAvatar($('me-avatar'), {
          nickname: state.profile.nickname,
          phone: state.profile.phone,
          avatarPath: state.profile.avatar_path
        });
        toast('已保存');
        closeSettings();
      })
      .catch(function (e) { toast(friendlyError(e)); })
      .then(function () { btn.disabled = false; btn.textContent = '保存'; });
  });

  /* ============================================================
   *  群聊
   * ============================================================ */
  function groupById(id) {
    for (var i = 0; i < state.groups.length; i++) if (state.groups[i].id === id) return state.groups[i];
    return null;
  }
  function friendById(id) {
    for (var i = 0; i < state.friends.length; i++) if (state.friends[i].id === id) return state.friends[i];
    return null;
  }

  function loadGroups() {
    // 逐级降级：avatar_path / pinned 列若尚未建立（SQL 未执行），自动退回可用的查询，
    // 保证群列表永远能显示，不会因为缺列整块空掉。
    function fetchGroups(withAvatar, withPin) {
      var cols = 'id,name,owner_id' + (withAvatar ? ',avatar_path' : '') +
                 ', group_members(user_id' + (withPin ? ', pinned' : '') + ')';
      return sb.from('groups').select(cols).order('created_at', { ascending: false });
    }
    return fetchGroups(true, true).then(function (r) {
      if (!r.error) return parseGroups(true, true, r);
      var msg = (r.error.message || '') + ' ' + (r.error.details || '') + ' ' + (r.error.hint || '');
      var noAvatar = msg.indexOf('avatar_path') !== -1;
      var noPin    = msg.indexOf('pinned') !== -1;
      if (!noAvatar && !noPin) throw r.error;
      return fetchGroups(!noAvatar, !noPin).then(function (r2) {
        if (!r2.error) return parseGroups(!noAvatar, !noPin, r2);
        // 两列都缺时，第二次查询仍可能报另一个列名，再退到最小集合
        return fetchGroups(false, false).then(function (r3) { return parseGroups(false, false, r3); });
      });
    });
  }

  function parseGroups(withAvatar, withPin, r) {
    if (r.error) throw r.error;
    state.groups = (r.data || []).map(function (g) {
      var members = (g.group_members || []).map(function (m) { return m.user_id; });
      var mine = (g.group_members || []).filter(function (m) { return m.user_id === state.uid; })[0];
      var pinned = withPin && mine ? !!mine.pinned : false;
      return {
        type: 'group',
        id: g.id,
        name: g.name,
        ownerId: g.owner_id,
        avatar: withAvatar ? (g.avatar_path || null) : null,
        memberIds: members,
        memberCount: members.length,
        iAmOwner: g.owner_id === state.uid,
        pinned: pinned,
        remark: state.groupRemarks[g.id] || null
      };
    });
    state.groups.sort(function (a, b) { return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0); });
    if (state.active && state.active.type === 'group') {
      var fresh = groupById(state.active.id);
      if (fresh) state.active = fresh;
    }
    renderGroups();
    return state.groups;
  }

  function renderGroups() { renderConversations(); }

  function toggleGroupPin(g) {
    sb.rpc('toggle_group_pin', { p_group_id: g.id })
      .then(function (res) {
        if (res && res.error) throw res.error;
        var val = res && res.data !== undefined ? res.data : res;
        g.pinned = !!val;
        if (state.active && state.active.type === 'group' && state.active.id === g.id) state.active.pinned = g.pinned;
        state.groups.sort(function (a, b) { return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0); });
        renderGroups();
      })
      .catch(function (e) {
        var msg = friendlyError(e);
        if (/pinned|toggle_group_pin|column .* does not exist/i.test(msg)) {
          toast('群置顶功能需要先在 Supabase 运行 20260801_group_pin.sql 迁移');
          return;
        }
        toast(msg);
      });
  }

  function loadGroupMemberProfiles(groupId) {
    return sb.from('group_members').select('user_id, profiles(id,nickname,avatar_path,phone)')
      .eq('group_id', groupId)
      .then(function (r) {
        if (r.error) return;
        (r.data || []).forEach(function (m) {
          var p = m.profiles;
          if (p) state.profilesById[p.id] = { nickname: p.nickname, avatar_path: p.avatar_path, phone: p.phone };
        });
      });
  }

  /* ---------- 创建群聊 ---------- */
  function openNewGroup() {
    $('new-group-name').value = '';
    renderFriendPicker($('group-friend-picker'), state.friends, []);
    showModal('new-group-modal');
  }

  function renderFriendPicker(container, friends, excludeIds) {
    container.innerHTML = '';
    if (!friends.length) { container.appendChild(el('div', 'note', '还没有好友')); return; }
    friends.forEach(function (f) {
      if (excludeIds.indexOf(f.id) >= 0) return;
      var label = el('label', 'picker-item');
      var cb = document.createElement('input');
      cb.type = 'checkbox'; cb.value = f.id; cb.className = 'picker-cb';
      var av = el('div', 'avatar sm');
      setAvatar(av, { nickname: f.remark || f.nickname, phone: f.phone, avatarPath: f.avatar });
      var info = el('div', 'info');
      info.appendChild(el('div', 'nm', f.remark || f.nickname));
      info.appendChild(el('div', 'ph', f.phone));
      label.appendChild(cb); label.appendChild(av); label.appendChild(info);
      container.appendChild(label);
    });
  }

  function createGroup() {
    var name = $('new-group-name').value.trim() || ('群聊' + (state.groups.length + 1));
    var checks = $('group-friend-picker').querySelectorAll('input[type=checkbox]:checked');
    if (!checks.length) { toast('至少选择一位好友'); return; }
    var memberIds = [];
    checks.forEach(function (c) { memberIds.push(c.value); });
    var btn = $('new-group-create');
    btn.disabled = true; btn.textContent = '创建中…';
    // 用 security definer 的 create_group RPC 一次性建群+加成员，绕开 RLS 写入限制
    sb.rpc('create_group', { p_name: name, p_member_ids: memberIds })
      .then(function (r) {
        if (r.error) throw r.error;
        var gid = r.data;
        hideModal('new-group-modal');
        return loadGroups().then(function () { return gid; });
      })
      .then(function (gid) {
        var g = groupById(gid);
        if (g) openChat(g);
        toast('群聊已创建');
      })
      .catch(function (e) { toast(friendlyError(e)); })
      .then(function () { btn.disabled = false; btn.textContent = '创建'; });
  }

  /* ---------- 群资料 / 管理 ---------- */
  // null = 本次未改动群图标；'' = 要清除；字符串 = 新的存储路径
  var pendingGroupAvatar = null;

  function openGroupInfo() {
    if (!state.active || state.active.type !== 'group') return;
    var g = state.active;
    pendingGroupAvatar = null;
    $('group-info-name').value = g.name;
    $('group-remark').value = state.groupRemarks[g.id] || '';
    // 我的群昵称（对全群成员可见）：优先从已加载的缓存中回填；
    // 若缓存尚未就绪（极快点击），异步补拉一次并在弹窗仍打开时回填，避免显示成空白
    var myGrpNick = state.groupNicknames[g.id] && state.groupNicknames[g.id][state.uid];
    $('group-nickname').value = myGrpNick || '';
    if (!state.groupNicknames[g.id]) {
      loadGroupNicknames(g.id).then(function () {
        if ($('group-info-modal') && $('group-info-modal').classList.contains('open')) {
          var nk = state.groupNicknames[g.id] && state.groupNicknames[g.id][state.uid];
          $('group-nickname').value = nk || '';
        }
      });
    }
    $('group-info-name').disabled = !g.iAmOwner;
    $('group-name-field').hidden = !g.iAmOwner;
    $('group-info-save').hidden = !g.iAmOwner;
    $('group-info-add').hidden = !g.iAmOwner;
    // 群图标：仅群主可改，非群主只看不改
    setGroupAvatar($('group-info-avatar'), g);
    $('group-avatar-btn').hidden = !g.iAmOwner;
    $('group-avatar-clear').hidden = !g.iAmOwner || !g.avatar;
    // 群主显示「解散群聊」、隐藏「退出群聊」；普通成员反之
    $('group-info-dissolve').hidden = !g.iAmOwner;
    $('group-info-leave').hidden = g.iAmOwner;
    renderMemberList(g);
    refreshGroupMembersOnline(g);
    loadTitlesForGroupMembers(g.memberIds).then(function () {
      if ($('group-info-modal') && $('group-info-modal').classList.contains('open')) {
        renderMemberList(g);
      }
    });
    showModal('group-info-modal');
  }

  /* 保存「我的群昵称」：仅改本人在当前群的群昵称，群内成员可见 */
  function saveMyGroupNickname() {
    if (!state.active || state.active.type !== 'group') return;
    var g = state.active;
    var val = $('group-nickname').value.trim();
    var btn = $('group-nickname-save');
    btn.disabled = true; btn.textContent = '保存中…';
    sb.rpc('set_my_group_nickname', { p_group_id: g.id, p_nickname: val })
      .then(function (r) {
        if (r && r.error) throw r.error;
        if (!state.groupNicknames[g.id]) state.groupNicknames[g.id] = {};
        if (val) state.groupNicknames[g.id][state.uid] = val;
        else delete state.groupNicknames[g.id][state.uid];
        // 刷新当前群消息发送者名与成员列表
        refreshGroupNicknameDisplays(g.id);
        toast(val ? ('群昵称已改为「' + val + '」') : '已清除群昵称');
      })
      .catch(function (e) {
        var msg = (e && e.message) || '';
        // 后端 SQL 未执行时，set_my_group_nickname 不存在，给出明确引导
        if (/set_my_group_nickname|does not exist|PGRST202|function .* does not exist/i.test(msg)) {
          toast('群昵称功能需要先在 Supabase 执行 20260806_group_member_nickname.sql');
          return;
        }
        toast(friendlyError(e));
      })
      .then(function () { btn.disabled = false; btn.textContent = '保存群昵称'; });
  }

  function dissolveGroup() {
    if (!state.active || state.active.type !== 'group') return;
    var g = state.active;
    if (!g.iAmOwner) { toast('只有群主能解散群聊'); return; }
    if (!window.confirm('确定要解散「' + g.name + '」吗？\n该操作不可恢复，所有成员和聊天记录将被删除。')) return;
    sb.rpc('dissolve_group', { p_group_id: g.id })
      .then(function (r) {
        if (r.error) throw r.error;
        hideModal('group-info-modal');
        state.active = null;
        state.chatVisible = false;
        $('chat-room').hidden = true;
        $('chat-empty').hidden = false;
        return loadGroups();
      })
      .then(function () { toast('群聊已解散'); })
      .catch(function (e) { toast(friendlyError(e)); });
  }

  function renderMemberList(g) {
    var list = $('group-member-list');
    list.innerHTML = '';
    $('group-member-count').textContent = g.memberIds.length;
    g.memberIds.forEach(function (uid) {
      if (uid !== state.uid) state.activeSenderIds[uid] = 1;   // 群资料成员称号变化也实时同步
      var p = state.profilesById[uid] || { nickname: '用户', phone: '', avatar_path: '' };
      var disp = groupNicknameOf(g.id, uid) || p.nickname || '用户';
      var li = el('li', 'member-item'); li.dataset.uid = uid;
      var av = el('div', 'avatar sm');
      addOnlineDot(av, uid);
      setAvatar(av, { nickname: disp, phone: p.phone, avatarPath: p.avatar_path });
      applyTitleFrame(av, uid);
      var info = el('div', 'info');
      var tag = (uid === g.ownerId) ? '（群主）' : (uid === state.uid ? '（我）' : '');
      var nm = el('div', 'nm');
      nm.appendChild(el('span', '', disp + tag));
      info.appendChild(nm);
      addTitleBadge(nm, uid);
      var on = isOnline(uid);
      info.appendChild(el('div', 'online-status ' + (on ? 'on' : 'off'), on ? '在线' : '离线'));
      li.appendChild(av); li.appendChild(info);
      if (g.iAmOwner && uid !== g.ownerId) {
        var tr = el('button', 'mini-ok', '转让'); tr.type = 'button';
        tr.onclick = function () { transferOwner(g, uid); };
        li.appendChild(tr);
      }
      if (g.iAmOwner && uid !== g.ownerId && uid !== state.uid) {
        var rm = el('button', 'mini-no', '移除'); rm.type = 'button';
        rm.onclick = function () { removeMember(g, uid); };
        li.appendChild(rm);
      }
      // 群内加好友：非自己、且还不是好友的成员，显示「加好友」
      if (uid !== state.uid && !friendById(uid)) {
        var af = el('button', 'mini-ok', '加好友'); af.type = 'button';
        af.onclick = function (ev) {
          ev.stopPropagation();
          sendRequest({ id: uid }, af);
        };
        li.appendChild(af);
      }
      list.appendChild(li);
    });
  }

  // 仅刷新群成员在线点（不重建列表，避免重设按钮事件）
  function updateMemberOnlineDots(g) {
    if (!g) return;
    var list = $('group-member-list');
    if (!list) return;
    var items = list.querySelectorAll('.member-item');
    for (var i = 0; i < items.length; i++) {
      var li = items[i];
      var uid = li.getAttribute('data-uid');
      if (!uid) continue;
      var av = li.querySelector('.avatar');
      if (av) addOnlineDot(av, uid);
      var st = li.querySelector('.online-status');
      if (st) {
        var on = isOnline(uid);
        st.textContent = on ? '在线' : '离线';
        st.className = 'online-status ' + (on ? 'on' : 'off');
      }
    }
  }

  // 拉取群成员 last_active 并刷新在线点（profiles 全员可读，失败静默降级为全离线）
  function refreshGroupMembersOnline(g) {
    if (!g || !g.memberIds || !g.memberIds.length) return;
    sb.from('profiles').select('id, last_active').in('id', g.memberIds)
      .then(function (r) {
        if (r.error) return;
        (r.data || []).forEach(function (p) { state.lastActive[p.id] = p.last_active; });
        updateMemberOnlineDots(g);
      })
      .catch(function () {});
  }

  function removeMember(g, uid) {
    sb.rpc('remove_group_member', { p_group_id: g.id, p_user_id: uid })
      .then(function (r) { if (r.error) throw r.error; toast('已移除成员'); return loadGroups(); })
      .then(function () {
        var ng = groupById(g.id);
        if (ng) { state.active = ng; renderMemberList(ng); renderGroups(); }
      })
      .catch(function (e) { toast(friendlyError(e)); });
  }

  function transferOwner(g, uid) {
    sb.rpc('transfer_group_owner', { p_group_id: g.id, p_new_owner: uid })
      .then(function (r) {
        if (r.error) throw r.error;
        toast('已转让群主');
        return loadGroups();
      })
      .then(function () {
        var ng = groupById(g.id);
        if (ng) { state.active = ng; openGroupInfo(); }
      })
      .catch(function (e) { toast(friendlyError(e)); });
  }

  function leaveGroup() {
    if (!state.active || state.active.type !== 'group') return;
    var g = state.active;
    if (g.iAmOwner) { toast('你是群主，请先转让群主再退群'); return; }
    sb.rpc('remove_group_member', { p_group_id: g.id, p_user_id: state.uid })
      .then(function (r) { if (r.error) throw r.error; toast('已退出群聊'); hideModal('group-info-modal'); return loadGroups(); })
      .then(function () {
        state.active = null;
        state.chatVisible = false;
        $('chat-room').hidden = true;
        $('chat-empty').hidden = false;
        renderGroups();
      })
      .catch(function (e) { toast(friendlyError(e)); });
  }

  /* ---------- 群聊按钮事件绑定 ---------- */
  $('new-group-btn').addEventListener('click', openNewGroup);
  $('new-group-create').addEventListener('click', createGroup);
  $('new-group-close').addEventListener('click', function () { hideModal('new-group-modal'); });
  $('new-group-cancel').addEventListener('click', function () { hideModal('new-group-modal'); });
  $('new-group-modal').addEventListener('click', function (e) { if (e.target === this) hideModal('new-group-modal'); });

  $('group-info-btn').addEventListener('click', openGroupInfo);
  $('group-info-close').addEventListener('click', function () { hideModal('group-info-modal'); });
  // 注意：#group-info-modal 是 div 不是 <dialog>，没有 close()，必须走 hideModal
  $('group-info-modal').addEventListener('click', function (e) { if (e.target === this) hideModal('group-info-modal'); });
  // 选择群图标：上传到 <uid>/avatars/ 下（沿用个人头像的存储策略），点「保存」才写库
  $('group-avatar-btn').addEventListener('click', function () {
    $('group-avatar-file').click();
  });

  $('group-avatar-clear').addEventListener('click', function () {
    if (!state.active || !state.active.iAmOwner) return;
    pendingGroupAvatar = '';
    setGroupAvatar($('group-info-avatar'), { name: $('group-info-name').value || state.active.name, avatar: null });
    $('group-avatar-clear').hidden = true;
    toast('已恢复默认图标，点「保存」生效');
  });

  $('group-avatar-file').addEventListener('change', function () {
    var file = this.files && this.files[0];
    this.value = '';
    if (!file) return;
    if (!state.active || !state.active.iAmOwner) { toast('只有群主可以修改群图标'); return; }
    if (file.size > 10 * 1024 * 1024) { toast('群图标请小于 10 MB'); return; }

    var ext = (file.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '');
    var rand = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
             : Date.now() + (Math.random() * 1e6 | 0);
    var path = state.uid + '/avatars/' + rand + (ext ? '.' + ext : '');

    var btn = $('group-avatar-btn');
    btn.disabled = true; btn.textContent = '上传中…';
    sb.storage.from(BUCKET).upload(path, file, { contentType: file.type || 'image/png', upsert: true })
      .then(function (r) {
        if (r.error) throw r.error;
        pendingGroupAvatar = path;
        var url = URL.createObjectURL(file);   // 立即本地预览，不等签名地址
        var av = $('group-info-avatar');
        av.textContent = '';
        av.style.background = 'transparent';
        domRemove(av.querySelector('img'));
        var im = new Image();
        im.className = 'avatar-img';
        im.src = url;
        av.appendChild(im);
        $('group-avatar-clear').hidden = false;
        toast('群图标已选择，点「保存」生效');
      })
      .catch(function (e) { toast(friendlyError(e)); })
      .then(function () { btn.disabled = false; btn.textContent = '更换群图标'; });
  });

  $('group-info-save').addEventListener('click', function () {
    if (!state.active || !state.active.iAmOwner) return;
    var name = $('group-info-name').value.trim();
    if (!name) { toast('群名称不能为空'); return; }
    var gid = state.active.id;
    var args = { p_group_id: gid, p_name: name };
    if (pendingGroupAvatar !== null) args.p_avatar_path = pendingGroupAvatar;

    var btn = $('group-info-save');
    btn.disabled = true; btn.textContent = '保存中…';
    sb.rpc('update_group', args)
      .then(function (r) {
        if (r.error) throw r.error;
        return null;
      })
      .catch(function (e) {
        // 后端 SQL 还没执行时（update_group 仍是两参数版本），降级：只改群名并提示
        var msg = (e && e.message) || '';
        if (pendingGroupAvatar !== null &&
            (msg.indexOf('p_avatar_path') !== -1 || msg.indexOf('PGRST202') !== -1 ||
             msg.indexOf('does not exist') !== -1)) {
          return sb.rpc('update_group', { p_group_id: gid, p_name: name })
            .then(function (r2) {
              if (r2.error) throw r2.error;
              toast('群图标需要先在 Supabase 执行 20260804_group_avatar.sql');
              return null;
            });
        }
        throw e;
      })
      .then(function () { return loadGroups(); })
      .then(function () {
        pendingGroupAvatar = null;
        var ng = groupById(gid);
        if (ng) {
          if (state.active && state.active.id === gid) state.active = ng;
          $('peer-name').textContent = ng.name;
          setGroupAvatar($('peer-avatar'), ng);
          openGroupInfo();
        }
        toast('已保存');
      })
      .catch(function (e) { toast(friendlyError(e)); })
      .then(function () { btn.disabled = false; btn.textContent = '保存'; });
  });
  $('group-info-leave').addEventListener('click', leaveGroup);
  $('group-nickname-save').addEventListener('click', saveMyGroupNickname);
  $('group-info-dissolve').addEventListener('click', dissolveGroup);

  $('group-info-add').addEventListener('click', function () {
    if (!state.active) return;
    var g = state.active;
    var candidates = state.friends.filter(function (f) { return g.memberIds.indexOf(f.id) < 0; });
    renderFriendPicker($('add-member-picker'), candidates, []);
    showModal('add-member-modal');
  });
  $('add-member-confirm').addEventListener('click', function () {
    if (!state.active) return;
    var g = state.active;
    var checks = $('add-member-picker').querySelectorAll('input[type=checkbox]:checked');
    if (!checks.length) { toast('请选择要添加的好友'); return; }
    var ids = []; checks.forEach(function (c) { ids.push(c.value); });
    sb.rpc('add_group_members', { p_group_id: g.id, p_user_ids: ids })
      .then(function (r) { if (r.error) throw r.error; toast('已添加成员'); hideModal('add-member-modal'); return loadGroups(); })
      .then(function () {
        var ng = groupById(g.id);
        if (ng) { state.active = ng; renderMemberList(ng); renderGroups(); }
      })
      .catch(function (e) { toast(friendlyError(e)); });
  });
  $('add-member-close').addEventListener('click', function () { hideModal('add-member-modal'); });
  $('add-member-cancel').addEventListener('click', function () { hideModal('add-member-modal'); });
  $('add-member-modal').addEventListener('click', function (e) { if (e.target === this) hideModal('add-member-modal'); });

  /* ---------- 统一搜索：搜好友 + 手机号加好友 ---------- */
  $('search-box').addEventListener('input', onUnifiedSearch);
  // 叉按钮：清空输入框并恢复好友/群列表
  function clearSearch() {
    $('search-box').value = '';
    onUnifiedSearch();           // 内部按空值重置结果并恢复列表
    try { $('search-box').focus(); } catch (e) {}
  }
  var _scEl = $('search-clear');
  if (_scEl) {
    _scEl.addEventListener('click', clearSearch);
    // 移动端 WebView 兜底：click 常有延迟/被吞，用 touchstart 直接触发
    _scEl.addEventListener('touchstart', function (e) {
      e.preventDefault(); clearSearch();
    }, { passive: false });
  }

  function sendRequest(user, btn) {
    if (user.id === state.uid) { toast('不能添加自己为好友'); btn.disabled = false; return; }
    btn.disabled = true;
    // 先看是否已有任一方向的关系记录
    sb.from('friendships').select('id,status,requester_id')
      .or('and(requester_id.eq.' + state.uid + ',addressee_id.eq.' + user.id + '),' +
          'and(requester_id.eq.' + user.id + ',addressee_id.eq.' + state.uid + ')')
      .maybeSingle()
      .then(function (r) {
        if (r.error && r.error.code !== 'PGRST116') throw r.error;
        if (r.data) {
          if (r.data.status === 'pending' && r.data.requester_id === state.uid) {
            toast('申请已发出，等待对方同意');
          } else if (r.data.status === 'pending') {
            toast('对方也申请了你，请到「新的好友」里同意');
          } else if (r.data.status === 'accepted') {
            toast('已经是好友了');
          } else {
            // 之前被拒绝过，重新发起
            return sb.from('friendships')
              .update({ status: 'pending', updated_at: new Date().toISOString() })
              .eq('id', r.data.id)
              .then(function (u) {
                if (u.error) throw u.error;
                toast('好友申请已发送');
              });
          }
          return null;
        }
        return sb.from('friendships')
          .insert({ requester_id: state.uid, addressee_id: user.id, status: 'pending' })
          .then(function (ins) {
            if (ins.error) throw ins.error;
            toast('好友申请已发送');
          });
      })
      .catch(function (e) { toast(friendlyError(e)); })
      .then(function () { btn.disabled = false; });
  }

  /* ============================================================
   *  会话与消息
   * ============================================================ */
  /* 从数据库计算离线 / 跨设备未读：登录与实时重连时调用。
     把各会话未读数（来自 get_my_unread，按已读游标计算）写入 state.unread 并重绘。
     注意：若当前正打开某个聊天，强制跳过该会话，避免 mark 尚未持久化完成时又被刷回红点。 */
  function loadUnreadFromDb() {
    if (!state.uid) return Promise.resolve();
    return sb.rpc('get_my_unread').then(function (r) {
      if (r.error) return;
      var map = {};
      (r.data || []).forEach(function (row) {
        if (row.cnt > 0) map[row.peer_id] = Number(row.cnt);
      });
      // 当前已打开且正在看的会话：不应被 get_my_unread 重新标记为未读
      if (state.active && state.chatVisible && state.active.id) delete map[state.active.id];
      state.unread = map;
      // 红点与“浮顶置前”必须同源校准：弱网下实时推送常丢事件，未读靠本次 DB 重连校准，
      // 若不一并置 convTs，就会出现「只多红点、会话却排在后面」。给有未读的会话打上最新浮顶时间戳，
      // 让它们随红点一起浮到最前（已浮动且时间戳更新的会话不受影响）。
      Object.keys(map).forEach(function (pid) {
        bumpConvTs(pid);
      });
      renderConversations();
    }).catch(function () {});
  }

  function openChat(peer) {
    // 先落库上一个会话可能尚未 debounce 落库的草稿，避免切走后丢失
    flushDraft();
    var isGroup = peer.type === 'group';
    state.active = peer;
    state.activeSenderIds = {};   // 重置称号关心范围，进入新会话后由消息/成员重新填充
    // 恢复“本会话”的草稿到输入框（跨设备 / 退出网页后仍在）
    var dInp = $('msg-input');
    if (dInp) {
      var draftTxt = getDraft(peer.id, isGroup);
      dInp.value = draftTxt || '';
      fitTextarea(dInp);
    }

    if (state.recallTimer) { clearInterval(state.recallTimer); state.recallTimer = null; }
    delete state.unread[peer.id];
    // 把已读游标推到 now()：服务端据此不再把该会话旧消息算作未读，跨设备同步生效。
    // mark 成功后再清一次红点并渲染，保证即使 loadUnreadFromDb 在 mark 完成前跑过，
    // 也能在游标持久化后正确去掉红点。
    setTimeout(function () {
      try {
        sb.rpc('mark_conversation_read', { p_peer: peer.id, p_is_group: isGroup })
          .then(function () {
            delete state.unread[peer.id];
            if (isGroup) renderGroups(); else renderFriends();
          }).catch(function () {});
      } catch (e) {}
    }, 0);
    // 注意：仅“收到消息”或“发送消息”才把会话前置（见下方发送处与实时接收处），
    // 点击打开查看不再触发前置，避免一进对话框就打乱列表顺序。
    if (isGroup) renderGroups(); else renderFriends();

    $('chat-empty').hidden = true;
    $('chat-room').hidden = false;
    state.chatVisible = true;
    document.querySelector('.app-view').classList.add('show-chat');

    $('peer-name').textContent = isGroup ? groupDisplayName(peer) : displayName(peer);
    $('peer-phone').textContent = isGroup ? (peer.memberCount + ' 位成员')
      : peer.phone + (isOnline(peer.id) ? ' · 在线' : '');

    var av = $('peer-avatar');
    if (isGroup) {
      // 清掉上一位好友遗留的称号头像框（boxShadow / 开发者框 / 管理员角标）
      av.style.boxShadow = '';
      av.style.border = '';
      if (av.classList) { av.classList.remove('dev-frame'); av.classList.remove('avatar-admin'); }
      setGroupAvatar(av, peer);
    } else {
      setAvatar(av, { nickname: peer.remark || peer.nickname, phone: peer.phone, avatarPath: peer.avatar });
      addOnlineDot(av, peer.id);
      applyTitleFrame(av, peer.id);
      addTitleBadge($('peer-name'), peer.id);
      // 进入会话时若对方称号尚未加载，主动拉一次并在完成后刷新聊天头，
      // 避免「初次打开聊天头不显示开发者框 / 称号实时同步后聊天头不更新」
      if (!state.titlesMap || !state.titlesMap[peer.id]) {
        reloadTitleFor(peer.id);
      }
    }

    var rb = $('peer-remark-btn');
    if (rb) {
      rb.hidden = false;
      // 群聊：打开群资料弹窗（内含「我的群备注」）；好友：直接编辑备注
      rb.onclick = isGroup ? openGroupInfo : function () { editRemark(peer); };
    }
    var db = $('peer-del-btn');
    if (db) { db.hidden = isGroup; if (!isGroup) db.onclick = function () { deleteFriend(peer); }; }
    var cb = $('peer-clear-btn');
    if (cb) { cb.hidden = isGroup; if (!isGroup) cb.onclick = function () { openClearModal(peer); }; }
    $('group-info-btn').hidden = !isGroup;

    // 举报按钮：聊天页内显示在「备注」左侧，1:1 与群聊均可用
    var rpb = $('peer-report-btn');
    if (rpb) { rpb.hidden = false; rpb.onclick = openReportModal; }

    var box = $('messages');
    box.innerHTML = '';
    state.activeMessages = [];   // 重置当前会话消息缓存，供举报选择器使用
    box.appendChild(el('div', 'day-sep', '加载中…'));

    var query = sb.from('messages')
      .select('*, sender:profiles!messages_sender_id_fkey(id,nickname,avatar_path)');
    if (isGroup) {
      query = query.eq('group_id', peer.id);
      loadGroupMemberProfiles(peer.id);
      // 拉取群内昵称（对全群可见），加载完后刷新当前群消息发送者名
      loadGroupNicknames(peer.id).then(function () { refreshGroupNicknameDisplays(peer.id); });
    } else {
      query = query.or('and(sender_id.eq.' + state.uid + ',receiver_id.eq.' + peer.id + '),' +
                        'and(sender_id.eq.' + peer.id + ',receiver_id.eq.' + state.uid + ')');
    }

    query.order('created_at', { ascending: false }).limit(LIMIT)
      .then(function (r) {
        if (r.error) throw r.error;
        if (!state.active || state.active.id !== peer.id) return;
        box.innerHTML = '';
        var rows = (r.data || []).slice().reverse();
        var lastDay = null;
        rows.forEach(function (m) {
          var node = renderMessage(m);
          if (!node) return; // 本端已删除的消息不渲染，也不生成日期分隔
          var k = dayKey(m.created_at);
          if (k !== lastDay) { box.appendChild(el('div', 'day-sep', dayLabel(m.created_at))); lastDay = k; }
          box.appendChild(node);
        });
        // 若全部消息都已本端删除（如刚清空），给出空态提示，避免一片空白像出错
        if (!box.querySelector('.msg')) {
          box.appendChild(el('div', 'day-sep', EMPTY_TIP));
        }
        // 缓存当前会话消息（供举报选择器筛选「信息/图片/视频」），剔除本端已删除
        state.activeMessages = rows.filter(function (m) {
          return !(m.deleted_by && m.deleted_by.indexOf(state.uid) >= 0);
        });
        // 记录当前会话所有发言者，供「称号实时同步」关心范围使用（群聊成员互相可见对方称号变化）
        rows.forEach(function (m) { if (m.sender_id) state.activeSenderIds[m.sender_id] = 1; });
        scrollBottom();
        // 消息加载完成、titlesMap 已就绪，再次确认聊天头称号（兜底同步段过早渲染的情况）
        var ha = $('peer-avatar'); if (ha) applyTitleFrame(ha, peer.id);
        addTitleBadge($('peer-name'), peer.id);
        // 记录当前会话已渲染消息的最大时间戳，供兜底轮询拉取「差量新消息」
        state.lastSeenTs = rows.reduce(function (mx, x) {
          var t = x.created_at ? new Date(x.created_at).getTime() : 0;
          return t > mx ? t : mx;
        }, 0);
        if (state.recallTimer) clearInterval(state.recallTimer);
        state.recallTimer = setInterval(refreshRecallButtons, 15000);
      })
      .catch(function (e) { toast(friendlyError(e)); });
  }

  $('back-btn').addEventListener('click', function () {
    state.chatVisible = false;
    document.querySelector('.app-view').classList.remove('show-chat');
  });

  // 聊天页点击好友头像 → 打开个人主页（群聊不触发）
  $('peer-avatar').addEventListener('click', function () {
    if (state.active && state.active.type !== 'group') openProfile(state.active);
  });
  $('profile-close').addEventListener('click', function () { hideModal('profile-modal'); });

  // 个人主页：显示昵称、手机号、拥有称号
  function openProfile(peer) {
    var av = $('profile-avatar');
    setAvatar(av, { nickname: peer.remark || peer.nickname, phone: peer.phone, avatarPath: peer.avatar });
    applyTitleFrame(av, peer.id);
    $('profile-name').textContent = displayName(peer);
    $('profile-phone').textContent = peer.phone || '未绑定手机号';

    showModal('profile-modal');

    var box = $('profile-titles');
    box.innerHTML = '<div class="title-loading">加载中…</div>';
    sb.rpc('get_user_titles', { p_user_id: peer.id })
      .then(function (r) {
        if (r.error) throw r.error;
        var rows = r.data || [];
        if (!rows.length) {
          box.innerHTML = '';
          box.appendChild(el('div', 'profile-empty', '暂无称号'));
          return;
        }
        box.innerHTML = '';
        rows.forEach(function (t) {
          var row = el('div', 'profile-title');
          var dot = el('span', 'dot');
          dot.style.background = t.frame_color || '#ffd700';
          row.appendChild(dot);
          var main = el('div', 'pt-main');
          main.appendChild(el('div', 'tn', t.name));
          if (t.description) main.appendChild(el('div', 'td', t.description));
          // 获得时间与来源
          var meta = el('div', 'pt-meta');
          meta.appendChild(el('span', 'pt-time', '获得于 ' + fmtDateTime(t.granted_at)));
          meta.appendChild(el('span', 'src', t.source === 'auto' ? '自动获得' : '授予'));
          main.appendChild(meta);
          row.appendChild(main);
          box.appendChild(row);
        });
      })
      .catch(function () {
        box.innerHTML = '';
        box.appendChild(el('div', 'profile-empty', '称号加载失败'));
      });
  }

  function scrollBottom() {
    var box = $('messages');
    box.scrollTop = box.scrollHeight;
  }

  /* ============================================================
   *  举报（昵称 / 信息 / 视频 / 图片）
   * ============================================================ */
  var REPORT_TYPES = ['nickname', 'message', 'video', 'image'];
  var REPORT_LABEL = { nickname: '昵称', message: '信息', video: '视频', image: '图片' };

  function openReportModal() {
    if (!state.active) return;
    state.reportType = null;
    state.reportTargets = [];
    state.reportUserId = null;
    state.reportUserName = '';
    var chips = document.querySelectorAll('#report-types .report-chip');
    for (var i = 0; i < chips.length; i++) chips[i].classList.remove('active');
    $('report-targets').innerHTML = '<div class="gm-empty">请先选择举报类型</div>';
    $('report-detail').value = '';
    $('report-error').hidden = true;
    // 群聊：显示“按成员筛选”，可单独举报某成员并只显示其消息
    var mf = $('report-member-filter');
    if (state.active.type === 'group') {
      mf.hidden = false;
      $('report-member-search').value = '';
      $('report-member-list').innerHTML = '';
      $('report-member-sel').hidden = true;
      $('report-member-sel-name').textContent = '';
      loadGroupMemberProfiles(state.active.id).then(function () { renderReportMemberSearch(); });
    } else {
      mf.hidden = true;
    }
    showModal('report-modal');
  }

  function reportHasMid(mid) {
    for (var i = 0; i < state.reportTargets.length; i++) {
      if (state.reportTargets[i].msgId === mid) return true;
    }
    return false;
  }
  function reportRemoveMid(mid) {
    var arr = [];
    for (var i = 0; i < state.reportTargets.length; i++) {
      if (state.reportTargets[i].msgId !== mid) arr.push(state.reportTargets[i]);
    }
    state.reportTargets = arr;
  }
  function updateReportTip() {
    var tip = $('report-target-tip');
    if (!tip) return;
    var n = state.reportTargets.length;
    var scope = state.reportUserId ? ('（仅「' + state.reportUserName + '」）') : '';
    if (state.reportType === 'nickname') {
      tip.textContent = '点击「举报」即可提交该昵称/群名举报';
    } else if (n > 0) {
      tip.textContent = '已选择 ' + n + ' 条' + (REPORT_LABEL[state.reportType] || '') + scope + '，可继续勾选多条，点击「举报」一并提交';
    } else {
      tip.textContent = '选择举报类型后，点击下方对应的聊天记录（可多选）' + scope + '：';
    }
  }

  // 根据当前选中的举报类型，列出可举报的聊天记录（信息/视频/图片，支持多选），
  // 或对于昵称直接以对方昵称作为唯一目标（单选）。
  function renderReportTargets() {
    var box = $('report-targets');
    var type = state.reportType;
    box.innerHTML = '';
    state.reportTargets = [];

    if (type === 'nickname') {
      var name;
      if (state.reportUserId) {
        name = state.reportUserName || (state.profilesById[state.reportUserId] && state.profilesById[state.reportUserId].nickname) || '用户';
      } else {
        name = displayName(state.active);
      }
      var item = el('button', 'report-item sel', '「' + (name || '?') + '」的昵称/群名');
      item.type = 'button';
      state.reportTargets = [{ ref: name || '', meta: '', msgId: null, filePath: null }];
      box.appendChild(item);
      updateReportTip();
      return;
    }

    var msgs = (state.activeMessages || []).filter(function (m) {
      if (m.deleted_by && m.deleted_by.indexOf(state.uid) >= 0) return false;
      if (m.sender_id === state.uid) return false; // 不能举报自己发的消息
      if (state.reportUserId && m.sender_id !== state.reportUserId) return false; // 群聊按成员筛选
      if (type === 'message') return m.kind === 'text';
      if (type === 'image')  return m.kind === 'image';
      if (type === 'video')  return m.kind === 'video' || isVideoFile(m);
      return false;
    });
    if (!msgs.length) {
      var emptyTip = state.reportUserId ? ('「' + state.reportUserName + '」') : '当前';
      box.innerHTML = '<div class="gm-empty">' + emptyTip + '聊天中没有可举报的' + (REPORT_LABEL[type] || '') + '</div>';
      updateReportTip();
      return;
    }
    msgs.slice().reverse().forEach(function (m) {
      var isMedia = type === 'image' || type === 'video';
      var preview = m.kind === 'text' ? (m.content || '(空消息)')
                  : (type === 'image' ? '[图片]' : '[视频]') + (m.file_name ? ' ' + m.file_name : '');
      var senderName = state.active.type === 'group'
        ? ((state.profilesById[m.sender_id] && state.profilesById[m.sender_id].nickname) || '成员')
        : (m.sender_id === state.uid ? '我' : '对方');
      var meta = (m.created_at ? fmtTime(m.created_at) : '') + ' · ' + senderName;
      var item = el('button', 'report-item');
      item.type = 'button';

      var info = el('div', 'rt-info');
      info.appendChild(el('div', 'rt-name', preview));
      info.appendChild(el('span', 'rt-meta', meta));

      if (isMedia && m.file_path) {
        var previewWrap = el('div', 'rt-preview');
        var thumb = document.createElement(type === 'video' ? 'video' : 'img');
        if (type === 'video') { thumb.preload = 'metadata'; thumb.playsInline = true; }
        previewWrap.appendChild(thumb);
        previewWrap.onclick = function (e) {
          e.stopPropagation();
          signedUrl(m.file_path).then(function (u) {
            if (!u) { toast('预览地址获取失败'); return; }
            openReportPreview(u, type === 'video');
          });
        };
        item.appendChild(previewWrap);
        signedUrl(m.file_path).then(function (u) { if (u) thumb.src = u; });
      }
      item.appendChild(info);

      if (reportHasMid(m.id)) item.classList.add('sel');
      item.onclick = function () {
        if (reportHasMid(m.id)) {
          reportRemoveMid(m.id);
          item.classList.remove('sel');
        } else {
          state.reportTargets.push({ ref: preview, meta: meta, msgId: m.id, filePath: m.file_path });
          item.classList.add('sel');
        }
        updateReportTip();
      };
      box.appendChild(item);
    });
    updateReportTip();
  }

  // 群聊举报：按成员搜索并选中单一用户，选中后仅显示其发送的消息
  function renderReportMemberSearch() {
    var box = $('report-member-list');
    if (!box) return;
    box.innerHTML = '';
    if (!state.active || state.active.type !== 'group') return;
    var q = ($('report-member-search').value || '').trim().toLowerCase();
    var list = (state.active.memberIds || []).map(function (uid) {
      return { id: uid, p: state.profilesById[uid] || { nickname: '用户', phone: '' } };
    }).filter(function (it) {
      if (it.id === state.uid) return false; // 不能举报自己
      if (!q) return true;
      var n = (it.p.nickname || '').toLowerCase();
      var ph = (it.p.phone || '').toLowerCase();
      return n.indexOf(q) >= 0 || ph.indexOf(q) >= 0;
    });
    if (!list.length) {
      box.appendChild(el('div', 'gm-empty', q ? '未找到匹配成员' : '群暂无成员'));
      return;
    }
    list.forEach(function (it) {
      var item = el('button', 'report-member-item');
      item.type = 'button';
      item.appendChild(el('div', 'rm-name', it.p.nickname || '用户'));
      if (it.p.phone) item.appendChild(el('div', 'rm-ph', it.p.phone));
      item.onclick = function () { selectReportMember(it.id, it.p.nickname || '用户'); };
      box.appendChild(item);
    });
  }

  function selectReportMember(uid, name) {
    state.reportUserId = uid;
    state.reportUserName = name;
    $('report-member-search').value = '';
    $('report-member-list').innerHTML = '';
    $('report-member-sel').hidden = false;
    $('report-member-sel-name').textContent = name;
    state.reportTargets = [];
    renderReportTargets();
  }

  function clearReportMember() {
    state.reportUserId = null;
    state.reportUserName = '';
    $('report-member-sel').hidden = true;
    $('report-member-sel-name').textContent = '';
    $('report-member-search').value = '';
    renderReportMemberSearch();
    state.reportTargets = [];
    renderReportTargets();
  }

  function submitReport() {
    var err = $('report-error');
    if (!state.active) { err.hidden = false; err.textContent = '未进入任何聊天'; return; }
    if (REPORT_TYPES.indexOf(state.reportType) < 0) {
      err.hidden = false; err.textContent = '请选择举报类型'; return;
    }
    if (!state.reportTargets || state.reportTargets.length === 0) {
      err.hidden = false; err.textContent = '请选择要举报的' + (REPORT_LABEL[state.reportType] || '对象'); return;
    }
    // 兜底：禁止举报自己（群聊选中自己、或昵称类型选中自己时拦截）
    if (state.reportUserId && state.reportUserId === state.uid) {
      err.hidden = false; err.textContent = '不能举报自己'; return;
    }
    var isGroup = state.active.type === 'group';
    var reportedId = state.reportUserId || state.active.id;
    var reportedKind = state.reportUserId ? 'user' : (isGroup ? 'group' : 'user');
    var detail = ($('report-detail').value || '').trim();
    var total = state.reportTargets.length;
    var ok = 0, fail = 0, lastErr = '';

    function resetReportModal() {
      state.reportTargets = [];
      var chips = document.querySelectorAll('#report-types .report-chip');
      for (var i = 0; i < chips.length; i++) chips[i].classList.remove('selected');
      var box = $('report-targets');
      if (box) box.innerHTML = '<div class="gm-empty">选择举报类型后，点击下方对应的聊天记录（可多选）</div>';
      var tip = $('report-tip');
      if (tip) tip.textContent = '选择举报类型后，点击下方对应的聊天记录（可多选）：';
      var di = $('report-detail');
      if (di) di.value = '';
    }

    function finishReport() {
      hideModal('report-modal');
      resetReportModal();
      if (fail === 0) {
        toast('举报已提交（' + ok + ' 项），开发者和管理员将会处理');
      } else {
        toast('举报提交完成：成功 ' + ok + ' 项，失败 ' + fail + ' 项' + (lastErr ? '（' + lastErr + '）' : ''));
      }
    }

    // 逐条串行提交：规避 Supabase thenable 不能 Promise.all 的问题
    function doOne(idx) {
      if (idx >= total) { finishReport(); return; }
      var t = state.reportTargets[idx];
      var payload = {
        p_reported_id: reportedId,
        p_reported_kind: reportedKind,
        p_report_type: state.reportType,
        p_target_ref: t.ref + (t.meta ? '  (' + t.meta + ')' : ''),
        p_file_path: t.filePath || null,
        p_detail: detail
      };
      Promise.resolve(sb.rpc('submit_user_report', payload))
        .then(function (r) {
          if (r.error) throw r.error;
          ok++;
          doOne(idx + 1);
        })
        .catch(function (e) {
          fail++;
          var msg = (e && (e.message || '')) || '';
          if (/CANNOT_REPORT_SELF/.test(msg)) { lastErr = '不能举报自己'; }
          else { lastErr = friendlyError(e); }
          doOne(idx + 1);
        });
    }
    doOne(0);
  }

  function appendMessage(m) {
    var box = $('messages');
    // 幂等：同一消息只渲染一次，避免实时推送与兜底轮询重复追加
    if (m && m.id && box.querySelector('[data-id="' + m.id + '"]')) return;
    // 同步进当前会话缓存（供举报选择器使用），去重
    if (m && m.id && state.activeMessages) {
      var dup = false;
      for (var i = 0; i < state.activeMessages.length; i++) {
        if (state.activeMessages[i] && state.activeMessages[i].id === m.id) { dup = true; break; }
      }
      if (!dup) state.activeMessages.push(m);
      if (m.sender_id) state.activeSenderIds[m.sender_id] = 1;
    }
    // 必须先渲染再动 DOM：本端已删除的消息返回 null，
    // 若先把空态提示删掉再 return，聊天区会变成彻底空白（一键清空后最易触发）
    var node = renderMessage(m);
    if (!node) return;
    var near = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    // 移除「还没有消息」空态：它未必是第一个 .day-sep，需遍历全部
    var seps = box.querySelectorAll('.day-sep');
    for (var i = seps.length - 1; i >= 0; i--) {
      if (seps[i].textContent === EMPTY_TIP) domRemove(seps[i]);
    }
    // 清空后追加的第一条消息缺少日期分隔，这里按需补上
    if (m && m.created_at && !box.querySelector('.msg')) {
      box.appendChild(el('div', 'day-sep', dayLabel(m.created_at)));
    }
    box.appendChild(node);
    if (near) scrollBottom();
  }

  // 视频/音频类扩展名，命中后即使消息被存成 file 类型也内联播放，绝不开新网页
  var VIDEO_EXT = ['mp4', 'webm', 'mov', 'm4v', 'ogv', '3gp', 'mkv', 'avi'];

  function isVideoFile(m) {
    if (m.kind === 'video') return true;
    var ext = (m.file_name || '').split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '');
    return VIDEO_EXT.indexOf(ext) >= 0;
  }

  // 统一的内联视频气泡：气泡内直接 <video> 播放；点空白处进 lightbox 全屏播；全程不跳新网页
  function buildVideoBubble(m) {
    var bubble = el('div', 'bubble media');
    var vid = document.createElement('video');
    vid.controls = true;
    vid.preload = 'metadata';
    vid.playsInline = true;
    bubble.appendChild(vid);
    signedUrl(m.file_path).then(function (u) {
      if (!u) return;
      vid.src = u;
      // 点视频控件本身只控制播放，不触发全屏 lightbox
      vid.onclick = function (e) { e.stopPropagation(); };
    });
    // 点气泡空白处 → 全屏内联播放（不开新网页）
    bubble.onclick = function () {
      signedUrl(m.file_path).then(function (u) {
        if (!u) return;
        var lb = $('lightbox');
        var im = $('lightbox-img'), vv = $('lightbox-video');
        im.hidden = true; vv.hidden = false; vv.src = u;
        lb.classList.add('open');
        vv.play().catch(function () {});
      });
    };
    return bubble;
  }

  function renderMessage(m) {
    var out = m.sender_id === state.uid;
    var wrap = el('div', 'msg ' + (out ? 'out' : 'in'));
    wrap.dataset.id = m.id;
    if (out && m.created_at) wrap.dataset.ts = new Date(m.created_at).getTime();

    // 本端已删除（含一键清空）：仅自己可见，直接不渲染（对方无感）
    if (m.deleted_by && m.deleted_by.indexOf(state.uid) >= 0) return null;

    if (m.recalled) {
      wrap.className = 'msg recalled';
      wrap.appendChild(el('div', 'recalled-note',
        out ? '你撤回了一条消息' : '对方撤回了一条消息'));
      return wrap;
    }

    var bubble;
    if (m.kind === 'text') {
      bubble = el('div', 'bubble', m.content || '');
    } else if (m.kind === 'image') {
      bubble = el('div', 'bubble media');
      var img = document.createElement('img');
      img.alt = m.file_name || '图片';
      img.loading = 'lazy';
      bubble.appendChild(img);
      signedUrl(m.file_path).then(function (u) {
        if (!u) return;
        img.src = u;
        img.onclick = function () {
          var lb = $('lightbox');
          var im = $('lightbox-img'), vv = $('lightbox-video');
          vv.hidden = true; im.hidden = false; im.src = u;
          lb.classList.add('open');
        };
      });
    } else if (m.kind === 'video') {
      bubble = buildVideoBubble(m);
    } else {
      // 视频文件即使被存成 file 类型，也内联播放，不开新网页
      if (isVideoFile(m)) {
        bubble = buildVideoBubble(m);
      } else {
        bubble = el('div', 'bubble');
        var a = document.createElement('a');
        a.className = 'file-card';
        a.target = '_blank';
        a.rel = 'noopener';
        var ext = (m.file_name || '').split('.').pop() || 'file';
        a.appendChild(el('div', 'file-icon', ext.slice(0, 4)));
        var meta = el('div', 'file-meta');
        meta.appendChild(el('div', 'file-name', m.file_name || '文件'));
        meta.appendChild(el('div', 'file-size', fmtSize(m.file_size)));
        a.appendChild(meta);
        bubble.appendChild(a);
        signedUrl(m.file_path).then(function (u) { if (u) { a.href = u; a.download = m.file_name || ''; } });
      }
    }

    var isGroup = !!(state.active && state.active.type === 'group');
    if (!out && isGroup) {
      var sName = groupNicknameOf(state.active ? state.active.id : null, m.sender_id) || '成员';
      wrap.classList.add('group-in');
      if (m.sender_id) wrap.dataset.sender = m.sender_id;
      wrap.appendChild(el('div', 'msg-sender', sName));
    }
    wrap.appendChild(bubble);
    wrap.appendChild(el('div', 'msg-time', fmtTime(m.created_at)));

    if (out) {
      var withinRecall = (Date.now() - new Date(m.created_at).getTime()) < 5 * 60 * 1000;
      if (withinRecall) {
        var rb = el('button', 'recall-btn', '撤回');
        rb.type = 'button';
        rb.onclick = function () { recallMessage(m.id); };
        wrap.appendChild(rb);
      } else {
        var db = el('button', 'del-btn', '删除');
        db.type = 'button';
        db.title = '仅自己删除，对方仍可看到';
        db.onclick = function () { deleteMessageForMe(m.id); };
        wrap.appendChild(db);
      }
    } else {
      var db = el('button', 'del-btn', '删除');
      db.type = 'button';
      db.title = '仅自己删除，对方仍可看到';
      db.onclick = function () { deleteMessageForMe(m.id); };
      wrap.appendChild(db);
    }
    return wrap;
  }

  // 每 15s 检查一次：自己发出的消息若已超出 5 分钟撤回窗口，
  // 把仍显示“撤回”的按钮替换为“删除”（本端删除，对方无感）
  function refreshRecallButtons() {
    var box = $('messages');
    Array.prototype.forEach.call(box.querySelectorAll('.msg.out'), function (node) {
      var ts = parseInt(node.dataset.ts || '0', 10);
      if (!ts) return;
      if (Date.now() - ts >= 5 * 60 * 1000) {
        var rb = node.querySelector('.recall-btn');
        if (rb) {
          var id = node.dataset.id;
          var del = el('button', 'del-btn', '删除');
          del.type = 'button';
          del.title = '仅自己删除，对方仍可看到';
          del.onclick = function () { deleteMessageForMe(id); };
          domReplace(rb, del);
        }
      }
    });
  }

  function recallMessage(id) {
    var box = $('messages');
    var old = box.querySelector('[data-id="' + id + '"]');
    sb.from('messages')
      .update({ recalled: true, content: null, file_path: null, file_name: null, file_size: null })
      .eq('id', id)
      .then(function (r) {
        if (r.error) throw r.error;
        domReplace(old, renderMessage({ id: id, sender_id: state.uid, recalled: true }));
      })
      .catch(function (e) { toast(friendlyError(e)); });
  }

  /* ---------- 本端删除（仅自己不可见，对方无感） ---------- */
  function deleteMessageForMe(id) {
    if (!window.confirm('删除后仅自己不可见，对方仍能看到。确定删除吗？')) return;
    var box = $('messages');
    var old = box.querySelector('[data-id="' + id + '"]');
    sb.rpc('delete_message_for_me', { msg_id: id })
      .then(function (r) {
        if (r.error) throw r.error;
        domRemove(old);
        // 删到一条不剩时补回空态，避免聊天区一片空白像出错
        var mbox = $('messages');
        if (mbox && !mbox.querySelector('.msg')) {
          mbox.innerHTML = '';
          mbox.appendChild(el('div', 'day-sep', EMPTY_TIP));
        }
        toast('已删除（仅自己可见）');
      })
      .catch(function (e) { toast(friendlyError(e)); });
  }

  function closeLightbox() {
    var lb = $('lightbox');
    if (lb) { lb.classList.remove('open'); }
    var vv = $('lightbox-video');
    if (vv) { vv.pause(); vv.removeAttribute('src'); vv.load(); }
  }
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t) return;
    var id = t.id;
    if (id === 'lightbox' || id === 'lightbox-img' || id === 'lightbox-video') closeLightbox();
  });

  // 举报预览：打开 lightbox 显示图片 / 视频（已有 lightbox 框，仅做 src 切换）
  function openReportPreview(u, isVid) {
    var lb = $('lightbox');
    var im = $('lightbox-img'), vv = $('lightbox-video');
    if (isVid) { im.hidden = true; vv.hidden = false; vv.src = u; vv.play().catch(function () {}); }
    else { vv.hidden = true; im.hidden = false; im.src = u; }
    lb.classList.add('open');
  }

  function signedUrl(path) {
    if (!path) return Promise.resolve(null);
    if (state.urlCache[path]) return Promise.resolve(state.urlCache[path]);
    return sb.storage.from(BUCKET).createSignedUrl(path, 3600).then(function (r) {
      if (r.error || !r.data) return null;
      state.urlCache[path] = r.data.signedUrl;
      return r.data.signedUrl;
    });
  }

  /* ---------- 禁言相关 ---------- */
  // 将 ISO 时间格式化为「2026年08月02日11时46分」（用于 GM/管理员后台绝对时间展示）
  function formatMuteUntil(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '年' + p(d.getMonth() + 1) + '月' + p(d.getDate()) + '日' +
           p(d.getHours()) + '时' + p(d.getMinutes()) + '分';
  }
  // 把「到期时间」换算成「还剩 x天x时x分」（用于向被禁言用户提示）
  function formatMuteDuration(iso) {
    var ms = new Date(iso).getTime() - Date.now();
    if (isNaN(ms) || ms < 0) ms = 0;
    var totalMin = Math.floor(ms / 60000);
    var d = Math.floor(totalMin / 1440);
    var h = Math.floor((totalMin % 1440) / 60);
    var m = totalMin % 60;
    var parts = [];
    if (d > 0) parts.push(d + '天');
    if (h > 0) parts.push(h + '时');
    if (m > 0 || parts.length === 0) parts.push(m + '分');
    return parts.join('');
  }
  // 把「天/时/分」数字拼成中文时长文本（用于禁言操作后的 toast）
  function muteLenText(d, h, m) {
    var a = [];
    if (d > 0) a.push(d + '天');
    if (h > 0) a.push(h + '时');
    if (m > 0 || a.length === 0) a.push(m + '分');
    return a.join('');
  }
  function mutePrompt(iso) {
    return '你已被禁言，' + formatMuteDuration(iso) + '后自动解除。可在「个人设置 → 禁言申诉」向管理员申诉。';
  }
  // 弹「禁言提示」弹窗（含去申诉入口）
  function showMuteNotice(iso) {
    var t = $('mute-notice-text');
    if (t) t.textContent = mutePrompt(iso);
    showModal('mute-notice-modal');
  }

  async function ensureNotMuted() {
    var until = null;
    try {
      var r = await sb.rpc('get_my_mute');
      if (!r.error) until = r.data || null;
    } catch (e) { /* 查询失败不阻断发送 */ }
    state.mutedUntil = until;
    if (until && new Date(until).getTime() > Date.now()) {
      showMuteNotice(until);
      return false;
    }
    return true;
  }

  /* ---------- 发送频率限制（间隔 1 秒） ---------- */
  var SEND_INTERVAL_MS = 1000;        // 两次发送最小间隔（毫秒）
  var lastSendTs = 0;                 // 上次成功通过发送闸门的时间戳
  // 调用即尝试获取发送资格：通过则更新时间戳并返回 true；未到间隔则轻提示并返回 false。
  // 放在“实际发起发送”之前，仅真实发送才占用间隔（被禁言/违禁词拦截的不占用）。
  function trySendGate() {
    var now = Date.now();
    if (now - lastSendTs < SEND_INTERVAL_MS) {
      var remain = ((SEND_INTERVAL_MS - (now - lastSendTs)) / 1000).toFixed(1);
      toast('发送太频繁，请 ' + remain + ' 秒后再试');
      return false;
    }
    lastSendTs = now;
    return true;
  }

  /* ---------- 发送文字 ---------- */
  var input = $('msg-input');

  input.addEventListener('input', function () {
    fitTextarea(this);
    // 边打字边保存草稿（debounce 落库），退出网页 / 切换设备后仍在
    if (state.active) {
      scheduleSaveDraft(state.active.id, state.active.type === 'group', this.value);
    }
  });

  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && window.innerWidth > 720) {
      e.preventDefault();
      $('composer').requestSubmit();
    }
  });

  $('composer').addEventListener('submit', async function (e) {
    e.preventDefault();
    try {
    var text = input.value.trim();
    if (!text || !state.active) return;
    // 禁言检查（不清空输入，方便解除后重发）
    if (!(await ensureNotMuted())) return;

    var peerId = state.active.id;
    var isGroup = state.active.type === 'group';
    // 发送间隔限制：未到 1 秒直接拦截（不清空输入，方便稍后重发）
    if (!trySendGate()) return;

    // 违禁词检测：命中则拦截发送 + 记录一次警告（清零连续清净天数）
    var badWord = matchForbidden(text);
    if (badWord) {
      // 先给即时反馈（无论后端成败都会显示），后续更具体的提示会覆盖它
      toast('违禁保护系统生效，禁止发送。');
      sb.rpc('record_word_warning', { p_word: badWord, p_content: text, p_peer_id: peerId })
        .then(function (r) {
          var cnt = r && r.data != null ? r.data : null;
          if (cnt != null && cnt > 10) {
            toast('违禁保护系统生效，禁止发送。该账号已累计多次触发违禁词，已上报管理员。');
          }
          // 管理员称号持有者：统计“获得称号之后”的违禁词次数，
          // 超 3 次（第 4 次）自动撤销；每次都提示“再发送 N 次将撤销”
          return sb.rpc('check_admin_title_violation');
        })
        .then(function (r) {
          var d = (r && r.data) || {};
          if (d.revoked) {
            // 称号已被撤销：更新本地状态并即时刷新徽标/头像框
            state.isAdmin = false;
            updateAdminCard();
            toast('你已多次发送违禁词，已上报管理员，管理员称号已被撤销');
            refreshAdminStatus();
            return;
          }
          var c = d.count || 0;
          if (c >= 1 && c <= 3) {
            var remain = 4 - c;  // 第 4 次触发即撤销
            toast('你已发送违禁词 ' + c + ' 次，已上报管理员（再发送 ' + remain + ' 次将撤销称号）');
          }
        })
        .catch(function () {});
      return;   // 拦截：不发送、不清空输入，便于修改后重发
    }

    // 发送前立即 flush 草稿 debounce，避免 600ms 后旧内容被重新落库并回写到输入框
    flushDraft();
    pendingDraft = null;
    if (draftSaveTimer) { clearTimeout(draftSaveTimer); draftSaveTimer = null; }

    input.value = '';   // 确认无违禁词后才清空输入框
    fitTextarea(input); // 重置为单行高度

    var payload = {
      sender_id: state.uid,
      kind: 'text',
      content: text
    };
    if (isGroup) payload.group_id = peerId;
    else payload.receiver_id = peerId;

    var insertSucceeded = false;
    sb.from('messages').insert(payload).select().single()
      .then(function (r) {
        if (r.error) throw r.error;
        insertSucceeded = true;
        appendMessage(r.data);
        notifyPush({ isGroup: isGroup, convId: peerId, preview: text });
        clearDraft(peerId, isGroup);   // 发送成功：清空该会话草稿（本地 + 服务端）
        bumpConvTs(peerId);
        if (isGroup) renderGroups(); else renderFriends();
      })
      .catch(function (err) {
        if (!insertSucceeded) {
          toast('发送失败：' + friendlyError(err));
          input.value = text;
        } else {
          console.error('send post-process error:', err);
          toast('消息已发出，但显示异常，正在刷新会话…');
        }
      });
    } catch (fatal) {
      console.error('send handler fatal:', fatal);
      toast('发送异常：' + (fatal && fatal.message ? fatal.message : friendlyError(fatal)));
    }
  });

  /* ---------- 发送文件 ---------- */
  $('pick-image').onclick = function () { $('file-image').click(); };
  $('pick-video').onclick = function () { $('file-video').click(); };
  $('pick-file').onclick = function () { $('file-any').click(); };

  $('file-image').onchange = function () { handleFile(this, 'image'); };
  $('file-video').onchange = function () { handleFile(this, 'video'); };
  $('file-any').onchange = function () { handleFile(this, 'file'); };

  async function handleFile(inputEl, kind) {
    var file = inputEl.files && inputEl.files[0];
    inputEl.value = '';
    if (!file || !state.active) return;
    // 禁言检查
    if (!(await ensureNotMuted())) return;
    // 发送间隔限制：未到 1 秒直接拦截（不占用上传带宽）
    if (!trySendGate()) return;

    var maxMb = kind === 'image' ? (CFG.MAX_IMAGE_MB || 5)
              : kind === 'video' ? (CFG.MAX_VIDEO_MB || 50)
              : (CFG.MAX_FILE_MB || 20);
    if (file.size > maxMb * 1024 * 1024) {
      toast('文件超过 ' + maxMb + ' MB 上限（当前 ' + fmtSize(file.size) + '）');
      return;
    }

    var bar = $('upload-bar');
    bar.hidden = false;
    $('upload-text').textContent = '上传中… ' + file.name + ' (' + fmtSize(file.size) + ')';

    var ext = (file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '');
    var rand = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
             : Date.now() + '-' + Math.random().toString(36).slice(2);
    var path = state.uid + '/' + rand + (ext ? '.' + ext : '');
    var target = state.active;

    sb.storage.from(BUCKET).upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false })
      .then(function (r) {
        if (r.error) throw r.error;
        var fpayload = {
          sender_id: state.uid,
          kind: kind,
          file_path: path,
          file_name: file.name,
          file_size: file.size
        };
        if (state.active.type === 'group') fpayload.group_id = target.id;
        else fpayload.receiver_id = target.id;
        return sb.from('messages').insert(fpayload).select().single();
      })
      .then(function (r) {
        if (r.error) throw r.error;
        if (state.active && state.active.id === target.id) appendMessage(r.data);
        else toast('已发送');
        notifyPush({ isGroup: !!(state.active && state.active.type === 'group'), convId: target.id, preview: file.name });
        // 发送文件也会把该会话前置（仅收/发才前置，点击查看不前置）
        bumpConvTs(target.id);
        if (target.type === 'group') renderGroups(); else renderFriends();
      })
      .catch(function (e) { toast(friendlyError(e)); })
      .then(function () { bar.hidden = true; });
  }

  /* ============================================================
   *  Web Push（系统通知中心）
   * ============================================================ */
  var VAPID_PUBLIC_KEY = 'BKQZOGfokElG3T0vL2jkelS5x_EucYbInilpJqJnTDMu8H5iHakZnYe1cjWRJiTxzZytMLJvwghmtYPCPbzJ-3o';
  var PUSH_SW_PATH = './sw.js';
  window.__pushEnabled = false;

  function isWebView() {
    var ua = navigator.userAgent || '';
    return /MicroMessenger|QQ\/|Weibo|Alipay|baiduboxapp/i.test(ua);
  }

  function urlBase64ToUint8Array(b64) {
    var pad = '='.repeat((4 - (b64.length % 4)) % 4);
    var s = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    var u = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
    return u;
  }

  function pushSupported() {
    return !isWebView() && 'serviceWorker' in navigator &&
           'PushManager' in window && 'Notification' in window &&
           typeof Notification !== 'undefined';
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return Promise.resolve(false);
    if (isWebView()) { console.log('[push] WebView 不支持，跳过 SW 注册'); return Promise.resolve(false); }
    return navigator.serviceWorker.register(PUSH_SW_PATH)
      .then(function (reg) { console.log('[push] SW 已注册', reg.scope); refreshPushButton(); return true; })
      .catch(function (e) { console.warn('[push] SW 注册失败', e); return false; });
  }

  function getSwRegistration() {
    if (!('serviceWorker' in navigator)) return Promise.resolve(null);
    return navigator.serviceWorker.getRegistration()
      .then(function (reg) { return reg || null; })
      .catch(function () { return null; });
  }

  // 刷新「开启 / 关闭」按钮状态（页面加载或订阅变化后）
  function refreshPushButton() {
    var btn = $('push-toggle-btn'); if (!btn) return;
    var status = $('push-status');
    if (!pushSupported()) {
      btn.disabled = true;
      btn.textContent = '当前浏览器不支持';
      if (status) { status.hidden = false; status.textContent = '请用手机系统浏览器（Chrome / Safari）并“添加到主屏幕”后开启；微信 / QQ 内置浏览器不支持系统通知。'; }
      return;
    }
    getSwRegistration().then(function (reg) {
      if (!reg) { btn.textContent = '开启消息推送'; window.__pushEnabled = false; return; }
      return reg.pushManager.getSubscription().then(function (sub) {
        window.__pushEnabled = !!sub;
        btn.textContent = sub ? '关闭消息推送' : '开启消息推送';
        if (status && sub) { status.hidden = false; status.textContent = '已开启，锁屏或关闭网页也能在通知中心收到新消息。'; }
        else if (status) { status.hidden = true; }
      });
    });
  }

  // 开启推送：请求权限 → 订阅 → 存订阅
  function initPush() {
    if (!pushSupported()) { toast('当前浏览器不支持系统通知（请用手机系统浏览器并添加到主屏幕）'); return; }
    Notification.requestPermission().then(function (perm) {
      if (perm !== 'granted') { toast('需要允许通知权限才能开启推送'); return; }
      getSwRegistration().then(function (reg) {
        if (!reg) { toast('推送服务未就绪，请刷新页面重试'); return; }
        reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
        }).then(function (sub) {
          var j = sub.toJSON();
          return sb.rpc('upsert_push_subscription', { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth })
            .then(function (r) {
              if (r.error) throw r.error;
              window.__pushEnabled = true;
              refreshPushButton();
              toast('消息推送已开启');
            });
        }).catch(function (e) {
          toast('开启失败：' + friendlyError(e));
        });
      });
    });
  }

  // 关闭推送：取当前订阅 → 退订
  function disablePush() {
    getSwRegistration().then(function (reg) {
      if (!reg) { refreshPushButton(); return; }
      reg.pushManager.getSubscription().then(function (sub) {
        if (!sub) { refreshPushButton(); return; }
        var endpoint = sub.endpoint;
        sub.unsubscribe().catch(function () {});
        sb.rpc('delete_push_subscription', { p_endpoint: endpoint })
          .then(function () { window.__pushEnabled = false; refreshPushButton(); toast('已关闭消息推送'); })
          .catch(function (e) { toast('关闭失败：' + friendlyError(e)); });
      });
    });
  }

  // 发送消息成功后调用：向接收者推送系统通知（仅本端已开启推送时）
  function notifyPush(opts) {
    if (!window.__pushEnabled || isWebView()) return;
    var receivers = [];
    if (opts.isGroup) {
      var g = groupById(opts.convId);
      if (g && g.memberIds) receivers = g.memberIds.filter(function (id) { return id !== state.uid; });
    } else {
      receivers = [opts.convId];
    }
    if (!receivers.length) return;
    sb.functions.invoke('notify-push', {
      body: {
        receiver_ids: receivers,
        sender_id: state.uid,
        sender_name: (state.profile && state.profile.nickname) || '有人',
        preview: (opts.preview || '').toString().slice(0, 200),
        url: './'
      }
    }).catch(function () {});
  }

  /* ============================================================
   *  实时推送
   * ============================================================ */
  function subscribeRealtime() {
    if (state.channel) sb.removeChannel(state.channel);

    // 网络恢复时自动重连实时通道（特殊设备 WebSocket 易在断网/锁屏后掉线）
    if (!state._rtOnlineBound) {
      state._rtOnlineBound = true;
      window.addEventListener('online', function () {
        if (state.uid) subscribeRealtime();
      });
    }

    state.channel = sb.channel('chat-' + state.uid)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'messages'
      }, function (payload) {
        var box = $('messages');

        // 历史消息被违禁词全局隐藏（hidden_forbidden=true）后，RLS 会转为 DELETE 事件；
        // 群解散 / 账号删除级联删除消息也会触发 DELETE。统一从 DOM 移除节点。
        if (payload.eventType === 'DELETE') {
          var oldId = payload.old && payload.old.id;
          if (oldId) {
            var delNode = box.querySelector('[data-id="' + oldId + '"]');
            if (delNode) domRemove(delNode);
          }
          return;
        }

        var m = payload.new;
        if (!m) return;

        // 被违禁词全局隐藏的历史消息：若 UPDATE 事件仍被推送，直接移除 DOM 节点
        if (m.hidden_forbidden) {
          var hiddenNode = box.querySelector('[data-id="' + m.id + '"]');
          if (hiddenNode) domRemove(hiddenNode);
          return;
        }

        var existing = box.querySelector('[data-id="' + m.id + '"]');

        // 只有 INSERT 才是「真·新消息」。UPDATE 代表历史消息的状态变更
        // （对方撤回、本端删除、一键清空写 deleted_by）——一键清空会对 N 条消息
        // 逐条 UPDATE，若当成新消息处理就会弹 N 次“发来一条消息”并把未读刷爆。
        var isNew = payload.eventType === 'INSERT';

        // 自己发出的消息：本地已处理，这里只同步「更新」（撤回 / 本端删除）的回显，避免重复追加
        if (m.sender_id === state.uid) {
          if (existing) domReplace(existing, renderMessage(m));
          return;
        }

        // 他人消息：若已显示则原地更新（对方撤回、或我本端删除的回显）
        if (existing) {
          domReplace(existing, renderMessage(m));
          return;
        }

        // 页面上没有该消息、且并非新插入 → 是历史消息的状态变更（典型：我刚一键清空）。
        // 这类事件绝不能计未读、绝不能弹提示，直接忽略。
        if (!isNew) return;

        // 已被我本端删除的消息（清空后对方补发的同步事件等）同样不产生任何提示
        if (m.deleted_by && m.deleted_by.indexOf(state.uid) >= 0) return;

        if (m.group_id) {
          if (state.chatVisible && state.active && state.active.type === 'group' && state.active.id === m.group_id) {
            appendMessage(m);
          } else {
            state.unread[m.group_id] = (state.unread[m.group_id] || 0) + 1;
            bumpConvTs(m.group_id);
            renderGroups();
            var g = groupById(m.group_id);
            if (g) toast(g.name + ' 发来一条消息');
          }
        } else if (m.receiver_id === state.uid) {
          if (state.chatVisible && state.active && state.active.type !== 'group' && state.active.id === m.sender_id) {
            appendMessage(m);
          } else {
            state.unread[m.sender_id] = (state.unread[m.sender_id] || 0) + 1;
            bumpConvTs(m.sender_id);
            renderFriends();
            var from = friendById(m.sender_id);
            if (from) toast(from.nickname + ' 发来一条消息');
          }
        }
      })
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'friendships'
      }, function () { loadRelations(); })
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'groups'
      }, function () { loadGroups(); })
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'group_members'
      }, function () { loadGroups(); })
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'profiles'
      }, function (payload) {
        var nr = payload.new;
        if (!nr || !nr.id) return;
        var uid = nr.id;
        // 只关心：自己 / 好友 / 当前会话对手
        var care = (uid === state.uid);
        if (!care && state.friends) {
          for (var fi = 0; fi < state.friends.length; fi++) {
            if (state.friends[fi].id === uid) { care = true; break; }
          }
        }
        if (!care && state.active && state.active.type === 'friend' && state.active.id === uid) care = true;
        // 群聊 / 群资料里出现过的成员：其称号（含隐藏开关）变化也要实时同步给其他用户
        if (!care && state.activeSenderIds && state.activeSenderIds[uid]) care = true;
        if (!care) return;
        // 仅当称号相关列或 hide_dev_title 发生变化才刷新（last_seen 等心跳直接忽略）
        var nsig = [nr.display_title_id, nr.display_title_id2, nr.admin_title_id, nr.dev_title_id, nr.hide_dev_title]
          .map(function (x) { return x == null ? null : x; }).join('|');
        if (state.profileTitleSig && state.profileTitleSig[uid] === nsig) return;
        if (!state.profileTitleSig) state.profileTitleSig = {};
        state.profileTitleSig[uid] = nsig;
        // 节流：同一用户 400ms 内只刷新一次，避免高频 UPDATE 反复拉取
        if (!state.titleReloadTimer) state.titleReloadTimer = {};
        if (state.titleReloadTimer[uid]) return;
        state.titleReloadTimer[uid] = setTimeout(function () {
          state.titleReloadTimer[uid] = null;
          reloadTitleFor(uid);
        }, 400);
      })
      // 群昵称变更（自己或群内其他成员）：实时更新缓存并刷新显示
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'group_member_nicknames'
      }, function (payload) {
        var row = (payload.new && payload.new.group_id) ? payload.new : payload.old;
        if (!row || !row.group_id || !row.user_id) return;
        var gid = row.group_id, uid = row.user_id;
        if (!state.groupNicknames[gid]) state.groupNicknames[gid] = {};
        if (payload.eventType === 'DELETE') delete state.groupNicknames[gid][uid];
        else state.groupNicknames[gid][uid] = (row.nickname != null) ? row.nickname : '';
        refreshGroupNicknameDisplays(gid);
      })
      // 聊天草稿变更（本人其他设备保存/清空）：实时同步缓存与输入框
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'message_drafts'
      }, function (payload) {
        var row = (payload.new && payload.new.user_id) ? payload.new : payload.old;
        applyRemoteDraft(row, payload.eventType === 'DELETE');
      })
      // 管理后台四大板块：违禁词 / 用户举报 / 违规周报 / 禁言申诉
      // 仅管理员/开发者需要实时提示；四张表的 RLS 均已开放管理员可读，否则 realtime 不会推送
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'word_warnings'
      }, onAdminFeedInsert)
      .on('postgres_changes', {
        event: 'DELETE', schema: 'public', table: 'word_warnings'
      }, onWordLogDelete)
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'user_reports'
      }, onAdminFeedInsert)
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'forbidden_reports'
      }, onAdminFeedInsert)
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'mute_appeals'
      }, onAdminFeedInsert)
      .subscribe(function (status) {
        // 实时通道（重）连上后，用 DB 已读游标重新校准未读，避免离线期间漏算
        if (status === 'SUBSCRIBED') { loadUnreadFromDb(); return; }
        // 断线/超时时自动重连，避免实时推送永久失效
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          setTimeout(function () { if (state.uid) subscribeRealtime(); }, 1500);
        }
      });
  }

  /* 实时推送兜底：特殊设备 WebSocket 易断线，定时拉取当前会话的新消息差量，
     保证「发新消息不用刷新也能看到」。appendMessage 内部已按 data-id 去重。 */
  function fillNewMessages() {
    if (!state.active || !state.uid) return;
    var peer = state.active;
    var isGroup = peer.type === 'group';
    var q = sb.from('messages').select('*');
    if (isGroup) q = q.eq('group_id', peer.id);
    else q = q.or('and(sender_id.eq.' + state.uid + ',receiver_id.eq.' + peer.id + '),' +
                      'and(sender_id.eq.' + peer.id + ',receiver_id.eq.' + state.uid + ')');
    if (state.lastSeenTs) q = q.gt('created_at', new Date(state.lastSeenTs).toISOString());
    q.order('created_at', { ascending: true }).limit(50)
      .then(function (r) {
        if (r.error) return;
        if (!state.active || state.active.id !== peer.id) return;
        (r.data || []).forEach(function (m) {
          appendMessage(m);
          var t = m.created_at ? new Date(m.created_at).getTime() : 0;
          if (t > (state.lastSeenTs || 0)) state.lastSeenTs = t;
        });
      })
      .catch(function () {});
  }

  function startPoll() {
    if (state.pollTimer) return;
    state.pollTimer = setInterval(function () {
      if (!state.uid || !state.active) return;
      fillNewMessages();
    }, 4000);
  }
  function stopPoll() {
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  }

  /* 页面重新可见时补拉一次，避免长时间挂起丢消息 */
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && state.uid) {
      loadRelations();
      // 群资料（群名 / 群图标 / 成员数）由群主单方修改，这里补拉一次让其他成员同步到
      loadGroups().catch(function () {});
      if (state.active) openChat(state.active);
      loadDisplayTitles().catch(function () {});   // 重新可见时重拉可见用户称号，兜底实时推送丢失
      fillNewMessages();
      // 管理后台四大板块未读数：锁屏/切后台期间 WebSocket 常已断开，回前台立刻补一次
      if (state.isAdmin) loadAllUnread();
      // GM 看板回前台立即静默刷新当前 tab
      if (state.gmPanelOpen) refreshGmCurrentTab(true);
    }
  });

  // 页面切到后台 / 关闭前，立即把未落库的草稿保存（退出网页后草稿不丢）
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) flushDraft();
  });
  window.addEventListener('beforeunload', function () { flushDraft(); });
})();
